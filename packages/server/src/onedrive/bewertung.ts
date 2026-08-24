import type { AblageEintrag, OneDriveDatei } from '@abrechnung/shared';
import type { Abdruck } from './abdruck.js';

/**
 * Bewertung, wie gut eine Datei im Monatsordner zu einer Buchung passt.
 *
 * Der Abgleich ueber Hashes trifft nur, wenn beide Seiten dieselbe Datei
 * enthalten. Genau das ist hier fast nie der Fall: in OneDrive liegt die
 * Original-Rechnung des Lieferanten, aus sevDesk kommt eine eigene Fassung
 * desselben Belegs. Gemeinsam haben sie nur, was drauf steht.
 *
 * Deshalb wird hier nicht verglichen, sondern bewertet - aus fuenf
 * unabhaengigen Richtungen. Keine davon ist fuer sich beweiskraeftig; zwei
 * zusammen sind es fast immer, und genau das bildet der Zusammenspiel-Bonus ab.
 *
 * Bewusst keine Bruchteile und keine Wahrscheinlichkeiten: die Punktwerte
 * sollen sich in der Oberflaeche erklaeren lassen ("Betrag und Rechnungsnummer
 * gefunden"), nicht nur richtig sein.
 */

/** Was ein einzelnes Verfahren beigetragen hat. */
export interface Befund {
  verfahren: string;
  punkte: number;
  /** Ein Halbsatz fuer die Anzeige. */
  grund: string;
}

export interface Bewertung {
  punkte: number;
  befunde: Befund[];
  /** Kurze Begruendung fuer die Oberflaeche. */
  grund: string;
}

const PUNKTE = {
  kennung: 45,
  betrag: 30,
  betragImSummenfeld: 12,
  lieferant: 22,
  datum: 18,
  belegdatumGenau: 10,
  zusammenspiel: 15,
} as const;

/** Woerter, die als Lieferantenkennung nichts taugen. */
const FUELLWOERTER = new Set([
  'gmbh', 'ag', 'kg', 'ohg', 'mbh', 'co', 'ug', 'se', 'ev', 'gbr',
  'deutschland', 'germany', 'gmbhcokg', 'und', 'der', 'die', 'das',
  'rechnung', 'invoice', 'beleg', 'kunde', 'kundennummer', 'nr',
  'zahlung', 'lastschrift', 'sepa', 'ueberweisung', 'dauerauftrag',
  'basislastschrift', 'einzug', 'gutschrift', 'karte', 'kartenzahlung',
]);

/** Stichworte, in deren Naehe ein Betrag der Rechnungsbetrag ist. */
const SUMMENFELDER = [
  'gesamtbetrag', 'rechnungsbetrag', 'endbetrag', 'zu zahlen', 'zahlbetrag',
  'gesamtsumme', 'bruttobetrag', 'summe brutto', 'total', 'zahlungsbetrag',
];

export function normalisiere(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ä]/g, 'ae')
    .replace(/[ö]/g, 'oe')
    .replace(/[ü]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// 1. Kennungen aus dem Verwendungszweck
// ---------------------------------------------------------------------------

/**
 * Kennungen, die eine Zahlung mit einer Rechnung verbinden.
 *
 * Im Verwendungszweck einer Lastschrift steht fast immer die Rechnungs-, Kunden-
 * oder Vertragsnummer - und dieselbe Nummer steht auf der Rechnung. Das ist der
 * belastbarste Anker, den es ohne die Datei selbst gibt.
 *
 * Kurze Zahlen bleiben aussen vor: eine vierstellige Nummer findet sich in jedem
 * zweiten Dokument, ein Datum oder ein Betrag sowieso.
 */
export function kennungen(text: string): string[] {
  const gefunden = new Set<string>();

  for (const roh of text.split(/[^\w\-/]+/)) {
    const wert = roh.replace(/^[-/]+|[-/]+$/g, '');
    if (wert.length < 6 || wert.length > 40) continue;

    const ziffern = (wert.match(/\d/g) ?? []).length;
    // Ohne Ziffern ist es ein Wort, keine Kennung. Fast nur Ziffern und sehr
    // kurz waere ein Datum oder ein Betrag.
    if (ziffern < 4) continue;
    if (/^\d{1,2}[.,]\d{2}$/.test(wert)) continue;
    if (/^\d{2}[.]\d{2}[.]\d{2,4}$/.test(wert)) continue;

    gefunden.add(wert.toLowerCase());
  }

  return [...gefunden];
}

/**
 * Eine Datei, aufbereitet fuer die Bewertung.
 *
 * Aufbereitet wird einmal je Datei, nicht je Paar: bei sechzig Buchungen und
 * sechzig Dateien waeren das sonst dreieinhalbtausend Durchlaeufe ueber
 * denselben Rechnungstext.
 */
export interface Aufbereitet {
  datei: OneDriveDatei;
  /** Dateiname und Text, normalisiert und aneinandergehaengt. */
  heuhaufen: string;
  /** Nur der Text, normalisiert - fuer den Betrag, der im Namen nichts zu suchen hat. */
  text?: string;
  /** Alle Datumsangaben aus Name und Text, als ISO-Zeichenketten. */
  daten: string[];
}

export function bereiteAuf(datei: OneDriveDatei, abdruck: Abdruck | undefined): Aufbereitet {
  const name = normalisiere(datei.dateiname);

  /*
   * Was ein Modell auf einem Scan gelesen hat, zaehlt hier genauso wie eine
   * echte Textebene - fuer die Bewertung, nicht fuer die Beweise. Ohne das
   * waeren Tank-, Bewirtungs- und Geschenkbelege bis auf ihren Dateinamen
   * unsichtbar, und das ist fast die Haelfte des Monatsordners.
   */
  const teile = [abdruck?.text, abdruck?.gelesen?.text]
    .filter((t): t is string => Boolean(t))
    .map(normalisiere);
  const text = teile.length > 0 ? teile.join(' ') : undefined;
  const heuhaufen = text ? `${name} ${text}` : name;

  return { datei, heuhaufen, ...(text ? { text } : {}), daten: datumsangaben(heuhaufen) };
}

function pruefeKennung(eintrag: AblageEintrag, heuhaufen: string): Befund | null {
  const zweck = eintrag.buchung?.verwendungszweck;
  if (!zweck) return null;

  const treffer = kennungen(zweck).filter((k) => heuhaufen.includes(k));
  if (treffer.length === 0) return null;

  return {
    verfahren: 'kennung',
    punkte: PUNKTE.kennung,
    grund: `Kennung ${treffer[0]} aus dem Verwendungszweck steht im Beleg`,
  };
}

// ---------------------------------------------------------------------------
// 2. Betrag
// ---------------------------------------------------------------------------

/** Der Betrag in deutscher Schreibweise, mit und ohne Tausenderpunkt. */
export function betragsMuster(betrag: number): RegExp[] {
  const wert = Math.abs(betrag).toFixed(2).replace('.', ',');
  const mitPunkt = wert.replace(/\B(?=(\d{3})+(?!\d)(?=,))/g, '.');
  const formen = mitPunkt === wert ? [wert] : [wert, mitPunkt];

  // Ziffernraender pruefen, sonst faende "4,38" auch in "14,38" einen Treffer.
  return formen.map(
    (form) => new RegExp(`(?<![\\d.,])${form.replace(/[.]/g, '\\.')}(?![\\d,])`),
  );
}

function pruefeBetrag(eintrag: AblageEintrag, text: string | undefined): Befund | null {
  const betrag = eintrag.buchung?.betrag;
  if (betrag === undefined || !text) return null;

  const stelle = betragsMuster(betrag)
    .map((muster) => muster.exec(text))
    .find((t) => t !== null);
  if (!stelle) return null;

  // Steht der Betrag in der Naehe eines Summenfeldes, ist er der
  // Rechnungsbetrag und nicht irgendeine Position auf dem Beleg.
  const umfeld = text.slice(Math.max(0, stelle.index - 120), stelle.index);
  const imSummenfeld = SUMMENFELDER.some((wort) => umfeld.includes(wort));

  return {
    verfahren: 'betrag',
    punkte: PUNKTE.betrag + (imSummenfeld ? PUNKTE.betragImSummenfeld : 0),
    grund: imSummenfeld
      ? `Rechnungsbetrag ${stelle[0]} steht im Beleg`
      : `Betrag ${stelle[0]} steht im Beleg`,
  };
}

// ---------------------------------------------------------------------------
// 3. Lieferant
// ---------------------------------------------------------------------------

/** Die tragenden Woerter eines Firmennamens, ohne Rechtsform und Fuellwerk. */
export function namensteile(name: string): string[] {
  return normalisiere(name)
    .split(/[^a-z0-9]+/)
    .filter((teil) => teil.length >= 4 && !FUELLWOERTER.has(teil) && !/^\d+$/.test(teil));
}

function pruefeLieferant(eintrag: AblageEintrag, heuhaufen: string): Befund | null {
  const quellen = [eintrag.buchung?.gegenkonto, eintrag.buchung?.aussteller].filter(
    (q): q is string => Boolean(q),
  );

  for (const quelle of quellen) {
    const treffer = namensteile(quelle).find((teil) => heuhaufen.includes(teil));
    if (treffer) {
      return {
        verfahren: 'lieferant',
        punkte: PUNKTE.lieferant,
        grund: `"${treffer}" steht im Beleg`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Datum
// ---------------------------------------------------------------------------

/**
 * Alle Datumsangaben aus einem Text, als ISO-Zeichenketten.
 *
 * Erkannt werden die drei Schreibweisen, die tatsaechlich vorkommen:
 * 13.07.2026, 2026-07-13 und 20260713 - die letzte, weil viele Belege ihr
 * Datum im Dateinamen tragen ("bewirtung-25.07.2026.pdf").
 */
export function datumsangaben(text: string): string[] {
  const gefunden = new Set<string>();

  for (const t of text.matchAll(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/g)) {
    gefunden.add(`${t[3]}-${t[2]!.padStart(2, '0')}-${t[1]!.padStart(2, '0')}`);
  }
  for (const t of text.matchAll(/(\d{4})[-_/](\d{2})[-_/](\d{2})/g)) {
    gefunden.add(`${t[1]}-${t[2]}-${t[3]}`);
  }
  for (const t of text.matchAll(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const monat = Number(t[2]);
    const tag = Number(t[3]);
    if (monat >= 1 && monat <= 12 && tag >= 1 && tag <= 31) {
      gefunden.add(`${t[1]}-${t[2]}-${t[3]}`);
    }
  }

  return [...gefunden];
}

function tageDazwischen(frueher: string, spaeter: string): number {
  return (Date.parse(spaeter) - Date.parse(frueher)) / 86_400_000;
}

/**
 * Ein Beleg ist vor seiner Zahlung datiert - meist wenige Tage bis Wochen.
 * Je naeher, desto mehr sagt es aus; danach faellt der Wert linear ab.
 */
function pruefeDatum(eintrag: AblageEintrag, daten: string[]): Befund | null {
  const zahltag = eintrag.buchung?.datum;
  if (!zahltag) return null;
  if (daten.length === 0) return null;

  let bester: { datum: string; abstand: number } | undefined;
  for (const datum of daten) {
    const abstand = tageDazwischen(datum, zahltag);
    // Ein paar Tage nach der Zahlung sind noch plausibel (Rechnungsdatum nach
    // Abbuchung kommt bei Abos vor), lange davor nicht mehr.
    if (abstand < -5 || abstand > 90) continue;
    if (!bester || Math.abs(abstand) < Math.abs(bester.abstand)) {
      bester = { datum, abstand };
    }
  }
  if (!bester) return null;

  const naehe = 1 - Math.min(Math.abs(bester.abstand), 90) / 90;
  const punkte = Math.round(PUNKTE.datum * (0.4 + 0.6 * naehe));

  const genau = eintrag.buchung?.belegdatum === bester.datum;

  return {
    verfahren: 'datum',
    punkte: punkte + (genau ? PUNKTE.belegdatumGenau : 0),
    grund: genau
      ? `Belegdatum ${bester.datum} stimmt`
      : `Datum ${bester.datum} passt zur Zahlung (${Math.round(bester.abstand)} Tage)`,
  };
}

// ---------------------------------------------------------------------------
// 5. Zusammenspiel
// ---------------------------------------------------------------------------

/**
 * Bewertet ein Paar aus Buchung und Datei.
 *
 * Gesucht wird in Dateiname UND Text: die eingescannten Belege - Tanken,
 * Bewirtung, Geschenke - haben oft keine Textebene, tragen ihr Datum aber im
 * Namen ("tanken-13.07.2026.pdf"). Ohne den Namen waeren sie unerreichbar.
 */
export function bewerte(eintrag: AblageEintrag, aufbereitet: Aufbereitet): Bewertung {
  const befunde = [
    pruefeKennung(eintrag, aufbereitet.heuhaufen),
    pruefeBetrag(eintrag, aufbereitet.text),
    pruefeLieferant(eintrag, aufbereitet.heuhaufen),
    pruefeDatum(eintrag, aufbereitet.daten),
  ].filter((b): b is Befund => b !== null);

  let punkte = befunde.reduce((summe, b) => summe + b.punkte, 0);

  /*
   * Der eigentliche Gewinn liegt im Zusammentreffen. Ein Betrag allein findet
   * sich schnell zweimal, ein Datum sowieso - beides zusammen am selben Beleg
   * praktisch nie. Deshalb zaehlt die zweite unabhaengige Bestaetigung mehr als
   * ihr eigener Punktwert.
   */
  if (befunde.length >= 2) punkte += PUNKTE.zusammenspiel;

  return {
    punkte,
    befunde,
    grund: befunde.map((b) => b.grund).join('; ') || 'nichts Gemeinsames gefunden',
  };
}
