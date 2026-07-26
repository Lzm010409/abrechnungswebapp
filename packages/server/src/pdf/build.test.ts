import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { Monat, Position } from '@abrechnung/shared';
import { baueAbrechnungsPdf } from './build.js';

/** Erzeugt ein echtes PDF mit n Seiten als Testeingabe. */
async function testPdf(seiten: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < seiten; i++) doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
}

function position(teil: Partial<Position> & { id: string }): Position {
  return {
    datum: '2026-06-03',
    betrag: 100,
    waehrung: 'EUR',
    verwendungszweck: 'Test',
    typ: 'EINGANG',
    sevdeskStatus: 'verknuepft',
    dateien: [],
    status: 'ok',
    manuellBestaetigt: false,
    ...teil,
  };
}

function datei(id: string, seiten = 1) {
  return {
    id,
    dateiname: `${id}.pdf`,
    groesse: 1000,
    mimeType: 'application/pdf',
    quelle: 'onedrive-n8n' as const,
    seiten,
  };
}

function monat(teil: Partial<Monat> = {}): Monat {
  return {
    monat: '2026-06',
    checkAccountId: '1234',
    checkAccountName: 'Geschaeftskonto',
    positionen: [],
    summen: {
      einnahmen: 0, ausgaben: 0, saldo: 0,
      anzahlGesamt: 0, anzahlOk: 0, anzahlMehrdeutig: 0, anzahlOffen: 0,
      anzahlIgnoriert: 0, anzahlNichtZugeordnet: 0,
    },
    verwaisteBelege: [],
    kontoauszuege: [],
    ...teil,
  };
}

async function seitenzahl(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

describe('baueAbrechnungsPdf', () => {
  it('erzeugt ein gueltiges PDF mit Deckblatt und Journal', async () => {
    const pdf = await baueAbrechnungsPdf({
      monat: monat({ positionen: [position({ id: 'a' })] }),
      ladeDatei: async () => Buffer.alloc(0),
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Deckblatt + Journal
    expect(await seitenzahl(pdf)).toBe(2);
  });

  it('stellt die Kontoauszuege dem Journal voran', async () => {
    const auszug = await testPdf(3);

    const pdf = await baueAbrechnungsPdf({
      monat: monat({
        positionen: [position({ id: 'a' })],
        kontoauszuege: [
          { id: 'ka1', dateiname: 'Auszug_06.pdf', groesse: 1, hochgeladenAm: '2026-07-01T00:00:00Z' },
        ],
      }),
      ladeDatei: async () => auszug,
    });

    // Deckblatt(1) + Kontoauszug(3) + Journal(1)
    expect(await seitenzahl(pdf)).toBe(5);
  });

  it('haengt die Belegseiten aller Positionen an', async () => {
    const beleg = await testPdf(2);

    const pdf = await baueAbrechnungsPdf({
      monat: monat({
        positionen: [
          position({ id: 'a', dateien: [datei('d1', 2)] }),
          position({ id: 'b', dateien: [datei('d2', 2)] }),
        ],
      }),
      ladeDatei: async () => beleg,
    });

    // Deckblatt(1) + Journal(1) + 2 Belege a 2 Seiten
    expect(await seitenzahl(pdf)).toBe(6);
  });

  it('laesst ignorierte Positionen komplett weg', async () => {
    const beleg = await testPdf(2);

    const pdf = await baueAbrechnungsPdf({
      monat: monat({
        positionen: [
          position({ id: 'a', dateien: [datei('d1', 2)] }),
          position({ id: 'b', dateien: [datei('d2', 2)], status: 'ignoriert' }),
        ],
      }),
      ladeDatei: async () => beleg,
    });

    // Nur ein Beleg wird angehaengt
    expect(await seitenzahl(pdf)).toBe(4);
  });

  it('sortiert innerhalb eines Tages AUSGANG vor EINGANG', async () => {
    const gesehen: string[] = [];
    await baueAbrechnungsPdf({
      monat: monat({
        positionen: [
          position({ id: 'ein', typ: 'EINGANG', dateien: [datei('d-ein')] }),
          position({ id: 'aus', typ: 'AUSGANG', betrag: -50, dateien: [datei('d-aus')] }),
        ],
      }),
      ladeDatei: async (id) => {
        gesehen.push(id);
        return testPdf(1);
      },
    });

    expect(gesehen).toEqual(['d-aus', 'd-ein']);
  });

  it('ueberspringt eine beschaedigte Belegdatei, statt die Abrechnung zu kippen', async () => {
    const pdf = await baueAbrechnungsPdf({
      monat: monat({
        positionen: [
          position({ id: 'a', dateien: [datei('kaputt')] }),
          position({ id: 'b', dateien: [datei('gut')] }),
        ],
      }),
      ladeDatei: async (id) =>
        id === 'kaputt' ? Buffer.from('das ist kein PDF') : testPdf(1),
    });

    // Deckblatt + Journal + die eine intakte Belegseite
    expect(await seitenzahl(pdf)).toBe(3);
  });

  it('ueberspringt eine fehlende Datei, statt zu scheitern', async () => {
    const pdf = await baueAbrechnungsPdf({
      monat: monat({ positionen: [position({ id: 'a', dateien: [datei('weg')] })] }),
      ladeDatei: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(await seitenzahl(pdf)).toBe(2);
  });

  it('kommt mit Sonderzeichen im Verwendungszweck zurecht', async () => {
    // Emojis und kyrillische Zeichen wuerden die WinAnsi-Standardfonts sprengen.
    const pdf = await baueAbrechnungsPdf({
      monat: monat({
        positionen: [
          position({ id: 'a', verwendungszweck: 'Zahlung 🎉 Привет Grüße' }),
        ],
      }),
      ladeDatei: async () => Buffer.alloc(0),
    });

    expect(await seitenzahl(pdf)).toBe(2);
  });

  it('umbricht das Journal auf mehrere Seiten', async () => {
    const positionen = Array.from({ length: 120 }, (_, i) =>
      position({ id: `p${i}`, datum: '2026-06-03' }),
    );

    const pdf = await baueAbrechnungsPdf({
      monat: monat({ positionen }),
      ladeDatei: async () => Buffer.alloc(0),
    });

    // Deckblatt + mehrere Journalseiten
    expect(await seitenzahl(pdf)).toBeGreaterThan(2);
  });

  it('erzeugt auch fuer einen leeren Monat ein gueltiges PDF', async () => {
    const pdf = await baueAbrechnungsPdf({
      monat: monat(),
      ladeDatei: async () => Buffer.alloc(0),
    });
    expect(await seitenzahl(pdf)).toBe(2);
  });
});
