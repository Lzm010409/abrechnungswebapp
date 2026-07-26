import type { Aktenzeichen, AktenzeichenHerkunft } from '@abrechnung/shared';

/**
 * Aktenzeichen-Format des Buelros:
 *
 *   MMYY/<Schadennummer>TG<Rechnungsindex>
 *   0126 / 1800        TG 01
 *
 * MM  Monat zweistellig
 * YY  Jahr zweistellig
 * TG  Kuerzel Gollenstede
 * XX  Rechnungsindex, in der Praxis 01 oder 02
 *
 * Die Regeln hier bilden references/aktenzeichen.md des urspruenglichen Skills ab.
 */

/** Vollstaendiges Aktenzeichen, tolerant gegenueber Leerzeichen an allen Fugen. */
const VOLLSTAENDIG =
  /(\d{2})(\d{2})\s*\/\s*(\d{1,5})\s*TG\s*(\d{1,2})/gi;

/** Nur Schadennummer + Index, MMYY fehlt - z. B. "1800TG01". */
const OHNE_PRAEFIX = /(?<![\d/])(\d{1,5})\s*TG\s*(\d{1,2})(?!\d)/gi;

/**
 * Mehrdeutige Schreibweise wie "Rechnung 1800/26" - Zahl/Zahl ohne TG.
 * Laut Referenz kann daraus kein Aktenzeichen abgeleitet werden.
 */
const MEHRDEUTIG = /(?<![\d/])(\d{3,5})\s*\/\s*(\d{2})(?![\d/])/g;

export interface ExtraktionsErgebnis {
  /** Eindeutig erkannte Aktenzeichen, in Reihenfolge des Auftretens. */
  treffer: Aktenzeichen[];
  /**
   * true, wenn eine Schreibweise gefunden wurde, die nach Aktenzeichen aussieht,
   * aber nicht aufloesbar ist. Die Position wird dann als "mehrdeutig" markiert.
   */
  mehrdeutig: boolean;
}

function istGueltigerMonat(mm: string): boolean {
  const n = Number(mm);
  return n >= 1 && n <= 12;
}

function baue(
  mm: string,
  yy: string,
  schadennummer: string,
  index: string,
  herkunft: AktenzeichenHerkunft,
): Aktenzeichen | null {
  if (!istGueltigerMonat(mm)) return null;

  // Rechnungsindex wird immer zweistellig geschrieben: "1" -> "01"
  const rechnungsindex = index.padStart(2, '0');
  const basis = `${mm}${yy}/${schadennummer}TG`;

  return {
    normalisiert: `${basis}${rechnungsindex}`,
    monat: mm,
    jahr: `20${yy}`,
    schadennummer,
    rechnungsindex,
    basis,
    herkunft,
  };
}

/**
 * Parst ein bereits vollstaendiges Aktenzeichen.
 * Gibt null zurueck, wenn der String nicht dem Format entspricht.
 */
export function parseAktenzeichen(
  roh: string,
  herkunft: AktenzeichenHerkunft = 'manuell',
): Aktenzeichen | null {
  VOLLSTAENDIG.lastIndex = 0;
  const m = VOLLSTAENDIG.exec(roh.trim());
  if (!m) return null;
  const [, mm, yy, nummer, index] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return baue(mm, yy, nummer, index, herkunft);
}

/**
 * Zieht Aktenzeichen aus dem Verwendungszweck einer Bankbuchung.
 *
 * Praefixe wie "AZ" oder "RE" stoeren nicht, weil ausschliesslich nach dem
 * Muster gesucht wird - der Rest des Textes wird ignoriert.
 *
 * Fehlt der MMYY-Teil ("1800TG01"), wird er aus dem Buchungsdatum ergaenzt.
 * Das Buchungsdatum kann bis zu 30 Tage nach dem Rechnungsdatum liegen; die
 * Aufloesung des Vormonats uebernimmt daher `erzeugeVarianten`.
 */
export function extrahiereAusVerwendungszweck(
  verwendungszweck: string,
  buchungsdatum: string,
): ExtraktionsErgebnis {
  const treffer: Aktenzeichen[] = [];
  const gesehen = new Set<string>();

  // 1. Vollstaendige Aktenzeichen einsammeln und aus dem Text entfernen,
  //    damit ihr Rumpf nicht ein zweites Mal als "ohne Praefix" matcht.
  let rest = verwendungszweck;
  VOLLSTAENDIG.lastIndex = 0;
  for (const m of verwendungszweck.matchAll(VOLLSTAENDIG)) {
    const [ganzes, mm, yy, nummer, index] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const az = baue(mm, yy, nummer, index, 'verwendungszweck');
    if (az && !gesehen.has(az.normalisiert)) {
      gesehen.add(az.normalisiert);
      treffer.push(az);
    }
    rest = rest.replace(ganzes, ' ');
  }

  // 2. Unvollstaendige Angaben mit MMYY aus dem Buchungsdatum ergaenzen.
  if (treffer.length === 0) {
    const { mm, yy } = mmyyAusDatum(buchungsdatum);
    OHNE_PRAEFIX.lastIndex = 0;
    for (const m of rest.matchAll(OHNE_PRAEFIX)) {
      const [, nummer, index] = m as unknown as [string, string, string];
      const az = baue(mm, yy, nummer, index, 'verwendungszweck');
      if (az && !gesehen.has(az.normalisiert)) {
        gesehen.add(az.normalisiert);
        treffer.push(az);
      }
      rest = rest.replace(m[0], ' ');
    }
  }

  // 3. Sammelueberweisungen und Formen wie "Rechnung 1800/26" als mehrdeutig melden.
  MEHRDEUTIG.lastIndex = 0;
  const mehrdeutig = treffer.length === 0 && MEHRDEUTIG.test(rest);

  return { treffer, mehrdeutig };
}

function mmyyAusDatum(isoDatum: string): { mm: string; yy: string } {
  const d = new Date(`${isoDatum.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Ungueltiges Buchungsdatum: ${isoDatum}`);
  }
  return {
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
    yy: String(d.getUTCFullYear() % 100).padStart(2, '0'),
  };
}

/**
 * Retry-Kette fuer den Rechnungsabruf, wenn der erste Versuch leer bleibt.
 * Reihenfolge folgt "Sonderfaelle / MCP-Fehler" aus aktenzeichen.md:
 *
 *   1. das Aktenzeichen selbst (bereits normalisiert, Leerzeichen sind weg)
 *   2. Vormonat - das Buchungsdatum liegt bis zu 30 Tage nach dem Rechnungsdatum
 *   3. anderer Rechnungsindex (TG01 <-> TG02)
 *   4. Vormonat kombiniert mit anderem Index
 *
 * Duplikate werden entfernt, die Reihenfolge bleibt erhalten.
 */
export function erzeugeVarianten(az: Aktenzeichen): string[] {
  const varianten: string[] = [];
  const hinzu = (s: string) => {
    if (!varianten.includes(s)) varianten.push(s);
  };

  const vormonat = verschiebeMonat(az, -1);
  const andererIndex = tauscheIndex(az);

  hinzu(az.normalisiert);
  if (vormonat) hinzu(vormonat.normalisiert);
  if (andererIndex) hinzu(andererIndex.normalisiert);
  if (vormonat && andererIndex) {
    const kombiniert = tauscheIndex(vormonat);
    if (kombiniert) hinzu(kombiniert.normalisiert);
  }

  return varianten;
}

function verschiebeMonat(az: Aktenzeichen, delta: number): Aktenzeichen | null {
  const jahr = Number(az.jahr);
  const monat = Number(az.monat);
  const d = new Date(Date.UTC(jahr, monat - 1 + delta, 1));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return baue(mm, yy, az.schadennummer, az.rechnungsindex, az.herkunft);
}

function tauscheIndex(az: Aktenzeichen): Aktenzeichen | null {
  // In der Praxis existieren nur TG01 und TG02 (Gutachten / Fahrtkosten).
  if (az.rechnungsindex !== '01' && az.rechnungsindex !== '02') return null;
  const neu = az.rechnungsindex === '01' ? '02' : '01';
  return baue(az.monat, az.jahr.slice(2), az.schadennummer, neu, az.herkunft);
}

/**
 * Dateinamens-Praefix, mit dem der n8n-Workflow im OneDrive-Ordner sucht.
 * Achtung: der Workflow filtert per startsWith auf die Basis OHNE Rechnungsindex,
 * liefert also bei TG01 und TG02 potenziell beide Dateien zurueck.
 */
export function dateiPraefix(az: Aktenzeichen): string {
  return az.basis.replace(/\//g, '_');
}

/** Praefix inklusive Rechnungsindex - damit laesst sich TG01 von TG02 trennen. */
export function dateiPraefixMitIndex(az: Aktenzeichen): string {
  return az.normalisiert.replace(/\//g, '_');
}
