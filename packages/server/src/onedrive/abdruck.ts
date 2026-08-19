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
}

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

export async function berechneAbdruck(daten: Buffer): Promise<Abdruck> {
  const { bilder, seiten } = await leseBildstroeme(daten);
  const text = normalisiereText((await leseSeitentexte(daten)).join(' '));

  return {
    groesse: daten.byteLength,
    sha256: hashe(daten),
    bilder,
    ...(seiten === undefined ? {} : { seiten }),
    // Ein paar Zeichen Restmuell gibt es auch in bildbasierten PDFs. Unter
    // dieser Grenze taugt der Text nicht als Merkmal.
    ...(text.length >= 40 ? { textHash: hashe(text), text } : {}),
  };
}
