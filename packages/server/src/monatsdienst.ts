import {
  monatsGrenzen,
  type BelegDatei,
  type Monat,
  type MonatsStatus,
  type Position,
  type PositionsPatch,
} from '@abrechnung/shared';
import { parseAktenzeichen } from './aktenzeichen/index.js';
import { EingabeFehler, NichtGefunden } from './fehler.js';
import type { Datenbank } from './db/index.js';
import type { RechnungsProvider } from './invoices/provider.js';
import type { SevDeskClient } from './sevdesk/client.js';
import type { CheckAccount } from './sevdesk/types.js';
import {
  aktualisiereStatus,
  baueBelege,
  baueTransaktionsIndex,
  berechneSummen,
} from './sevdesk/verknuepfer.js';
import type { Dateiablage } from './storage/dateien.js';

/**
 * Zahlungen laufen den Belegen hinterher. Um die Verknuepfung zu finden,
 * werden Belege und Rechnungen aus einem groesseren Fenster geladen als der
 * abzurechnende Monat selbst.
 */
const PUFFER_TAGE_RUECKWAERTS = 120;
const PUFFER_TAGE_VORWAERTS = 30;

export interface MonatsDienstAbhaengigkeiten {
  sevdesk: SevDeskClient;
  rechnungen: RechnungsProvider;
  db: Datenbank;
  ablage: Dateiablage;
  checkAccount: CheckAccount;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export class MonatsDienst {
  constructor(private readonly deps: MonatsDienstAbhaengigkeiten) {}

  /**
   * Liefert den Monat. Ohne `neuLaden` kommt er aus dem Cache, sofern vorhanden -
   * ein Seitenwechsel in der UI loest also keinen sevDesk-Abruf aus.
   */
  async lade(monat: string, neuLaden = false): Promise<Monat> {
    if (!neuLaden) {
      const zwischengespeichert = this.deps.db.ladeMonat(monat);
      if (zwischengespeichert) {
        return this.veredele(monat, zwischengespeichert.positionen, zwischengespeichert);
      }
    }
    return this.synchronisiere(monat);
  }

  /** Holt den Monat frisch aus sevDesk und laedt fehlende Belege nach. */
  async synchronisiere(monat: string): Promise<Monat> {
    const { von, bis } = monatsGrenzen(monat);
    const { sevdesk, checkAccount, log } = this.deps;

    log?.info({ monat, von, bis }, 'Synchronisiere Monat aus sevDesk');

    const belegVon = verschiebeTage(von, -PUFFER_TAGE_RUECKWAERTS);
    const belegBis = verschiebeTage(bis, PUFFER_TAGE_VORWAERTS);

    const [transaktionen, vouchers, invoices] = await Promise.all([
      sevdesk.holeTransaktionen(checkAccount.id, von, bis),
      sevdesk.holeVouchers(belegVon, belegBis),
      sevdesk.holeInvoices(belegVon, belegBis),
    ]);

    // Rueckwaerts-Indizes: sevDesk kennt nur Beleg -> Buchungen.
    const [voucherProTransaktion, invoiceProTransaktion] = await Promise.all([
      baueTransaktionsIndex(vouchers.map((v) => v.id), (id) =>
        sevdesk.holeVoucherTransaktionen(id),
      ),
      baueTransaktionsIndex(invoices.map((i) => i.id), (id) =>
        sevdesk.holeInvoiceTransaktionen(id),
      ),
    ]);

    let positionen = baueBelege({
      transaktionen,
      vouchers,
      invoices,
      voucherProTransaktion,
      invoiceProTransaktion,
    });

    positionen = await this.ladeDateien(monat, positionen);

    return this.veredele(monat, positionen);
  }

  /** Laedt fuer jede Position die zugehoerigen Dateien und legt sie ab. */
  private async ladeDateien(monat: string, positionen: Position[]): Promise<Position[]> {
    const { sevdesk, rechnungen, ablage, log } = this.deps;

    return nacheinanderBegrenzt(positionen, 4, async (position) => {
      try {
        if (position.typ === 'AUSGANG' && position.voucherId) {
          const datei = await sevdesk.holeVoucherDatei(position.voucherId);
          if (!datei) {
            return { ...position, hinweis: 'Beleg in sevDesk ohne angehaengte Datei' };
          }
          const abgelegt = await ablage.speichere(
            monat,
            datei.daten,
            datei.dateiname,
            'sevdesk-voucher',
            datei.mimeType,
          );
          return { ...position, dateien: [abgelegt], hinweis: undefined };
        }

        if (position.typ === 'EINGANG' && position.aktenzeichen) {
          const ergebnis = await rechnungen.holeRechnung(
            position.aktenzeichen,
            position.invoiceId,
          );

          if (ergebnis.treffer.length === 0) {
            return {
              ...position,
              hinweis:
                ergebnis.fehler ??
                `Keine Rechnung gefunden. Geprueft: ${ergebnis.versucht.join(', ')}`,
            };
          }

          const abgelegt: BelegDatei[] = [];
          for (const treffer of ergebnis.treffer) {
            abgelegt.push(
              await ablage.speichere(
                monat,
                treffer.daten,
                treffer.dateiname,
                treffer.quelle,
                treffer.mimeType,
              ),
            );
          }

          // Mehrere Treffer heisst: der Nutzer muss entscheiden. Der erste
          // wird vorgeschlagen, der Rest wandert in die Kandidatenliste.
          if (abgelegt.length > 1) {
            return {
              ...position,
              dateien: [abgelegt[0]!],
              kandidaten: abgelegt.slice(1),
              hinweis: `${abgelegt.length} moegliche Rechnungsdateien gefunden - bitte pruefen`,
            };
          }

          return { ...position, dateien: abgelegt, hinweis: undefined };
        }

        return position;
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        log?.warn({ positionId: position.id, err: meldung }, 'Belegabruf fehlgeschlagen');
        return { ...position, hinweis: `Abruf fehlgeschlagen: ${meldung}` };
      }
    });
  }

  /**
   * Legt manuelle Korrekturen ueber die Rohpositionen, setzt Status und Summen.
   *
   * Wichtig: im Cache landen die ROHDATEN aus sevDesk, zurueckgegeben wird die
   * zusammengefuehrte Ansicht. Wuerde die zusammengefuehrte Fassung gespeichert,
   * waere sie beim naechsten Patch die neue Basis - eine einmal gesetzte
   * Korrektur liesse sich dann nie wieder zurueecknehmen, weil der sevDesk-Stand
   * verloren waere.
   */
  private veredele(monat: string, rohPositionen: Position[], basis?: Monat): Monat {
    const overrides = this.deps.db.ladeOverrides(monat);

    const roh: Monat = {
      monat,
      checkAccountId: this.deps.checkAccount.id,
      checkAccountName: this.deps.checkAccount.name,
      positionen: rohPositionen,
      summen: berechneSummen(rohPositionen),
      verwaisteBelege: basis?.verwaisteBelege ?? [],
      kontoauszuege: this.deps.db.ladeKontoauszuege(monat),
      synchronisiertAm: basis?.synchronisiertAm ?? new Date().toISOString(),
    };
    this.deps.db.speichereMonat(roh);

    const zusammengefuehrt = rohPositionen.map((p) => {
      const patch = overrides.get(p.id);
      if (!patch) return aktualisiereStatus(p);
      // Nur ein ausdruecklich gesetzter Status haelt die Neuberechnung an.
      return aktualisiereStatus(
        { ...p, ...patch, manuellBestaetigt: true },
        patch.status !== undefined,
      );
    });

    return {
      ...roh,
      positionen: zusammengefuehrt,
      summen: berechneSummen(zusammengefuehrt),
    };
  }

  /** Uebernimmt eine manuelle Korrektur an einer Position. */
  async patcheposition(
    monat: string,
    positionId: string,
    patch: PositionsPatch,
  ): Promise<Monat> {
    const aktuell = this.deps.db.ladeMonat(monat);
    if (!aktuell) {
      throw new NichtGefunden(
        `Monat ${monat} ist noch nicht geladen. Zuerst aus sevDesk laden.`,
      );
    }

    const position = aktuell.positionen.find((p) => p.id === positionId);
    if (!position) {
      throw new NichtGefunden(`Buchung ${positionId} existiert nicht in ${monat}.`);
    }

    const teil: Partial<Position> = {};

    if (patch.aktenzeichen !== undefined) {
      if (patch.aktenzeichen === null) {
        teil.aktenzeichen = undefined;
      } else {
        const az = parseAktenzeichen(patch.aktenzeichen, 'manuell');
        if (!az) {
          throw new EingabeFehler(
            `"${patch.aktenzeichen}" entspricht nicht dem Format MMYY/NummerTGXX ` +
              '(Beispiel: 0626/1811TG01).',
          );
        }
        teil.aktenzeichen = az;
      }
      // Ein manuell gesetztes Aktenzeichen beendet die Mehrdeutigkeit.
      teil.aktenzeichenKandidaten = undefined;
    }

    if (patch.status !== undefined) teil.status = patch.status;
    if (patch.hinweis !== undefined) teil.hinweis = patch.hinweis ?? undefined;

    // Auswahl aus den Kandidaten: gewaehlte Dateien werden zu den zugeordneten,
    // der Rest bleibt als Kandidat erhalten.
    if (patch.dateiIds) {
      const alle = [...position.dateien, ...(position.kandidaten ?? [])];
      const gewaehlt = alle.filter((d) => patch.dateiIds!.includes(d.id));
      teil.dateien = gewaehlt;
      teil.kandidaten = alle.filter((d) => !patch.dateiIds!.includes(d.id));
      teil.auswahlBestaetigt = true;
    }

    this.deps.db.speichereOverride(monat, positionId, teil);
    return this.veredele(monat, aktuell.positionen);
  }

  /**
   * Kompakter Zustand eines Monats, ohne ihn aus sevDesk nachzuladen.
   *
   * Dient dem Ueberblick, welche Monate noch offen sind - typischerweise weil
   * Buchungen in sevDesk noch nicht zugeordnet waren, als zuletzt geladen wurde.
   */
  status(monat: string): MonatsStatus {
    const zwischengespeichert = this.deps.db.ladeMonat(monat);
    const kontoauszuege = this.deps.db.ladeKontoauszuege(monat).length;

    if (!zwischengespeichert) {
      return {
        monat,
        geladen: false,
        abgeschlossen: false,
        anzahlKontoauszuege: kontoauszuege,
      };
    }

    // Fuer den Status zaehlt die zusammengefuehrte Sicht - eine manuell
    // geschlossene Position darf den Monat nicht offen halten.
    const overrides = this.deps.db.ladeOverrides(monat);
    const zusammengefuehrt = zwischengespeichert.positionen.map((p) => {
      const patch = overrides.get(p.id);
      if (!patch) return aktualisiereStatus(p);
      return aktualisiereStatus(
        { ...p, ...patch, manuellBestaetigt: true },
        patch.status !== undefined,
      );
    });

    const summen = berechneSummen(zusammengefuehrt);

    return {
      monat,
      geladen: true,
      synchronisiertAm: zwischengespeichert.synchronisiertAm,
      summen,
      abgeschlossen:
        summen.anzahlOffen === 0 &&
        summen.anzahlMehrdeutig === 0 &&
        summen.anzahlNichtZugeordnet === 0,
      anzahlKontoauszuege: kontoauszuege,
    };
  }

  /** Nimmt eine manuelle Korrektur zurueck und stellt den sevDesk-Stand her. */
  async setzePositionZurueck(monat: string, positionId: string): Promise<Monat> {
    this.deps.db.loescheOverride(monat, positionId);
    const aktuell = this.deps.db.ladeMonat(monat);
    if (!aktuell) {
      throw new NichtGefunden(`Monat ${monat} ist noch nicht geladen.`);
    }
    return this.veredele(monat, aktuell.positionen);
  }
}

// ---------------------------------------------------------------------------

function verschiebeTage(isoDatum: string, tage: number): string {
  const d = new Date(`${isoDatum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

/**
 * Fuehrt `arbeit` fuer alle Elemente aus, aber hoechstens `parallel` gleichzeitig.
 * Schont die sevDesk-Ratelimits und haelt die Reihenfolge des Ergebnisses.
 */
async function nacheinanderBegrenzt<T, R>(
  elemente: T[],
  parallel: number,
  arbeit: (element: T) => Promise<R>,
): Promise<R[]> {
  const ergebnis = new Array<R>(elemente.length);
  let naechster = 0;

  const arbeiter = Array.from(
    { length: Math.min(parallel, elemente.length) },
    async () => {
      for (;;) {
        const i = naechster++;
        if (i >= elemente.length) return;
        ergebnis[i] = await arbeit(elemente[i]!);
      }
    },
  );

  await Promise.all(arbeiter);
  return ergebnis;
}
