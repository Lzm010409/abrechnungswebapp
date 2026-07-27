/**
 * Gemeinsame Typen zwischen Server und Frontend.
 *
 * Fachliche Begriffe folgen dem urspruenglichen Abrechnungs-Skill:
 *  - EINGANG = Geldeingang, also eine Ausgangsrechnung an einen Auftraggeber
 *  - AUSGANG = Geldausgang, also ein Lieferanten-/Kostenbeleg
 */

export type BuchungsTyp = 'EINGANG' | 'AUSGANG';

/** Woher ein Beleg stammt bzw. warum keiner vorliegt. */
export type BelegQuelle =
  /** Beleg haengt in sevDesk am Voucher (getDocumentImage) */
  | 'sevdesk-voucher'
  /** PDF der Ausgangsrechnung aus sevDesk (Invoice/getPdf) */
  | 'sevdesk-invoice'
  /** Original-Rechnung aus dem OneDrive-Gutachtenordner ueber n8n */
  | 'onedrive-n8n'
  /** Vom Benutzer manuell hochgeladen */
  | 'manuell'
  /** Noch nichts gefunden */
  | 'fehlt';

/** Ampel je Buchung, entspricht der Statusspalte im Skill-Report. */
export type PositionsStatus =
  /** Beleg eindeutig zugeordnet */
  | 'ok'
  /** Mehrdeutig: mehrere Kandidaten, Nutzer muss entscheiden */
  | 'mehrdeutig'
  /** Kein Beleg gefunden */
  | 'offen'
  /** Vom Nutzer bewusst ausgeblendet (z. B. Umbuchung) */
  | 'ignoriert';

/**
 * Aktenzeichen eines Vorgangs.
 *
 * Wichtige Unterscheidung:
 *   Aktenzeichen   0126/1800TG      - identifiziert den Vorgang (den Ordner)
 *   Rechnungsnummer 0126/1800TG01   - identifiziert eine Rechnung darin
 *
 * Zu einem Aktenzeichen koennen mehrere Rechnungen gehoeren (TG01 Gutachten,
 * TG02 Fahrtkosten, TG03 ...). Im Verwendungszweck einer Zahlung steht oft nur
 * das Aktenzeichen ohne Index - deshalb ist `rechnungsindex` optional.
 */
export interface Aktenzeichen {
  /** Vollstaendigste bekannte Form: mit Index falls bekannt, sonst die Basis */
  normalisiert: string;
  /** Monat zweistellig, z. B. "01" */
  monat: string;
  /** Jahr vierstellig, z. B. "2026" */
  jahr: string;
  /** Schadennummer, fuehrende Nullen bleiben erhalten, z. B. "1800" */
  schadennummer: string;
  /**
   * Rechnungsindex, z. B. "01". Fehlt, wenn im Verwendungszweck nur das
   * Aktenzeichen ohne Rechnungsbezug stand.
   */
  rechnungsindex?: string;
  /** Aktenzeichen ohne Index, z. B. "0126/1800TG" - damit sucht der Workflow */
  basis: string;
  /** Wie das Aktenzeichen ermittelt wurde */
  herkunft: AktenzeichenHerkunft;
}

export type AktenzeichenHerkunft =
  /** Aus der in sevDesk verknuepften Rechnung uebernommen - exakt */
  | 'sevdesk-invoice'
  /** Aus dem Verwendungszweck der Buchung geparst */
  | 'verwendungszweck'
  /** Vom Benutzer eingetragen oder korrigiert */
  | 'manuell'
  /** Von der KI vorgeschlagen und bestaetigt */
  | 'ki';

export interface BelegDatei {
  /** Stabile ID, zugleich Dateiname im Cache */
  id: string;
  dateiname: string;
  /** Bytes, informativ fuer die UI */
  groesse: number;
  mimeType: string;
  quelle: BelegQuelle;
  /** Seitenzahl, sofern ermittelbar (fuer die PDF-Zusammenstellung) */
  seiten?: number;
}

/** Aus dem Beleg extrahierte Werte - befuellt durch die KI, wenn aktiviert. */
export interface BelegExtraktion {
  betrag?: number;
  belegdatum?: string;
  aussteller?: string;
  ustBetrag?: number;
  ustSatz?: number;
  kategorie?: string;
  aktenzeichen?: string;
  /** 0..1, Selbsteinschaetzung des Modells */
  konfidenz?: number;
  extrahiertAm?: string;
}

/**
 * Verbuchungsstand der Bankbuchung in sevDesk selbst.
 *
 * Entscheidend fuer die Fehlersuche: eine Buchung ohne Beleg kann zwei ganz
 * verschiedene Ursachen haben. Ist sie in sevDesk noch gar nicht zugeordnet
 * ("offen"), gehoert die Korrektur nach sevDesk. Ist sie dort verbucht und
 * hier trotzdem ohne Datei, liegt es am Belegabruf.
 */
export type SevdeskStatus =
  /** 100 - angelegt, noch keiner Rechnung/keinem Beleg zugeordnet */
  | 'offen'
  /** 200 - mit Beleg oder Rechnung verknuepft */
  | 'verknuepft'
  /** 300 - als privat markiert */
  | 'privat'
  /** 400 - verbucht */
  | 'verbucht'
  /** unbekannter Statuscode */
  | 'unbekannt';

/** Eine Zeile der Monatsansicht: eine Bankbuchung samt allem, was daran haengt. */
export interface Position {
  /** sevDesk CheckAccountTransaction-ID */
  id: string;
  /** Wertstellung, ISO-Datum (YYYY-MM-DD) */
  datum: string;
  /** Positiv = Eingang, negativ = Ausgang */
  betrag: number;
  waehrung: string;
  verwendungszweck: string;
  /** Name des Zahlungspflichtigen bzw. -empfaengers, sofern von sevDesk geliefert */
  gegenkonto?: string;
  typ: BuchungsTyp;
  /** Verbuchungsstand in sevDesk - siehe SevdeskStatus */
  sevdeskStatus: SevdeskStatus;

  /** In sevDesk verknuepfter Beleg (Eingangsrechnung/Kostenbeleg) */
  voucherId?: string;
  /** In sevDesk verknuepfte Ausgangsrechnung */
  invoiceId?: string;
  /** Rechnungsnummer der verknuepften Ausgangsrechnung */
  rechnungsnummer?: string;

  aktenzeichen?: Aktenzeichen;
  /** Alternativen, wenn das Aktenzeichen nicht eindeutig war */
  aktenzeichenKandidaten?: string[];

  /** Zugeordnete Dateien. Mehr als eine bei TG01+TG02 oder Sammelbelegen. */
  dateien: BelegDatei[];
  /** Weitere Treffer, die nicht automatisch zugeordnet wurden */
  kandidaten?: BelegDatei[];
  /**
   * true, sobald der Nutzer aus mehreren Treffern gewaehlt hat. Die restlichen
   * Kandidaten bleiben sichtbar, machen die Position aber nicht mehr
   * mehrdeutig - die Entscheidung ist gefallen.
   */
  auswahlBestaetigt?: boolean;

  extraktion?: BelegExtraktion;
  status: PositionsStatus;
  /** Klartext-Begruendung fuer den Status, wird in der UI als Tooltip gezeigt */
  hinweis?: string;
  /** true, sobald ein Mensch die Position bestaetigt oder korrigiert hat */
  manuellBestaetigt: boolean;
}

export interface MonatsSummen {
  einnahmen: number;
  ausgaben: number;
  saldo: number;
  anzahlGesamt: number;
  anzahlOk: number;
  anzahlMehrdeutig: number;
  anzahlOffen: number;
  anzahlIgnoriert: number;
  /**
   * Buchungen, die in sevDesk selbst noch keiner Rechnung/keinem Beleg
   * zugeordnet sind. Solange diese Zahl > 0 ist, ist der Monat noch nicht
   * abschliessend - die Zuordnung passiert in sevDesk, danach neu laden.
   */
  anzahlNichtZugeordnet: number;
}

/** Kompakter Zustand eines Monats - ohne die vollstaendige Positionsliste. */
export interface MonatsStatus {
  monat: string;
  /** false, wenn der Monat noch nie aus sevDesk geladen wurde */
  geladen: boolean;
  synchronisiertAm?: string;
  summen?: MonatsSummen;
  /** true, wenn alle Buchungen zugeordnet und belegt sind */
  abgeschlossen: boolean;
  anzahlKontoauszuege: number;
}

export interface Kontoauszug {
  id: string;
  dateiname: string;
  groesse: number;
  seiten?: number;
  hochgeladenAm: string;
}

export interface Monat {
  /** "2026-06" */
  monat: string;
  checkAccountId: string;
  checkAccountName?: string;
  positionen: Position[];
  summen: MonatsSummen;
  /** Belege ohne passende Buchung */
  verwaisteBelege: BelegDatei[];
  /** Manuell hochgeladene Kontoauszuege, werden dem PDF vorangestellt */
  kontoauszuege: Kontoauszug[];
  /** Zeitpunkt des letzten Abgleichs mit sevDesk */
  synchronisiertAm?: string;
}

/**
 * Abschnitte des Ladevorgangs. Ein Monat aus sevDesk zu holen dauert je nach
 * Buchungszahl deutlich laenger als eine Sekunde - die Oberflaeche zeigt
 * deshalb an, woran gerade gearbeitet wird, statt nur "wird geladen".
 */
export type LadePhase =
  /** Verbindung steht, es geht los */
  | 'start'
  /** Bankbuchungen des Monats */
  | 'transaktionen'
  /** Belege und Ausgangsrechnungen im Umfeld des Monats */
  | 'belege'
  /** Rueckwaerts-Index Buchung -> Beleg */
  | 'verknuepfung'
  /** Die Belegdateien selbst (langsamster Teil) */
  | 'dateien'
  | 'fertig';

export interface LadeFortschritt {
  phase: LadePhase;
  /** Kurzer Text fuer die Oberflaeche */
  text: string;
  /** Bei zaehlbaren Phasen der Stand, sonst offen */
  erledigt?: number;
  gesamt?: number;
}

/** Ereignisse des Lade-Streams (Server-Sent Events). */
export type LadeEreignis =
  | { art: 'fortschritt'; fortschritt: LadeFortschritt }
  /** Zwischenstand: Buchungen stehen, Belege fehlen noch */
  | { art: 'teil'; monat: Monat }
  | { art: 'fertig'; monat: Monat }
  | { art: 'fehler'; fehler: string };

/** Die angemeldete Person, aus dem Entra-ID-Token uebernommen. */
export interface AngemeldeterBenutzer {
  /** Eindeutige Kennung des Kontos im Tenant */
  sub: string;
  name: string;
  email?: string;
}

/** Was der Server tatsaechlich kann - haengt an den gesetzten Env-Variablen. */
export interface Capabilities {
  /** false, wenn keine gueltige Sitzung besteht - dann ist nur /auth/login moeglich */
  angemeldet?: boolean;
  /** true, wenn der Server eine Anmeldung verlangt */
  anmeldungNoetig?: boolean;
  benutzer?: AngemeldeterBenutzer;
  /** ANTHROPIC_API_KEY gesetzt */
  ki: boolean;
  /** N8N_FIND_RECHNUNG_URL gesetzt */
  n8nRechnungsabruf: boolean;
  /** SEVDESK_API_TOKEN gesetzt und Bankkonto aufgeloest */
  sevdesk: boolean;
  kiModell?: string;
  checkAccountId?: string;
  checkAccountName?: string;
}

/** KI-Vorschlag zur Zuordnung eines Belegs zu einer Buchung. */
export interface ZuordnungsVorschlag {
  positionId: string;
  belegId: string;
  konfidenz: number;
  begruendung: string;
}

/** KI-Auswertung eines kompletten Monats. */
export interface MonatsReview {
  zusammenfassung: string;
  auffaelligkeiten: ReviewBefund[];
  erstelltAm: string;
}

export interface ReviewBefund {
  schwere: 'hinweis' | 'warnung' | 'fehler';
  titel: string;
  beschreibung: string;
  positionIds: string[];
}

/** Patch-Body fuer manuelle Korrekturen an einer Position. */
export interface PositionsPatch {
  aktenzeichen?: string | null;
  status?: PositionsStatus;
  hinweis?: string | null;
  /** IDs aus `kandidaten`, die nach `dateien` uebernommen werden sollen */
  dateiIds?: string[];
}

export const MONAT_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export function istGueltigerMonat(monat: string): boolean {
  return MONAT_REGEX.test(monat);
}

/** "2026-06" -> { von: "2026-06-01", bis: "2026-06-30" } */
export function monatsGrenzen(monat: string): { von: string; bis: string } {
  if (!istGueltigerMonat(monat)) {
    throw new Error(`Ungueltiger Monat: ${monat} (erwartet YYYY-MM)`);
  }
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const von = new Date(Date.UTC(jahr, mon - 1, 1));
  const bis = new Date(Date.UTC(jahr, mon, 0));
  return { von: isoDatum(von), bis: isoDatum(bis) };
}

export function isoDatum(d: Date): string {
  return d.toISOString().slice(0, 10);
}
