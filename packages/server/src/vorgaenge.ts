import { randomUUID } from 'node:crypto';
import type { LadeFortschritt, Vorgang, VorgangsArt } from '@abrechnung/shared';

/**
 * Laenger laufende Vorgaenge, die der Server selbst zu Ende fuehrt.
 *
 * Belege auslesen und Monat pruefen dauern Minuten. Sie in einer offenen
 * HTTP-Anfrage abzuwarten hat zweierlei gekostet:
 *
 *  - Der Reverse-Proxy kappte die Verbindung, wenn 100 Sekunden lang keine
 *    Daten flossen (Cloudflare 524). Genau das ist bei der Monatspruefung der
 *    Normalfall: ein einzelner Modellaufruf, dazwischen passiert nichts.
 *  - Wer das Fenster wechselte oder neu lud, verlor den Lauf mitsamt Ergebnis -
 *    obwohl er serverseitig weiterlief und Geld gekostet hatte.
 *
 * Deshalb: Starten gibt sofort eine Kennung zurueck, die Arbeit laeuft im
 * Hintergrund weiter, und die Oberflaeche fragt den Stand ab, wann sie mag.
 * Kein Aufruf dauert dabei laenger als Millisekunden.
 */

/** So lange bleibt ein abgeschlossener Vorgang abrufbar. */
const AUFBEWAHRUNG_MS = 60 * 60 * 1000;

/** Obergrenze, damit ein langer Arbeitstag den Speicher nicht vollaeuft. */
const HOECHSTZAHL = 100;

export interface VorgangsStart {
  art: VorgangsArt;
  monat: string;
  titel: string;
}

export class Vorgaenge {
  private readonly liste = new Map<string, Vorgang>();

  constructor(
    private readonly log?: {
      info: (o: unknown, m?: string) => void;
      error: (o: unknown, m?: string) => void;
    },
  ) {}

  /**
   * Startet die Arbeit und kehrt sofort zurueck.
   *
   * Die zurueckgegebene Zusage wird bewusst nicht nach aussen gereicht: der
   * Aufrufer soll nicht darauf warten koennen, sonst waere nichts gewonnen.
   */
  starte(
    start: VorgangsStart,
    arbeit: (melde: (f: LadeFortschritt) => void) => Promise<unknown>,
  ): Vorgang {
    this.raeumeAuf();

    const vorgang: Vorgang = {
      id: randomUUID(),
      art: start.art,
      monat: start.monat,
      titel: start.titel,
      status: 'laeuft',
      fortschritt: [],
      gestartetAm: new Date().toISOString(),
    };
    this.liste.set(vorgang.id, vorgang);

    void arbeit((fortschritt) => this.melde(vorgang.id, fortschritt))
      .then((ergebnis) => {
        this.beende(vorgang.id, { status: 'fertig', ergebnis });
        this.log?.info(
          { vorgang: vorgang.id, art: vorgang.art, monat: vorgang.monat },
          'Vorgang abgeschlossen',
        );
      })
      .catch((err: unknown) => {
        const meldung = err instanceof Error ? err.message : String(err);
        this.beende(vorgang.id, { status: 'fehler', fehler: meldung });
        this.log?.error(
          { vorgang: vorgang.id, art: vorgang.art, monat: vorgang.monat, err: meldung },
          'Vorgang fehlgeschlagen',
        );
      });

    return vorgang;
  }

  hole(id: string): Vorgang | undefined {
    return this.liste.get(id);
  }

  /** Alle bekannten Vorgaenge, neueste zuerst; auf Wunsch nur zu einem Monat. */
  alle(monat?: string): Vorgang[] {
    const gefunden = [...this.liste.values()].filter((v) => !monat || v.monat === monat);
    return gefunden.sort((a, b) => b.gestartetAm.localeCompare(a.gestartetAm));
  }

  /** Nimmt einen abgeschlossenen Vorgang aus der Liste - die UI hat ihn gesehen. */
  entferne(id: string): boolean {
    const vorgang = this.liste.get(id);
    // Einen laufenden Vorgang zu entfernen wuerde ihn nicht anhalten, nur
    // unsichtbar machen. Das waere schlimmer als ihn stehen zu lassen.
    if (!vorgang || vorgang.status === 'laeuft') return false;
    return this.liste.delete(id);
  }

  // -------------------------------------------------------------------------

  /**
   * Ein Stand je Schritt: ein erneuter Stand mit derselben Kennung ersetzt den
   * vorhandenen, statt die Liste immer laenger werden zu lassen.
   */
  private melde(id: string, fortschritt: LadeFortschritt): void {
    const vorgang = this.liste.get(id);
    if (!vorgang) return;

    const schluessel = fortschritt.schritt ?? fortschritt.phase;
    const i = vorgang.fortschritt.findIndex((f) => (f.schritt ?? f.phase) === schluessel);
    if (i >= 0) vorgang.fortschritt[i] = fortschritt;
    else vorgang.fortschritt.push(fortschritt);
  }

  private beende(
    id: string,
    ende: { status: 'fertig'; ergebnis: unknown } | { status: 'fehler'; fehler: string },
  ): void {
    const vorgang = this.liste.get(id);
    if (!vorgang) return;

    vorgang.status = ende.status;
    vorgang.beendetAm = new Date().toISOString();
    if (ende.status === 'fertig') vorgang.ergebnis = ende.ergebnis;
    else vorgang.fehler = ende.fehler;
  }

  /** Abgeschlossene Vorgaenge nach einer Weile vergessen. Laufende nie. */
  private raeumeAuf(): void {
    const grenze = Date.now() - AUFBEWAHRUNG_MS;

    for (const [id, vorgang] of this.liste) {
      if (vorgang.status === 'laeuft') continue;
      if (Date.parse(vorgang.beendetAm ?? vorgang.gestartetAm) < grenze) this.liste.delete(id);
    }

    if (this.liste.size <= HOECHSTZAHL) return;

    // Immer noch zu viele: die aeltesten abgeschlossenen zuerst.
    const abgeschlossen = [...this.liste.entries()]
      .filter(([, v]) => v.status !== 'laeuft')
      .sort((a, b) => a[1].gestartetAm.localeCompare(b[1].gestartetAm));

    for (const [id] of abgeschlossen.slice(0, this.liste.size - HOECHSTZAHL)) {
      this.liste.delete(id);
    }
  }
}
