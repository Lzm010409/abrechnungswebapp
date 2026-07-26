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

export interface Aktenzeichen {
  /** Normalisierte Form, z. B. "0126/1800TG01" */
  normalisiert: string;
  /** Monat zweistellig, z. B. "01" */
  monat: string;
  /** Jahr vierstellig, z. B. "2026" */
  jahr: string;
  /** Schadennummer ohne fuehrende Nullen entfernt, z. B. "1800" */
  schadennummer: string;
  /** Rechnungsindex, z. B. "01" */
  rechnungsindex: string;
  /** Basis ohne Rechnungsindex, z. B. "0126/1800TG" (so sucht n8n) */
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

/** Was der Server tatsaechlich kann - haengt an den gesetzten Env-Variablen. */
export interface Capabilities {
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
