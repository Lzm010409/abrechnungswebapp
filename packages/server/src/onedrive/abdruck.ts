import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { leseSeitentexte } from '../pdf/seitenzuordnung.js';

/**
 * Fingerabdruck einer Belegdatei.
 *
 * Der Abgleich zwischen sevDesk und OneDrive scheiterte bisher fast immer, weil
 * er nur Dateiname und Byte-Groesse kannte. Beides taugt nicht: sevDesk nennt
 * jeden Beleg "beleg-<voucherId>.pdf", waehrend in OneDrive der Name des
 * Lieferanten steht, und Groessen wiederholen sich (in einem gepruefen
 * Monatsordner lagen vier verschiedene Rechnungen mit exakt 95370 Bytes).
 *
 * Deshalb wird jede Datei einmal vollstaendig gelesen und in mehrere
 * unabhaengige Merkmale zerlegt. Sie sind bewusst verschieden empfindlich:
 *
 *   `sha256`   Rohbytes. Trifft, wenn sevDesk die Datei unveraendert
 *              zurueckgibt - der haeufigste Fall bei einseitigen Belegen.
 *
 *   `bilder`   Die eingebetteten Bildstroeme, einzeln gehasht. Sie ueberleben
 *              das Zusammenfassen mehrerer Seiten zu einem PDF und einen
 *              Wechsel des Erzeugers; nachgewiesen in abdruck.test.ts. Das ist
 *              der Weg fuer gescannte Belege, die sevDesk seitenweise
 *              herausgibt und die diese Anwendung wieder zusammensetzt.
 *
 *   `textHash` Die Textebene, normalisiert. Trifft bei erzeugten Rechnungen
 *              auch dann, wenn das PDF neu geschrieben wurde.
 *
 *   `text`     Derselbe Text im Klartext, damit sich Betrag und Datum einer
 *              Buchung darin suchen lassen, wenn alles andere versagt.
 *
 * Ein Abdruck kostet einmal Rechenzeit und wird danach zwischengespeichert.
 */
export interface Abdruck {
  groesse: number;
  /** Hash der Rohbytes. */
  sha256: string;
  /** Anzahl Seiten, sofern lesbar. */
  seiten?: number;
  /** Hashes der eingebetteten Bildstroeme, aufsteigend sortiert. */
  bilder: string[];
  /** Hash des normalisierten Textes; fehlt, wenn es keine Textebene gibt. */
  textHash?: string;
  /** Normalisierter Text; fehlt ohne Textebene. */
  text?: string;
  /**
   * Was ein Modell auf dem Beleg gelesen hat - nur bei Dateien ohne Textebene.
   *
   * Fast die Haelfte der Belege im Monatsordner sind Fotos oder Scans: Tanken,
   * Bewirtung, Geschenke. Sie tragen keinen Text, den ein PDF-Leser findet, und
   * waren damit fuer den Abgleich bis auf ihren Dateinamen unsichtbar.
   *
   * Bewusst getrennt von `text` gefuehrt und ausdruecklich KEIN Beweis: der
   * Inhalt ist gedeutet, nicht ausgelesen. Er geht in die Bewertung ein, nie in
   * die Hash-Stufen - zwei verschiedene Tankquittungen koennten sonst denselben
   * Texthash bekommen und miteinander verwechselt werden.
   */
  gelesen?: {
    text: string;
    /** Selbsteinschaetzung des Modells, 0..1. */
    konfidenz?: number;
  };
}

/**
 * Liest einen Beleg, dem die Textebene fehlt.
 *
 * Uebergeben wird der Dienst, den die Anwendung ohnehin fuer die
 * Belegauswertung benutzt - hier nur auf die Dateien im Monatsordner
 * angewendet.
 */
export type Belegleser = (
  daten: Buffer,
  dateiname: string,
) => Promise<{ text: string; konfidenz?: number } | null>;

function hashe(daten: Uint8Array | string): string {
  return createHash('sha256').update(daten).digest('hex');
}

/**
 * Vereinheitlicht den Text, damit Leerraum und Schreibweise den Vergleich nicht
 * verhindern. Zwei Erzeuger setzen dieselbe Rechnung mit unterschiedlich vielen
 * Leerzeichen und Zeilenumbruechen ab.
 */
export function normalisiereText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Die Hashes aller eingebetteten Bildstroeme, sortiert. */
async function leseBildstroeme(daten: Buffer): Promise<{ bilder: string[]; seiten?: number }> {
  try {
    const dokument = await PDFDocument.load(daten, { ignoreEncryption: true });
    const bilder: string[] = [];

    for (const [, objekt] of dokument.context.enumerateIndirectObjects()) {
      if (!(objekt instanceof PDFRawStream)) continue;
      if (objekt.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      bilder.push(hashe(objekt.contents));
    }

    return { bilder: bilder.sort(), seiten: dokument.getPageCount() };
  } catch {
    // Kein PDF, beschaedigt oder verschluesselt. Dann bleibt es beim
    // Byte-Hash - der stimmt immer noch, wenn die Datei unveraendert ist.
    return { bilder: [] };
  }
}

export async function berechneAbdruck(
  daten: Buffer,
  dateiname = '',
  leser?: Belegleser,
): Promise<Abdruck> {
  const { bilder, seiten } = await leseBildstroeme(daten);
  const text = normalisiereText((await leseSeitentexte(daten)).join(' '));
  // Ein paar Zeichen Restmuell gibt es auch in bildbasierten PDFs. Unter
  // dieser Grenze taugt der Text nicht als Merkmal.
  const hatTextebene = text.length >= 40;

  const abdruck: Abdruck = {
    groesse: daten.byteLength,
    sha256: hashe(daten),
    bilder,
    ...(seiten === undefined ? {} : { seiten }),
    ...(hatTextebene ? { textHash: hashe(text), text } : {}),
  };

  // Nur wo nichts zu lesen war. Ein Modell zu fragen kostet Geld und Zeit; bei
  // einer vorhandenen Textebene waere es beides umsonst ausgegeben.
  if (!hatTextebene && leser) {
    const gelesen = await leser(daten, dateiname);
    if (gelesen && gelesen.text.trim().length > 0) {
      abdruck.gelesen = {
        text: normalisiereText(gelesen.text),
        ...(gelesen.konfidenz === undefined ? {} : { konfidenz: gelesen.konfidenz }),
      };
    }
  }

  return abdruck;
}
