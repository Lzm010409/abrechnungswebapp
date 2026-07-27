import type {
  AblageEintrag,
  AblageErgebnis,
  Ablageordner,
  Monat,
  Position,
} from '@abrechnung/shared';
import { leseSeitentexte, ordneBuchungenSeitenZu } from '../pdf/seitenzuordnung.js';
import { bestimmeOrdner, istTankbeleg } from './kategorie.js';

/**
 * Ablage der Belege in den OneDrive-Monatsordnern.
 *
 * Sie geschieht am Ende, beim Erzeugen des Abrechnungs-PDF - vorher steht die
 * Einteilung nicht fest, weil sie davon abhaengt, welche Buchung sich auf einer
 * Kontoauszugsseite wiederfindet.
 *
 * Ohne konfigurierte Ablage-Workflows entsteht nur eine Vorschau. Das ist
 * Absicht: die Oberflaeche kann dann zeigen, was passieren wuerde, ohne dass
 * jemand die Ordner in Ordnung bringen muss, wenn es daneben ging.
 */

export interface AblageOptionen {
  /** Webhook, der zu Jahr und Monat die Ordner-ID liefert. */
  ordnerUrl?: string;
  /** Webhook, der eine Datei in einen Unterordner legt. */
  ablageUrl?: string;
  authHeader?: string;
  authValue?: string;
  fetchImpl?: typeof fetch;
}

export interface AblageAbhaengigkeiten {
  ladeDatei: (dateiId: string) => Promise<Buffer>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export class OneDriveAblage {
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly opts: AblageOptionen,
    private readonly deps: AblageAbhaengigkeiten,
  ) {
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** true, wenn tatsaechlich abgelegt werden kann - sonst gibt es nur Vorschau. */
  get einsatzbereit(): boolean {
    return Boolean(this.opts.ordnerUrl && this.opts.ablageUrl);
  }

  /**
   * Teilt die Belege des Monats ein und legt sie ab.
   *
   * `nurVorschau` fuehrt die Einteilung durch, ohne etwas zu schreiben.
   */
  async lege(monat: Monat, nurVorschau = false): Promise<AblageErgebnis> {
    const einteilung = await this.teileEin(monat);
    const ohneBeleg = monat.positionen.filter(
      (p) => p.status !== 'ignoriert' && p.dateien.length === 0,
    ).length;

    if (nurVorschau || !this.einsatzbereit) {
      return {
        monat: monat.monat,
        ausgefuehrt: false,
        eintraege: einteilung,
        ohneBeleg,
        hinweis: this.einsatzbereit
          ? undefined
          : 'Vorschau - N8N_ORDNER_URL und N8N_ABLAGE_URL sind nicht gesetzt.',
      };
    }

    const [jahr, mon] = monat.monat.split('-') as [string, string];
    const ordnerId = await this.ermittleOrdner(jahr, mon);
    if (!ordnerId) {
      return {
        monat: monat.monat,
        ausgefuehrt: false,
        eintraege: einteilung,
        ohneBeleg,
        hinweis: `Zu ${monat.monat} wurde in OneDrive kein Ausgabenordner gefunden.`,
      };
    }

    const erledigt: AblageEintrag[] = [];
    for (const eintrag of einteilung) {
      try {
        const daten = await this.deps.ladeDatei(eintrag.dateiId);
        await this.legeDateiAb(ordnerId, eintrag.ordner, eintrag.dateiname, daten);
        erledigt.push(eintrag);
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        this.deps.log?.warn(
          { datei: eintrag.dateiname, err: meldung },
          'Beleg konnte nicht abgelegt werden',
        );
        erledigt.push({ ...eintrag, fehler: meldung });
      }
    }

    this.deps.log?.info(
      { monat: monat.monat, anzahl: erledigt.filter((e) => !e.fehler).length },
      'Belege in OneDrive abgelegt',
    );

    return {
      monat: monat.monat,
      ausgefuehrt: true,
      ordnerId,
      eintraege: erledigt,
      ohneBeleg,
    };
  }

  /**
   * Teilt die Belege auf Konto, Bar und Tanken auf.
   *
   * Konto ergibt sich aus derselben Seitenzuordnung, die auch die Reihenfolge
   * im Abrechnungs-PDF bestimmt - beides muss zusammenpassen, sonst liegt ein
   * Beleg in Bar, obwohl er im PDF hinter einer Auszugsseite steht.
   */
  private async teileEin(monat: Monat): Promise<AblageEintrag[]> {
    const relevant = monat.positionen.filter(
      (p) => p.status !== 'ignoriert' && p.dateien.length > 0,
    );

    const aufAuszug = await this.ermittleAuszugsBuchungen(monat, relevant);
    const eintraege: AblageEintrag[] = [];

    for (const position of relevant) {
      const treffer = aufAuszug.has(position.id);
      const ordner = bestimmeOrdner(position, treffer);

      for (const datei of position.dateien) {
        eintraege.push({
          positionId: position.id,
          dateiId: datei.id,
          dateiname: datei.dateiname,
          ordner,
          begruendung: begruende(ordner, treffer, position),
        });
      }
    }

    return eintraege;
  }

  /** IDs der Buchungen, die sich auf einer Kontoauszugsseite wiederfinden. */
  private async ermittleAuszugsBuchungen(
    monat: Monat,
    positionen: Position[],
  ): Promise<Set<string>> {
    const texte: string[] = [];

    for (const auszug of monat.kontoauszuege) {
      try {
        texte.push(...(await leseSeitentexte(await this.deps.ladeDatei(auszug.id))));
      } catch {
        // Fehlender Auszug ist kein Grund abzubrechen - dann gilt eben, was
        // sich aus den uebrigen ergibt.
      }
    }

    return new Set(ordneBuchungenSeitenZu(texte, positionen).keys());
  }

  // -------------------------------------------------------------------------

  private async ermittleOrdner(jahr: string, monat: string): Promise<string | undefined> {
    // Der Workflow "Find Ausgabenordner" erwartet eine Liste mit einem Eintrag,
    // das Jahr vierstellig und den Monat zweistellig: [{ jahr: "2026", monat: "07" }].
    const antwort = await this.rufe(this.opts.ordnerUrl!, [{ jahr, monat }]);

    return sucheOrdnerId(antwort);
  }

  private async legeDateiAb(
    ordnerId: string,
    unterordner: Ablageordner,
    dateiname: string,
    daten: Buffer,
  ): Promise<void> {
    await this.rufe(this.opts.ablageUrl!, {
      ordnerId,
      unterordner,
      dateiname,
      inhalt: daten.toString('base64'),
    });
  }

  private async rufe(url: string, koerper: unknown): Promise<unknown> {
    const kopf: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.authHeader && this.opts.authValue) {
      kopf[this.opts.authHeader] = this.opts.authValue;
    }

    const res = await this.doFetch(url, {
      method: 'POST',
      headers: kopf,
      body: JSON.stringify(koerper),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`n8n antwortete mit ${res.status}: ${text.slice(0, 200)}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

// ---------------------------------------------------------------------------

function begruende(ordner: Ablageordner, aufAuszug: boolean, position: Position): string {
  if (ordner === 'Konto') {
    return aufAuszug
      ? 'auf einer Seite des Kontoauszugs gefunden'
      : 'dem Kontoauszug zugeordnet';
  }
  if (ordner === 'Tanken') return 'als Tankbeleg erkannt';
  return istTankbeleg(position)
    ? 'Tankbeleg, aber nicht auf dem Kontoauszug'
    : 'nicht auf dem Kontoauszug gefunden';
}

/**
 * Sucht die Ordner-ID in der Antwort des Workflows.
 *
 * Wie beim Belegabruf gilt: Feldnamen nicht fest verdrahten. Genommen wird der
 * erste Wert unter einem plausiblen Schluessel, sonst die erste Zeichenkette,
 * die nach einer OneDrive-Kennung aussieht.
 */
export function sucheOrdnerId(wert: unknown, tiefe = 0): string | undefined {
  if (tiefe > 6 || wert === null || wert === undefined) return undefined;

  if (typeof wert === 'string') {
    return sichtOrdnerIdAus(wert) ? wert : undefined;
  }

  if (Array.isArray(wert)) {
    for (const eintrag of wert) {
      const fund = sucheOrdnerId(eintrag, tiefe + 1);
      if (fund) return fund;
    }
    return undefined;
  }

  if (typeof wert !== 'object') return undefined;
  const objekt = wert as Record<string, unknown>;

  for (const feld of ['ordnerId', 'folderId', 'id', 'itemId', 'driveItemId']) {
    const kandidat = objekt[feld];
    if (typeof kandidat === 'string' && kandidat.length > 0) return kandidat;
  }

  for (const inhalt of Object.values(objekt)) {
    const fund = sucheOrdnerId(inhalt, tiefe + 1);
    if (fund) return fund;
  }

  return undefined;
}

/** OneDrive-Kennungen sind lang und enthalten keine Leerzeichen. */
function sichtOrdnerIdAus(wert: string): boolean {
  return wert.length >= 8 && !/\s/.test(wert);
}
