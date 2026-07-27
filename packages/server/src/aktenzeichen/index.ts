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
 * XX  Rechnungsindex - 01, 02, 03 ...
 *
 * Zu unterscheiden sind zwei Dinge, die leicht verwechselt werden:
 *
 *   Aktenzeichen    0126/1800TG      der Vorgang, entspricht dem OneDrive-Ordner
 *   Rechnungsnummer 0126/1800TG01    eine einzelne Rechnung darin
 *
 * Im Verwendungszweck einer Zahlung steht oft nur das Aktenzeichen. Der
 * Rechnungsindex ist deshalb optional.
 *
 * Die Regeln hier bilden references/aktenzeichen.md des urspruenglichen Skills ab.
 */

/**
 * Aktenzeichen mit MMYY-Praefix. Der Rechnungsindex hinter TG ist optional:
 * im Verwendungszweck steht haeufig nur der Vorgang ("IMRE 0724/1279TG KR O 68"),
 * nicht die konkrete Rechnung.
 */
const VOLLSTAENDIG =
  /(\d{2})(\d{2})\s*\/\s*(\d{1,5})\s*TG\s*(\d{1,2})?(?!\d)/gi;

/** Nur Schadennummer (+ optionaler Index), MMYY fehlt - z. B. "1800TG01". */
const OHNE_PRAEFIX = /(?<![\d/])(\d{1,5})\s*TG\s*(\d{1,2})?(?!\d)/gi;

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
  index: string | undefined,
  herkunft: AktenzeichenHerkunft,
): Aktenzeichen | null {
  if (!istGueltigerMonat(mm)) return null;

  // Rechnungsindex wird immer zweistellig geschrieben: "1" -> "01"
  const rechnungsindex = index ? index.padStart(2, '0') : undefined;
  const basis = `${mm}${yy}/${schadennummer}TG`;

  return {
    normalisiert: rechnungsindex ? `${basis}${rechnungsindex}` : basis,
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
    string | undefined,
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
      string | undefined,
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
      const [, nummer, index] = m as unknown as [
        string,
        string,
        string | undefined,
      ];
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
 * Eingabewert fuer den n8n-Workflow "Find Rechnung".
 *
 * Der Workflow zerlegt seine Eingabe mit /^(\d{4})\/(.*TG)\d+$/ und verwirft
 * den Index sofort wieder: gesucht wird der Gutachtenordner zum AKTENZEICHEN,
 * anschliessend per startsWith ueber alle Dateien darin. Der Index veraendert
 * das Suchergebnis also nicht - er muss aber vorhanden sein, sonst greift die
 * Regex nicht und der Workflow liefert null.
 *
 * Ist der Index unbekannt, wird deshalb "01" angehaengt. Das ist kein Raten:
 * der Wert wird vom Workflow verworfen, bevor er irgendetwas beeinflusst.
 */
export function workflowEingabe(az: Aktenzeichen): string {
  return `${az.basis}${az.rechnungsindex ?? '01'}`;
}

/**
 * Varianten fuer den Rechnungsabruf, wenn der erste Versuch leer bleibt.
 *
 * Variiert wird ausschliesslich der Monat: das Buchungsdatum kann bis zu
 * 30 Tage nach dem Rechnungsdatum liegen, das Aktenzeichen gehoert dann zum
 * Vormonat. Ueber den Rechnungsindex zu variieren waere sinnlos, weil der
 * Workflow ihn ohnehin verwirft (siehe workflowEingabe).
 */
export function erzeugeVarianten(az: Aktenzeichen): string[] {
  const varianten = [workflowEingabe(az)];

  const vormonat = verschiebeMonat(az, -1);
  if (vormonat) {
    const eingabe = workflowEingabe(vormonat);
    if (!varianten.includes(eingabe)) varianten.push(eingabe);
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

/**
 * Dateinamens-Praefix des Aktenzeichens, so wie der Workflow im
 * OneDrive-Ordner filtert: "0126/1800TG" -> "0126_1800TG".
 * Trifft damit alle Rechnungen des Vorgangs (TG01, TG02, TG03 ...).
 */
export function dateiPraefix(az: Aktenzeichen): string {
  return az.basis.replace(/\//g, '_');
}

/**
 * Praefix inklusive Rechnungsindex - nur nutzbar, wenn der Index bekannt ist.
 * Damit laesst sich eine konkrete Rechnung aus mehreren Treffern herausloesen.
 */
export function dateiPraefixMitIndex(az: Aktenzeichen): string | undefined {
  if (!az.rechnungsindex) return undefined;
  return `${az.basis}${az.rechnungsindex}`.replace(/\//g, '_');
}
