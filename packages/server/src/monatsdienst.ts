import {
  ABLAGEORDNER,
  istAblageordner,
  monatsGrenzen,
  type BelegDatei,
  type LadeFortschritt,
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

/**
 * Nimmt Zwischenstaende des Ladevorgangs entgegen.
 *
 * Ohne Beobachter verhaelt sich alles wie vorher; mit Beobachter kann die
 * Oberflaeche waehrend des Abrufs schon etwas zeigen, statt minutenlang auf
 * eine einzige Antwort zu warten.
 */
export interface LadeBeobachter {
  fortschritt(f: LadeFortschritt): void;
  /** Buchungen stehen, Belege fehlen noch - reicht fuer die Tabelle. */
  zwischenstand?(monat: Monat): void;
}

export class MonatsDienst {
  constructor(private readonly deps: MonatsDienstAbhaengigkeiten) {}

  /**
   * Liefert den Monat. Ohne `neuLaden` kommt er aus dem Cache, sofern vorhanden -
   * ein Seitenwechsel in der UI loest also keinen sevDesk-Abruf aus.
   */
  async lade(
    monat: string,
    neuLaden = false,
    beobachter?: LadeBeobachter,
  ): Promise<Monat> {
    if (!neuLaden) {
      const zwischengespeichert = await this.deps.db.ladeMonat(monat);
      if (zwischengespeichert) {
        const positionen = await this.stelleDateienSicher(
          monat,
          zwischengespeichert.positionen,
          beobachter,
        );
        return await this.veredele(monat, positionen, zwischengespeichert);
      }
    }
    return this.synchronisiere(monat, beobachter);
  }

  /**
   * Prueft, ob die im Zwischenspeicher vermerkten Belegdateien noch auf der
   * Platte liegen, und holt fehlende neu.
   *
   * Datenbank und Dateien koennen auseinanderlaufen - etwa wenn das
   * Datenverzeichnis nicht dauerhaft eingebunden ist und ein neuer Container
   * mit leerem Verzeichnis startet. Ohne diese Pruefung zeigt die Oberflaeche
   * dann dauerhaft einen Beleg an, den es nicht mehr gibt.
   */
  private async stelleDateienSicher(
    monat: string,
    positionen: Position[],
    beobachter?: LadeBeobachter,
  ): Promise<Position[]> {
    const { ablage, log } = this.deps;

    const luecken: number[] = [];
    for (const [i, position] of positionen.entries()) {
      const alle = [...position.dateien, ...(position.kandidaten ?? [])];
      for (const datei of alle) {
        // Fehlt oder ist unbrauchbar - beides heisst: neu holen. Unbrauchbar
        // waren Belege, die sevDesk als base64-Text statt als PDF lieferte.
        const brauchbar =
          (await ablage.existiert(monat, datei.id)) &&
          (await ablage.istUnversehrt(monat, datei));
        if (!brauchbar) {
          luecken.push(i);
          break;
        }
      }
    }

    if (luecken.length === 0) return positionen;

    log?.warn(
      { monat, anzahl: luecken.length },
      'Belegdateien fehlen oder sind unbrauchbar - sie werden neu geholt',
    );

    const ergebnis = [...positionen];
    let fertig = 0;
    beobachter?.fortschritt({
      phase: 'dateien',
      text: 'Fehlende Belegdateien werden neu geholt',
      erledigt: 0,
      gesamt: luecken.length,
    });

    await nacheinanderBegrenzt(luecken, 4, async (i) => {
      const position = positionen[i]!;
      // Ohne die alten Verweise, sonst blieben die toten Eintraege stehen.
      const leer: Position = { ...position, dateien: [], kandidaten: undefined };

      try {
        const neu = await this.ladeDateiFuer(monat, leer);
        ergebnis[i] =
          neu.dateien.length > 0
            ? neu
            : {
                ...leer,
                hinweis:
                  neu.hinweis ??
                  'Beleg war im Zwischenspeicher vermerkt, liegt aber nicht mehr vor.',
              };
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        log?.warn({ positionId: position.id, err: meldung }, 'Nachladen fehlgeschlagen');
        ergebnis[i] = { ...leer, hinweis: `Beleg nicht mehr vorhanden: ${meldung}` };
      } finally {
        fertig++;
        beobachter?.fortschritt({
          phase: 'dateien',
          text: 'Fehlende Belegdateien werden neu geholt',
          erledigt: fertig,
          gesamt: luecken.length,
        });
      }
    });

    return ergebnis;
  }

  /** Holt den Monat frisch aus sevDesk und laedt fehlende Belege nach. */
  async synchronisiere(monat: string, beobachter?: LadeBeobachter): Promise<Monat> {
    const { von, bis } = monatsGrenzen(monat);
    const { sevdesk, checkAccount, log } = this.deps;

    log?.info({ monat, von, bis }, 'Synchronisiere Monat aus sevDesk');

    const belegVon = verschiebeTage(von, -PUFFER_TAGE_RUECKWAERTS);
    const belegBis = verschiebeTage(bis, PUFFER_TAGE_VORWAERTS);

    beobachter?.fortschritt({
      phase: 'transaktionen',
      text: `Bankbuchungen von ${checkAccount.name ?? checkAccount.id} werden geholt`,
    });

    const [transaktionen, vouchers, invoices] = await Promise.all([
      sevdesk.holeTransaktionen(checkAccount.id, von, bis),
      sevdesk.holeVouchers(belegVon, belegBis),
      sevdesk.holeInvoices(belegVon, belegBis),
    ]);

    beobachter?.fortschritt({
      phase: 'transaktionen',
      text: `${transaktionen.length} Buchungen im Monat`,
      erledigt: transaktionen.length,
      gesamt: transaktionen.length,
    });
    beobachter?.fortschritt({
      phase: 'belege',
      text: `${vouchers.length} Belege und ${invoices.length} Ausgangsrechnungen im Umfeld`,
      erledigt: vouchers.length + invoices.length,
      gesamt: vouchers.length + invoices.length,
    });
    beobachter?.fortschritt({
      phase: 'verknuepfung',
      text: 'Buchungen werden ihren Belegen zugeordnet',
      gesamt: vouchers.length + invoices.length,
      erledigt: 0,
    });

    // Rueckwaerts-Indizes: sevDesk kennt nur Beleg -> Buchungen.
    let verknuepft = 0;
    const gesamtVerknuepfungen = vouchers.length + invoices.length;
    const zaehleVerknuepfung = () => {
      verknuepft++;
      // Nicht jede einzelne Anfrage melden - das waere nur Rauschen im Stream.
      if (verknuepft % 25 === 0 || verknuepft === gesamtVerknuepfungen) {
        beobachter?.fortschritt({
          phase: 'verknuepfung',
          text: 'Buchungen werden ihren Belegen zugeordnet',
          erledigt: verknuepft,
          gesamt: gesamtVerknuepfungen,
        });
      }
    };

    const [voucherProTransaktion, invoiceProTransaktion] = await Promise.all([
      baueTransaktionsIndex(vouchers.map((v) => v.id), async (id) => {
        const t = await sevdesk.holeVoucherTransaktionen(id);
        zaehleVerknuepfung();
        return t;
      }),
      baueTransaktionsIndex(invoices.map((i) => i.id), async (id) => {
        const t = await sevdesk.holeInvoiceTransaktionen(id);
        zaehleVerknuepfung();
        return t;
      }),
    ]);

    let positionen = baueBelege({
      transaktionen,
      vouchers,
      invoices,
      voucherProTransaktion,
      invoiceProTransaktion,
    });

    // Ab hier steht die Tabelle bereits - nur die Dateien fehlen noch. Der
    // Zwischenstand wird bewusst NICHT in den Cache geschrieben: bricht der
    // Abruf danach ab, waere sonst ein Monat ohne Belege gespeichert.
    if (beobachter?.zwischenstand) {
      beobachter.zwischenstand(await this.fuehreZusammen(monat, positionen));
    }

    beobachter?.fortschritt({
      phase: 'dateien',
      text: 'Belegdateien werden geladen',
      erledigt: 0,
      gesamt: positionen.length,
    });

    positionen = await this.ladeDateien(monat, positionen, beobachter);

    beobachter?.fortschritt({ phase: 'fertig', text: 'Fertig' });

    return this.veredele(monat, positionen);
  }

  /** Laedt fuer jede Position die zugehoerigen Dateien und legt sie ab. */
  private async ladeDateien(
    monat: string,
    positionen: Position[],
    beobachter?: LadeBeobachter,
  ): Promise<Position[]> {
    const { sevdesk, rechnungen, ablage, log } = this.deps;

    let fertig = 0;
    const melde = () => {
      fertig++;
      if (fertig % 5 === 0 || fertig === positionen.length) {
        beobachter?.fortschritt({
          phase: 'dateien',
          text: 'Belegdateien werden geladen',
          erledigt: fertig,
          gesamt: positionen.length,
        });
      }
    };

    return nacheinanderBegrenzt(positionen, 4, async (position) => {
      try {
        return await this.ladeDateiFuer(monat, position);
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        log?.warn({ positionId: position.id, err: meldung }, 'Belegabruf fehlgeschlagen');
        return { ...position, hinweis: `Abruf fehlgeschlagen: ${meldung}` };
      } finally {
        melde();
      }
    });
  }

  /** Holt die Datei(en) genau einer Buchung. */
  private async ladeDateiFuer(monat: string, position: Position): Promise<Position> {
    const { sevdesk, rechnungen, ablage } = this.deps;

    if (position.typ === 'AUSGANG' && position.voucherId) {
      // Alle Seiten, nicht nur die erste: ein Beleg kann aus mehreren Scans
      // bestehen - Vorder- und Rueckseite einer Tankquittung etwa, mitunter in
      // dieser Reihenfolge eingescannt. Es gehoeren alle in die Abrechnung.
      const dateien = await sevdesk.holeVoucherDateien(position.voucherId);
      if (dateien.length === 0) {
        return { ...position, hinweis: 'Beleg in sevDesk ohne angehaengte Datei' };
      }

      const abgelegt: BelegDatei[] = [];
      for (const datei of dateien) {
        abgelegt.push(
          await ablage.speichere(
            monat,
            datei.daten,
            datei.dateiname,
            'sevdesk-voucher',
            datei.mimeType,
          ),
        );
      }

      return { ...position, dateien: abgelegt, hinweis: undefined };
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
  private async veredele(
    monat: string,
    rohPositionen: Position[],
    basis?: Monat,
  ): Promise<Monat> {
    const roh = await this.baueRohmonat(monat, rohPositionen, basis);
    await this.deps.db.speichereMonat(roh);
    return this.fuehreZusammen(monat, rohPositionen, basis);
  }

  /** Wie `veredele`, aber ohne den Cache zu schreiben - fuer Zwischenstaende. */
  private async fuehreZusammen(
    monat: string,
    rohPositionen: Position[],
    basis?: Monat,
  ): Promise<Monat> {
    const roh = await this.baueRohmonat(monat, rohPositionen, basis);
    const overrides = await this.deps.db.ladeOverrides(monat);

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

  private async baueRohmonat(
    monat: string,
    rohPositionen: Position[],
    basis?: Monat,
  ): Promise<Monat> {
    return {
      monat,
      checkAccountId: this.deps.checkAccount.id,
      checkAccountName: this.deps.checkAccount.name,
      positionen: rohPositionen,
      summen: berechneSummen(rohPositionen),
      verwaisteBelege: basis?.verwaisteBelege ?? [],
      kontoauszuege: await this.deps.db.ladeKontoauszuege(monat),
      synchronisiertAm: basis?.synchronisiertAm ?? new Date().toISOString(),
    };
  }

  /** Uebernimmt eine manuelle Korrektur an einer Position. */
  async patcheposition(
    monat: string,
    positionId: string,
    patch: PositionsPatch,
  ): Promise<Monat> {
    return this.patcheMehrere(monat, [positionId], patch);
  }

  /**
   * Dieselbe Korrektur an mehreren Buchungen.
   *
   * Wiederkehrende Posten - Miete, Leasing, Abos - einzeln zu markieren waere
   * bei einem vollen Monat viel Klickarbeit. Der Sammelweg schreibt einmal und
   * liefert den fertigen Monat zurueck, statt je Buchung eine Runde zu drehen.
   */
  async patcheMehrere(
    monat: string,
    positionIds: string[],
    patch: PositionsPatch,
  ): Promise<Monat> {
    const aktuell = await this.deps.db.ladeMonat(monat);
    if (!aktuell) {
      throw new NichtGefunden(
        `Monat ${monat} ist noch nicht geladen. Zuerst aus sevDesk laden.`,
      );
    }
    if (positionIds.length === 0) {
      throw new EingabeFehler('Keine Buchung ausgewaehlt.');
    }

    for (const positionId of positionIds) {
      const position = aktuell.positionen.find((p) => p.id === positionId);
      if (!position) {
        throw new NichtGefunden(`Buchung ${positionId} existiert nicht in ${monat}.`);
      }
      await this.deps.db.speichereOverride(monat, positionId, baueTeilPatch(position, patch));
    }

    return this.veredele(monat, aktuell.positionen);
  }

  /**
   * Kompakter Zustand eines Monats, ohne ihn aus sevDesk nachzuladen.
   *
   * Dient dem Ueberblick, welche Monate noch offen sind - typischerweise weil
   * Buchungen in sevDesk noch nicht zugeordnet waren, als zuletzt geladen wurde.
   */
  async status(monat: string): Promise<MonatsStatus> {
    const zwischengespeichert = await this.deps.db.ladeMonat(monat);
    const kontoauszuege = (await this.deps.db.ladeKontoauszuege(monat)).length;

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
    const overrides = await this.deps.db.ladeOverrides(monat);
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
    await this.deps.db.loescheOverride(monat, positionId);
    const aktuell = await this.deps.db.ladeMonat(monat);
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

/**
 * Uebersetzt einen Patch aus der Oberflaeche in Feldaenderungen an der Position.
 * Getrennt von der Speicherung, damit Einzel- und Sammelweg dieselbe Auslegung
 * verwenden.
 */
function baueTeilPatch(position: Position, patch: PositionsPatch): Partial<Position> {
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

  if (patch.markierung !== undefined) {
    teil.markierung = patch.markierung ?? undefined;
  }

  if (patch.ablageordner !== undefined) {
    if (patch.ablageordner !== null && !istAblageordner(patch.ablageordner)) {
      throw new EingabeFehler(
        `"${String(patch.ablageordner)}" ist kein Ablageordner. ` +
          `Erlaubt: ${ABLAGEORDNER.join(', ')}.`,
      );
    }
    // null nimmt die Handeinstellung zurueck - dann greift wieder die Automatik.
    teil.ablageordner = patch.ablageordner ?? undefined;
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

  return teil;
}
