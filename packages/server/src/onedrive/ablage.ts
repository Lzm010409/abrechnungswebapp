import type {
  AblageEintrag,
  AblageErgebnis,
  Ablageordner,
  BelegDatei,
  LadeFortschritt,
  Monat,
  OneDriveDatei,
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

/**
 * Standardwerte der Drosselung.
 *
 * Eine Datei nach der anderen, dazwischen eine kurze Pause: n8n verarbeitet
 * jede Ablage einzeln und laedt sie zu OneDrive hoch. Ein Monat mit sechzig
 * Belegen in einem Schwall waere fuer eine kleine n8n-Instanz genug, um in die
 * Warteschlange zu laufen oder umzukippen. Die Pause kostet bei sechzig Belegen
 * etwa zwanzig Sekunden - das ist der Preis dafuer, dass der Lauf durchlaeuft.
 */
const PAUSE_MS = 350;
const VERSUCHE = 4;
/** Erste Wartezeit nach einem abgewiesenen Aufruf, danach jeweils doppelt. */
const RUECKZUG_MS = 1_000;

/** Antworten, bei denen ein zweiter Versuch sinnvoll ist. */
const NOCHMAL = new Set([429, 500, 502, 503, 504]);

export interface AblageOptionen {
  /** Webhook, der zu Jahr und Monat die Ordner-ID liefert. */
  ordnerUrl?: string;
  /** Webhook, der eine Datei in einen Unterordner legt. */
  ablageUrl?: string;
  /**
   * Webhook, der die Dateien eines Ordners auflistet.
   *
   * Ohne ihn kennt die Ablage nur die Belege aus sevDesk und laedt Kopien
   * hoch - die Originale bleiben lose im Monatsordner liegen.
   */
  ordnerDateienUrl?: string;
  /** Webhook, der eine vorhandene Datei in einen Unterordner verschiebt. */
  verschiebeUrl?: string;
  authHeader?: string;
  authValue?: string;
  fetchImpl?: typeof fetch;
  /** Pause zwischen zwei Dateien in Millisekunden. 0 schaltet sie ab. */
  pauseMs?: number;
  /** Versuche je Aufruf, einschliesslich des ersten. */
  versuche?: number;
  /** Wartezeit ersetzbar, damit Tests nicht wirklich warten muessen. */
  schlafImpl?: (ms: number) => Promise<void>;
}

export interface AblageAbhaengigkeiten {
  ladeDatei: (dateiId: string) => Promise<Buffer>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export class OneDriveAblage {
  private readonly doFetch: typeof fetch;
  private readonly schlaf: (ms: number) => Promise<void>;
  private readonly pauseMs: number;
  private readonly versuche: number;

  constructor(
    private readonly opts: AblageOptionen,
    private readonly deps: AblageAbhaengigkeiten,
  ) {
    this.doFetch = opts.fetchImpl ?? fetch;
    this.schlaf =
      opts.schlafImpl ?? ((ms) => new Promise<void>((fertig) => setTimeout(fertig, ms)));
    this.pauseMs = opts.pauseMs ?? PAUSE_MS;
    this.versuche = Math.max(1, opts.versuche ?? VERSUCHE);
  }

  /** true, wenn tatsaechlich abgelegt werden kann - sonst gibt es nur Vorschau. */
  get einsatzbereit(): boolean {
    return Boolean(this.opts.ordnerUrl && this.opts.ablageUrl);
  }

  /**
   * Teilt die Belege des Monats ein und legt sie ab.
   *
   * `nurVorschau` fuehrt die Einteilung durch, ohne etwas zu schreiben.
   *
   * `melde` gibt den Stand nach aussen. Ein voller Monat sind schnell fuenfzig
   * Dateien, die einzeln und gedrosselt hinausgehen - ohne Rueckmeldung sieht
   * die Oberflaeche minutenlang aus, als sei nichts passiert.
   */
  async lege(
    monat: Monat,
    nurVorschau = false,
    melde: (f: LadeFortschritt) => void = () => undefined,
  ): Promise<AblageErgebnis> {
    melde({
      phase: 'dateien',
      schritt: 'einteilung',
      titel: 'Belege werden eingeteilt',
      text: 'Konto, Bar und Tanken',
    });

    const einteilung = await this.teileEin(monat);
    // Nur die Ausgaben zaehlen: von den Eingaengen sollte hier ohnehin nichts
    // landen, sie als "ohne Beleg" zu melden waere irrefuehrend.
    const ohneBeleg = monat.positionen.filter(
      (p) =>
        p.status !== 'ignoriert' &&
        istAusgabe(p) &&
        !p.dateien.some(istAusgabenbeleg),
    ).length;

    melde({
      phase: 'dateien',
      schritt: 'einteilung',
      titel: 'Belege werden eingeteilt',
      text: `${einteilung.length} Beleg(e) eingeteilt`,
      erledigt: 1,
      gesamt: 1,
    });

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

    melde({
      phase: 'dateien',
      schritt: 'ordner',
      titel: 'Monatsordner wird gesucht',
      text: `Ausgabenordner zu ${monat.monat} in OneDrive`,
    });

    const [jahr, mon] = monat.monat.split('-') as [string, string];
    const gefunden = await this.ermittleOrdner(jahr, mon);
    if (!gefunden.ordnerId) {
      melde({
        phase: 'dateien',
        schritt: 'ordner',
        titel: 'Monatsordner wird gesucht',
        text: 'nicht gefunden',
        erledigt: 1,
        gesamt: 1,
      });
      return {
        monat: monat.monat,
        ausgefuehrt: false,
        eintraege: einteilung,
        ohneBeleg,
        hinweis:
          `Zu ${monat.monat} wurde in OneDrive kein Ausgabenordner gefunden. ` +
          `Der Workflow bekam [{ jahr: "${jahr}", monat: "${mon}" }] und antwortete ` +
          `mit: ${gefunden.antwort}` +
          deuteAntwort(gefunden.antwort),
      };
    }

    const ordnerId = gefunden.ordnerId;
    melde({
      phase: 'dateien',
      schritt: 'ordner',
      titel: 'Monatsordner wird gesucht',
      text: 'gefunden',
      erledigt: 1,
      gesamt: 1,
    });

    // Was liegt schon im Monatsordner? Diese Dateien werden verschoben statt
    // durch eine sevDesk-Kopie verdoppelt.
    melde({
      phase: 'dateien',
      schritt: 'abgleich',
      titel: 'Vorhandene Dateien werden abgeglichen',
      text: 'Monatsordner wird gelesen',
    });

    const vorhanden = await this.listeOrdner(ordnerId);
    const { zugeordnet, uebrig } = ordneZu(einteilung, vorhanden);

    melde({
      phase: 'dateien',
      schritt: 'abgleich',
      titel: 'Vorhandene Dateien werden abgeglichen',
      text: beschreibeAbgleich(zugeordnet, vorhanden.length, uebrig.length),
      erledigt: 1,
      gesamt: 1,
    });

    const erledigt: AblageEintrag[] = [];
    for (const [i, eintrag] of zugeordnet.entries()) {
      melde({
        phase: 'dateien',
        schritt: 'ablegen',
        titel: 'Belege werden abgelegt',
        text:
          `${eintrag.aktion === 'verschieben' ? 'verschieben' : 'hochladen'}: ` +
          `${eintrag.dateiname} → ${eintrag.ordner}`,
        erledigt: i,
        gesamt: zugeordnet.length,
      });

      // Vor jeder Datei ausser der ersten kurz Luft holen.
      if (i > 0 && this.pauseMs > 0) await this.schlaf(this.pauseMs);

      try {
        if (eintrag.aktion === 'verschieben' && eintrag.quelle) {
          await this.verschiebeDatei(ordnerId, eintrag.ordner, eintrag.quelle.id);
        } else {
          const daten = await this.deps.ladeDatei(eintrag.dateiId);
          await this.legeDateiAb(ordnerId, eintrag.ordner, eintrag.dateiname, daten);
        }
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

    const geschafft = erledigt.filter((e) => !e.fehler).length;
    melde({
      phase: 'dateien',
      schritt: 'ablegen',
      titel: 'Belege werden abgelegt',
      text: `${geschafft} von ${zugeordnet.length} abgelegt`,
      erledigt: zugeordnet.length,
      gesamt: zugeordnet.length,
    });

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
      uebrig,
    };
  }

  /**
   * Teilt die Belege auf Konto, Bar und Tanken auf.
   *
   * Konto ergibt sich aus derselben Seitenzuordnung, die auch die Reihenfolge
   * im Abrechnungs-PDF bestimmt - beides muss zusammenpassen, sonst liegt ein
   * Beleg in Bar, obwohl er im PDF hinter einer Auszugsseite steht.
   *
   * Ist an der Buchung ein Ordner von Hand gesetzt, gilt dieser. Die Regel ist
   * eine Heuristik; sie soll die Handeinstellung nicht ueberstimmen.
   */
  private async teileEin(monat: Monat): Promise<AblageEintrag[]> {
    const relevant = monat.positionen.filter(
      (p) =>
        p.status !== 'ignoriert' &&
        istAusgabe(p) &&
        p.dateien.some(istAusgabenbeleg),
    );

    const aufAuszug = await this.ermittleAuszugsBuchungen(monat, relevant);
    const eintraege: AblageEintrag[] = [];

    for (const position of relevant) {
      const treffer = aufAuszug.has(position.id);
      // Ein an der Buchung gesetzter Ordner sticht die Regel - der Mensch hat
      // den Beleg gesehen, die Heuristik nur den Verwendungszweck.
      const vonHand = position.ablageordner !== undefined;
      const ordner = position.ablageordner ?? bestimmeOrdner(position, treffer);

      for (const datei of position.dateien.filter(istAusgabenbeleg)) {
        eintraege.push({
          positionId: position.id,
          dateiId: datei.id,
          dateiname: datei.dateiname,
          groesse: datei.groesse,
          ordner,
          begruendung: vonHand
            ? 'an der Buchung von Hand gesetzt'
            : begruende(ordner, treffer, position),
          ...(vonHand ? { vonHand: true } : {}),
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

  /**
   * Fragt den Workflow nach der Ordner-ID des Monats.
   *
   * Zurueck kommt auch die Antwort selbst, gekuerzt. Ohne sie stand in der
   * Oberflaeche nur "kein Ausgabenordner gefunden" - und niemand konnte
   * unterscheiden, ob der Workflow nichts gefunden hat, ob er gar nicht
   * aktiviert ist oder ob die Antwort nur anders aussieht als erwartet.
   */
  private async ermittleOrdner(
    jahr: string,
    monat: string,
  ): Promise<{ ordnerId?: string; antwort: string }> {
    // Der Workflow "Find Ausgabenordner" erwartet eine Liste mit einem Eintrag,
    // das Jahr vierstellig und den Monat zweistellig: [{ jahr: "2026", monat: "07" }].
    const antwort = await this.rufe(this.opts.ordnerUrl!, [{ jahr, monat }]);

    return { ordnerId: sucheOrdnerId(antwort), antwort: kuerze(antwort) };
  }

  /**
   * Die Dateien, die schon im Monatsordner liegen.
   *
   * Ohne den Workflow bleibt die Liste leer - dann wird wie bisher aus sevDesk
   * hochgeladen. Ein Fehlschlag ist ebenfalls kein Abbruchgrund: hochladen ist
   * schlechter als verschieben, aber immer noch besser als gar nichts.
   */
  private async listeOrdner(ordnerId: string): Promise<OneDriveDatei[]> {
    if (!this.opts.ordnerDateienUrl || !this.opts.verschiebeUrl) return [];

    try {
      const antwort = await this.rufe(this.opts.ordnerDateienUrl, [{ ordnerId }]);
      return leseDateiliste(antwort);
    } catch (err) {
      this.deps.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Monatsordner liess sich nicht auflisten - es wird hochgeladen statt verschoben',
      );
      return [];
    }
  }

  /** Verschiebt eine bereits vorhandene Datei in den Unterordner. */
  private async verschiebeDatei(
    ordnerId: string,
    unterordner: Ablageordner,
    dateiId: string,
  ): Promise<void> {
    await this.rufe(this.opts.verschiebeUrl!, { ordnerId, unterordner, dateiId });
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

  /**
   * Ein Aufruf an n8n, mit Wiederholung bei Ueberlast.
   *
   * Wiederholt wird nur, was voruebergehend sein kann: 429 und die
   * 5xx-Antworten, dazu Verbindungsfehler. Ein 400 oder 404 kommt beim zweiten
   * Versuch genauso zurueck - das waere nur zusaetzliche Last.
   *
   * Bittet n8n per `Retry-After` um eine bestimmte Wartezeit, gilt die; sonst
   * wird die Wartezeit von Versuch zu Versuch verdoppelt.
   */
  private async rufe(url: string, koerper: unknown): Promise<unknown> {
    const kopf: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.authHeader && this.opts.authValue) {
      kopf[this.opts.authHeader] = this.opts.authValue;
    }
    const rumpf = JSON.stringify(koerper);

    let letzter = new Error('n8n wurde nicht aufgerufen');

    for (let versuch = 1; versuch <= this.versuche; versuch++) {
      let res: Response;
      try {
        res = await this.doFetch(url, { method: 'POST', headers: kopf, body: rumpf });
      } catch (err) {
        // Verbindungsfehler: kann die Instanz sein, die gerade neu startet.
        letzter = new Error(
          `n8n nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (await this.wartetNochmal(versuch)) continue;
        throw letzter;
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const text = await res.text().catch(() => '');
      letzter = new Error(`n8n antwortete mit ${res.status}: ${text.slice(0, 200)}`);
      if (!NOCHMAL.has(res.status)) throw letzter;

      const gewuenscht = leseRetryAfter(res.headers?.get?.('retry-after') ?? null);
      if (await this.wartetNochmal(versuch, gewuenscht)) continue;
      throw letzter;
    }

    throw letzter;
  }

  /** Wartet vor dem naechsten Versuch; false, wenn es keinen mehr gibt. */
  private async wartetNochmal(versuch: number, gewuenschtMs?: number): Promise<boolean> {
    if (versuch >= this.versuche) return false;

    const ms = gewuenschtMs ?? RUECKZUG_MS * 2 ** (versuch - 1);
    this.deps.log?.warn({ versuch, wartenMs: ms }, 'n8n ausgelastet, neuer Versuch folgt');
    await this.schlaf(ms);
    return true;
  }
}

/**
 * Deutet die haeufigen Antworten, statt den Nutzer raten zu lassen.
 *
 * Erwartet wird `[{ "id": "017CTAN…" }]` - eine Liste mit der Ordnerkennung.
 * Wer stattdessen "Workflow was started" zurueckbekommt, hat im Webhook-Knoten
 * "Respond: Immediately" stehen: n8n bestaetigt dann nur den Start und schickt
 * das Ergebnis nie. Das ist die mit Abstand haeufigste Ursache und von einem
 * echten "nichts gefunden" nicht zu unterscheiden, solange man die Antwort
 * nicht sieht.
 */
function deuteAntwort(antwort: string): string {
  if (antwort.includes('Workflow was started')) {
    return (
      ' — der Webhook antwortet sofort, statt auf das Ergebnis zu warten. ' +
      'In n8n im Webhook-Knoten "Respond" auf "Using Respond to Webhook node" ' +
      'oder "Last node" stellen.'
    );
  }
  if (antwort === '(leer)' || antwort === '[]' || antwort === '{}') {
    return ' — der Workflow lief, fand zu diesem Monat aber keinen Ordner.';
  }
  return '';
}

/** Antwort fuer die Fehlermeldung - kurz genug fuer eine Zeile Oberflaeche. */
function kuerze(wert: unknown): string {
  const text = typeof wert === 'string' ? wert : JSON.stringify(wert);
  if (!text || text === '""') return '(leer)';
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

/** `Retry-After` kommt als Sekundenzahl oder als Datum. */
function leseRetryAfter(wert: string | null): number | undefined {
  if (!wert) return undefined;

  const sekunden = Number(wert);
  if (Number.isFinite(sekunden)) return Math.max(0, sekunden) * 1000;

  const zeitpunkt = Date.parse(wert);
  if (Number.isNaN(zeitpunkt)) return undefined;
  return Math.max(0, zeitpunkt - Date.now());
}

// ---------------------------------------------------------------------------

/**
 * Ordnet jedem Beleg die Datei zu, die in OneDrive schon dafuer liegt.
 *
 * Der Sinn: die Belege sind bereits im Monatsordner - sie muessen nur in den
 * richtigen Unterordner. Wer stattdessen eine Kopie aus sevDesk hochlaedt,
 * hat die Datei doppelt und das Original weiterhin lose herumliegen.
 *
 * Zugeordnet wird in zwei Stufen, die staerkere zuerst:
 *
 *  1. gleicher Dateiname - traegt bei allem, was von Hand hochgeladen wurde
 *     oder dessen Name sevDesk unveraendert uebernommen hat
 *  2. gleiche Groesse in Bytes, und zwar eindeutig - denselben Beleg zweimal
 *     mit identischer Bytezahl gibt es praktisch nicht, verschiedene mit
 *     zufaellig gleicher Groesse aber sehr wohl. Bei mehreren Kandidaten wird
 *     deshalb nicht geraten.
 *
 * Was sich nicht zuordnen laesst, wird hochgeladen wie bisher. Was in OneDrive
 * uebrig bleibt, wird gemeldet statt stillschweigend liegen gelassen - dort
 * zeigt sich, wo der Abgleich danebenliegt.
 */
export function ordneZu(
  eintraege: AblageEintrag[],
  vorhanden: OneDriveDatei[],
): { zugeordnet: AblageEintrag[]; uebrig: OneDriveDatei[] } {
  const frei = new Map(vorhanden.map((d) => [d.id, d]));

  const nimm = (datei: OneDriveDatei, abgleich: string) => {
    frei.delete(datei.id);
    return { aktion: 'verschieben' as const, quelle: datei, abgleich };
  };

  // Erst alle Namenstreffer, dann die Groessen: sonst koennte eine
  // Groessenuebereinstimmung eine Datei wegschnappen, die namentlich
  // eindeutig zu einem spaeteren Beleg gehoert.
  const zugeordnet: AblageEintrag[] = eintraege.map((e) => ({ ...e }));

  for (const eintrag of zugeordnet) {
    const treffer = [...frei.values()].find(
      (d) => normalisiere(d.dateiname) === normalisiere(eintrag.dateiname),
    );
    if (treffer) Object.assign(eintrag, nimm(treffer, 'gleicher Dateiname'));
  }

  for (const eintrag of zugeordnet) {
    if (eintrag.aktion) continue;

    const kandidaten = [...frei.values()].filter(
      (d) => d.groesse !== undefined && d.groesse === eintrag.groesse,
    );
    if (kandidaten.length === 1) {
      Object.assign(eintrag, nimm(kandidaten[0]!, 'gleiche Groesse'));
    }
  }

  for (const eintrag of zugeordnet) {
    if (!eintrag.aktion) eintrag.aktion = 'hochladen';
  }

  return { zugeordnet, uebrig: [...frei.values()] };
}

/** Gross-/Kleinschreibung und Leerraum sollen den Abgleich nicht verhindern. */
function normalisiere(name: string): string {
  return name.trim().toLowerCase();
}

/** Kurzer Satz fuer die Fortschrittsanzeige. */
function beschreibeAbgleich(
  zugeordnet: AblageEintrag[],
  gefunden: number,
  uebrig: number,
): string {
  if (gefunden === 0) {
    return 'keine vorhandenen Dateien gefunden - es wird hochgeladen';
  }
  const verschoben = zugeordnet.filter((e) => e.aktion === 'verschieben').length;
  return `${verschoben} verschieben, ${zugeordnet.length - verschoben} hochladen, ${uebrig} bleibt liegen`;
}

/**
 * Liest die Dateiliste aus der Antwort des Workflows.
 *
 * Wie ueberall bei n8n: Feldnamen nicht fest verdrahten. Gesucht wird nach
 * Objekten, die eine Kennung und einen Namen tragen; Ordner werden dabei
 * uebersprungen, sie sollen nicht in sich selbst verschoben werden.
 */
export function leseDateiliste(wert: unknown): OneDriveDatei[] {
  const roh = Array.isArray(wert) ? wert : [wert];
  const dateien: OneDriveDatei[] = [];

  for (const eintrag of roh) {
    if (typeof eintrag !== 'object' || eintrag === null) continue;
    const o = eintrag as Record<string, unknown>;

    // OneDrive kennzeichnet Ordner mit einem "folder"-Objekt (childCount).
    if (o.folder !== undefined && o.folder !== null) continue;

    const id = ersterText(o, ['id', 'dateiId', 'itemId', 'driveItemId']);
    const dateiname = ersterText(o, ['name', 'dateiname', 'filename', 'fileName']);
    if (!id || !dateiname) continue;

    const groesse = ersteZahl(o, ['size', 'groesse', 'sizeBytes']);
    dateien.push({ id, dateiname, ...(groesse === undefined ? {} : { groesse }) });
  }

  return dateien;
}

function ersterText(o: Record<string, unknown>, felder: string[]): string | undefined {
  for (const feld of felder) {
    const wert = o[feld];
    if (typeof wert === 'string' && wert.length > 0) return wert;
  }
  return undefined;
}

function ersteZahl(o: Record<string, unknown>, felder: string[]): number | undefined {
  for (const feld of felder) {
    const wert = o[feld];
    if (typeof wert === 'number' && Number.isFinite(wert)) return wert;
    if (typeof wert === 'string' && wert.trim() !== '' && Number.isFinite(Number(wert))) {
      return Number(wert);
    }
  }
  return undefined;
}

/**
 * Nur Ausgabenbelege werden einsortiert.
 *
 * Die Ausgangsrechnungen liegen in OneDrive an ganz anderer Stelle - im
 * Gutachtenordner des jeweiligen Vorgangs. Sie in die Monatsordner zu kopieren
 * waere eine zweite, konkurrierende Ablage derselben Datei.
 */
function istAusgabe(position: Position): boolean {
  return position.typ === 'AUSGANG';
}

/**
 * Rechnungs-PDFs bleiben auch an einer Ausgabenbuchung aussen vor.
 *
 * Beide Quellen sind Ausgangsrechnungen: das Original aus dem Gutachtenordner
 * und das von sevDesk erzeugte PDF. Bei einer Gutschrift kann so etwas an
 * einer AUSGANG-Buchung haengen - abgelegt gehoert es trotzdem nicht.
 */
function istAusgabenbeleg(datei: BelegDatei): boolean {
  return datei.quelle !== 'sevdesk-invoice' && datei.quelle !== 'onedrive-n8n';
}

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
