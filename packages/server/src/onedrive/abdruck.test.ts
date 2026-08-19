import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { berechneAbdruck, normalisiereText } from './abdruck.js';

/**
 * Der Fingerabdruck ist die Grundlage des Abgleichs mit OneDrive. Entscheidend
 * ist, welche Merkmale eine Umformung ueberstehen: sevDesk gibt gescannte
 * Belege seitenweise heraus, diese Anwendung setzt sie wieder zusammen. Danach
 * ist die Datei eine andere - der Beleg aber derselbe.
 */

/** Ein winziges PNG, damit sich ein echter Bildstrom einbetten laesst. */
function testPng(farbe: [number, number, number]): Buffer {
  const stueck = (typ: string, daten: Buffer): Buffer => {
    const inhalt = Buffer.concat([Buffer.from(typ, 'latin1'), daten]);
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(daten.length);
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(crc32(inhalt));
    return Buffer.concat([laenge, inhalt, pruef]);
  };

  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(4, 0);
  kopf.writeUInt32BE(4, 4);
  kopf[8] = 8;
  kopf[9] = 2;

  const zeilen = Buffer.concat(
    Array.from({ length: 4 }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.from(Array(4).fill(farbe).flat())]),
    ),
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    stueck('IHDR', kopf),
    stueck('IDAT', deflateSync(zeilen)),
    stueck('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(daten: Buffer): number {
  let c = 0xffffffff;
  for (const byte of daten) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function pdfMitBild(png: Buffer, titel?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (titel) doc.setTitle(titel);
  const bild = await doc.embedPng(png);
  doc.addPage([200, 200]).drawImage(bild, { x: 0, y: 0, width: 100, height: 100 });
  return Buffer.from(await doc.save());
}

async function pdfMitText(zeilen: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const seite = doc.addPage([595, 842]);
  zeilen.forEach((zeile, i) =>
    seite.drawText(zeile, { x: 50, y: 700 - i * 16, size: 11, font }),
  );
  return Buffer.from(await doc.save());
}

/** Fasst Seiten zu einem PDF zusammen - genau wie fasseSeitenZusammen es tut. */
async function fasseZusammen(seiten: Buffer[]): Promise<Buffer> {
  const ziel = await PDFDocument.create();
  for (const seite of seiten) {
    const quelle = await PDFDocument.load(seite);
    const kopien = await ziel.copyPages(quelle, quelle.getPageIndices());
    for (const kopie of kopien) ziel.addPage(kopie);
  }
  return Buffer.from(await ziel.save());
}

describe('berechneAbdruck', () => {
  it('haelt den Hash der Rohbytes fest', async () => {
    const daten = Buffer.from('irgendwas');
    const abdruck = await berechneAbdruck(daten);

    expect(abdruck.sha256).toBe(createHash('sha256').update(daten).digest('hex'));
    expect(abdruck.groesse).toBe(daten.byteLength);
  });

  it('kommt mit etwas zurecht, das gar kein PDF ist', async () => {
    const abdruck = await berechneAbdruck(Buffer.from('kein PDF'));
    expect(abdruck.bilder).toEqual([]);
    expect(abdruck.textHash).toBeUndefined();
  });

  it('erkennt dasselbe Bild in zwei verschieden erzeugten PDFs wieder', async () => {
    // Der Kern der Sache: die Dateien sind verschieden, der Beleg ist derselbe.
    const png = testPng([200, 30, 30]);
    const a = await berechneAbdruck(await pdfMitBild(png));
    const b = await berechneAbdruck(await pdfMitBild(png, 'anderer Erzeuger'));

    expect(a.sha256).not.toBe(b.sha256);
    expect(a.bilder).toHaveLength(1);
    expect(a.bilder).toEqual(b.bilder);
  });

  it('unterscheidet verschiedene Bilder', async () => {
    const a = await berechneAbdruck(await pdfMitBild(testPng([200, 30, 30])));
    const b = await berechneAbdruck(await pdfMitBild(testPng([30, 200, 30])));

    expect(a.bilder).not.toEqual(b.bilder);
  });

  it('ueberlebt das Zusammenfassen mehrerer Seiten zu einem Beleg', async () => {
    /*
     * Genau der Fall aus dem Betrieb: sevDesk gibt eine gescannte Quittung als
     * Vorder- und Rueckseite heraus, diese Anwendung fasst sie zu einem PDF
     * zusammen. Die Datei ist danach eine voellig andere - die Bildstroeme sind
     * dieselben, und nur daran laesst sich das Original in OneDrive erkennen.
     */
    const vorne = await pdfMitBild(testPng([200, 30, 30]));
    const hinten = await pdfMitBild(testPng([30, 30, 200]));
    const beleg = await berechneAbdruck(await fasseZusammen([vorne, hinten]));

    const seiteVorne = await berechneAbdruck(vorne);
    expect(beleg.sha256).not.toBe(seiteVorne.sha256);
    expect(beleg.bilder).toHaveLength(2);
    expect(beleg.bilder).toEqual(expect.arrayContaining(seiteVorne.bilder));
    expect(beleg.seiten).toBe(2);
  });

  it('liest die Textebene und haelt sie als Hash fest', async () => {
    const a = await berechneAbdruck(
      await pdfMitText(['Telekom Deutschland GmbH', 'Rechnungsnummer: 391617514', 'Endbetrag 4,38']),
    );
    expect(a.textHash).toBeTruthy();
    expect(a.text).toContain('391617514');
    expect(a.text).toContain('4,38');
  });

  it('gibt zwei inhaltsgleichen Rechnungen denselben Texthash', async () => {
    const zeilen = ['Vodafone West GmbH', 'Rechnungsnummer: 00302751112/26/06', 'Betrag 49,99'];
    const a = await berechneAbdruck(await pdfMitText(zeilen));
    const b = await berechneAbdruck(await pdfMitText(zeilen));

    // Gleicher Inhalt, aber unabhaengig erzeugt.
    expect(a.textHash).toBe(b.textHash);
  });

  it('nimmt ein paar Zeichen Restmuell nicht fuer eine Textebene', async () => {
    const abdruck = await berechneAbdruck(await pdfMitBild(testPng([1, 2, 3])));
    expect(abdruck.textHash).toBeUndefined();
  });
});

describe('normalisiereText', () => {
  it('macht Leerraum und Schreibweise gleich', () => {
    expect(normalisiereText('  Rechnung\n\n  Nr. 5  ')).toBe('rechnung nr. 5');
  });
});
