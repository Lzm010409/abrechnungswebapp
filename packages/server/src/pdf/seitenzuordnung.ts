import type { Position } from '@abrechnung/shared';

/**
 * Ordnet Buchungen den Seiten eines Kontoauszugs zu.
 *
 * Der Steuerberater erwartet die Belege hinter genau der Auszugsseite, auf der
 * die zugehoerige Buchung steht. Dafuer muss bekannt sein, welche Buchung auf
 * welcher Seite auftaucht.
 *
 * Gelesen wird die Textebene des PDF, nicht dessen Bild - Bank-Auszuege bringen
 * die praktisch immer mit. Gesucht wird nach dem Betrag in deutscher
 * Schreibweise, das Buchungsdatum dient als Bestaetigung. Ein reiner
 * Betragstreffer genuegt, weil derselbe Betrag am selben Tag zweimal auf
 * verschiedenen Seiten kaum vorkommt; wo doch, entscheidet das Datum.
 *
 * Fehlt die Textebene (eingescannter Auszug), bleibt die Zuordnung leer und der
 * Aufrufer faellt auf die einfache Reihenfolge zurueck. Lieber gar keine
 * Zuordnung als eine falsche.
 */

export interface Seitentext {
  /** Fortlaufend ueber alle Auszuege hinweg, beginnend bei 0 */
  seitennummer: number;
  text: string;
}

/** Liest den Text jeder Seite eines PDF. Leeres Ergebnis heisst: kein Text. */
export async function leseSeitentexte(pdf: Buffer): Promise<string[]> {
  try {
    // Erst hier laden - pdfjs ist gross, und ohne Kontoauszug wird es nie
    // gebraucht.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const dokument = await pdfjs.getDocument({
      data: new Uint8Array(pdf),
      // Ohne Schriftdaten reicht es: gebraucht wird der Text, nicht das Bild.
      useSystemFonts: false,
      verbosity: 0,
    }).promise;

    const texte: string[] = [];
    for (let nr = 1; nr <= dokument.numPages; nr++) {
      const seite = await dokument.getPage(nr);
      const inhalt = await seite.getTextContent();
      texte.push(
        inhalt.items
          .map((eintrag) => ('str' in eintrag ? eintrag.str : ''))
          .join(' '),
      );
    }

    await dokument.cleanup();
    return texte;
  } catch {
    // Beschaedigt, passwortgeschuetzt oder ohne Textebene - kein Grund, die
    // ganze Abrechnung scheitern zu lassen.
    return [];
  }
}

/**
 * Ergebnis der Zuordnung: Positions-ID -> laufende Seitennummer.
 * Nicht zugeordnete Buchungen fehlen in der Abbildung.
 */
export type Seitenzuordnung = Map<string, number>;

export function ordneBuchungenSeitenZu(
  seitentexte: string[],
  positionen: Position[],
): Seitenzuordnung {
  const zuordnung: Seitenzuordnung = new Map();
  if (seitentexte.length === 0) return zuordnung;

  const normalisiert = seitentexte.map(normalisiere);

  for (const position of positionen) {
    const betraege = betragsSchreibweisen(position.betrag);
    const datumsformen = datumsSchreibweisen(position.datum);

    let beste = -1;
    let bestePunkte = 0;

    for (const [i, text] of normalisiert.entries()) {
      const betragGefunden = betraege.some((b) => enthaeltZahl(text, b));
      if (!betragGefunden) continue;

      const datumGefunden = datumsformen.some((d) => text.includes(d));
      const punkte = datumGefunden ? 2 : 1;

      if (punkte > bestePunkte) {
        bestePunkte = punkte;
        beste = i;
      }
    }

    if (beste >= 0) zuordnung.set(position.id, beste);
  }

  return zuordnung;
}

// ---------------------------------------------------------------------------

/** Vereinheitlicht Leerraum, damit "1 234,56" nicht an Umbruechen scheitert. */
function normalisiere(text: string): string {
  return text.replace(/[   ]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Schreibweisen desselben Betrags, wie sie auf Auszuegen vorkommen:
 * mit und ohne Tausenderpunkt, jeweils der Absolutbetrag. Das Vorzeichen
 * bleibt aussen vor - Banken setzen es mal davor, mal dahinter, mal als
 * Spalte "Soll".
 */
function betragsSchreibweisen(betrag: number): string[] {
  const absolut = Math.abs(betrag).toFixed(2);
  const [ganz, nachkomma] = absolut.split('.') as [string, string];

  const ohnePunkt = `${ganz},${nachkomma}`;
  const mitPunkt = `${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${nachkomma}`;

  return ohnePunkt === mitPunkt ? [ohnePunkt] : [mitPunkt, ohnePunkt];
}

/** 2026-06-02 -> "02.06.2026", "02.06.26", "02.06." */
function datumsSchreibweisen(iso: string): string[] {
  const [jahr, monat, tag] = iso.split('-') as [string, string, string];
  return [`${tag}.${monat}.${jahr}`, `${tag}.${monat}.${jahr.slice(2)}`, `${tag}.${monat}.`];
}

/**
 * Sucht eine Zahl, ohne dass sie Teil einer laengeren sein darf.
 * Ohne diese Pruefung faende "5,17" auch in "595,17" einen Treffer.
 */
function enthaeltZahl(text: string, zahl: string): boolean {
  const maskiert = zahl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.,])${maskiert}(?![\\d,])`).test(text);
}
