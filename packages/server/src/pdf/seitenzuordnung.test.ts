import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { Position } from '@abrechnung/shared';
import { leseSeitentexte, ordneBuchungenSeitenZu } from './seitenzuordnung.js';

/**
 * Der Steuerberater erwartet die Belege hinter genau der Auszugsseite, auf der
 * die Buchung steht. Diese Zuordnung entsteht aus der Textebene des Auszugs -
 * hier wird geprueft, dass sie trifft und wo sie sich bewusst zurueckhaelt.
 */

function pos(teil: Partial<Position> & { id: string; betrag: number }): Position {
  return {
    datum: '2026-06-02',
    waehrung: 'EUR',
    verwendungszweck: '',
    typ: teil.betrag < 0 ? 'AUSGANG' : 'EINGANG',
    sevdeskStatus: 'verknuepft',
    dateien: [],
    status: 'ok',
    manuellBestaetigt: false,
    ...teil,
  };
}

/** Erzeugt ein PDF mit Textebene - je Eintrag eine Seite. */
async function auszug(seiten: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const zeilen of seiten) {
    const seite = doc.addPage([595, 842]);
    zeilen.forEach((zeile, i) => {
      seite.drawText(zeile, { x: 50, y: 780 - i * 16, size: 10, font });
    });
  }
  return Buffer.from(await doc.save());
}

describe('leseSeitentexte', () => {
  it('liest den Text jeder Seite einzeln', async () => {
    const texte = await leseSeitentexte(
      await auszug([['Seite eins 12,34'], ['Seite zwei 56,78']]),
    );

    expect(texte).toHaveLength(2);
    expect(texte[0]).toContain('12,34');
    expect(texte[1]).toContain('56,78');
    expect(texte[0]).not.toContain('56,78');
  });

  it('liefert nichts zurueck, statt an einer kaputten Datei zu scheitern', async () => {
    expect(await leseSeitentexte(Buffer.from('kein PDF'))).toEqual([]);
  });
});

describe('ordneBuchungenSeitenZu', () => {
  it('findet die Buchung ueber Betrag und Datum', () => {
    const zuordnung = ordneBuchungenSeitenZu(
      ['01.06.2026 Miete 1.200,00', '02.06.2026 Telekom 595,17'],
      [pos({ id: 'a', betrag: -1200 , datum: '2026-06-01' }), pos({ id: 'b', betrag: -595.17 })],
    );

    expect(zuordnung.get('a')).toBe(0);
    expect(zuordnung.get('b')).toBe(1);
  });

  it('erkennt den Betrag mit und ohne Tausenderpunkt', () => {
    expect(
      ordneBuchungenSeitenZu(['Gutschrift 1200,00'], [pos({ id: 'a', betrag: 1200 })]).get('a'),
    ).toBe(0);
    expect(
      ordneBuchungenSeitenZu(['Gutschrift 1.200,00'], [pos({ id: 'a', betrag: 1200 })]).get('a'),
    ).toBe(0);
  });

  it('nimmt den Betrag unabhaengig vom Vorzeichen', () => {
    // Banken stellen das Minus mal voran, mal nach, mal als eigene Spalte.
    const texte = ['Lastschrift 595,17 S'];
    expect(ordneBuchungenSeitenZu(texte, [pos({ id: 'a', betrag: -595.17 })]).get('a')).toBe(0);
  });

  it('verwechselt keinen Teilbetrag mit dem ganzen', () => {
    // "5,17" darf nicht in "595,17" treffen.
    const zuordnung = ordneBuchungenSeitenZu(
      ['Telekom 595,17'],
      [pos({ id: 'a', betrag: -5.17 })],
    );
    expect(zuordnung.has('a')).toBe(false);
  });

  it('entscheidet bei gleichem Betrag auf zwei Seiten ueber das Datum', () => {
    const zuordnung = ordneBuchungenSeitenZu(
      ['01.06.2026 Abo 9,99', '15.06.2026 Abo 9,99'],
      [pos({ id: 'a', betrag: -9.99, datum: '2026-06-15' })],
    );
    expect(zuordnung.get('a')).toBe(1);
  });

  it('ordnet mehrere Buchungen derselben Seite zu', () => {
    const zuordnung = ordneBuchungenSeitenZu(
      ['02.06.2026 A 10,00 02.06.2026 B 20,00'],
      [pos({ id: 'a', betrag: -10 }), pos({ id: 'b', betrag: -20 })],
    );
    expect(zuordnung.get('a')).toBe(0);
    expect(zuordnung.get('b')).toBe(0);
  });

  it('laesst unauffindbare Buchungen weg, statt zu raten', () => {
    const zuordnung = ordneBuchungenSeitenZu(
      ['02.06.2026 Telekom 595,17'],
      [pos({ id: 'a', betrag: -595.17 }), pos({ id: 'b', betrag: -42 })],
    );
    expect(zuordnung.has('a')).toBe(true);
    expect(zuordnung.has('b')).toBe(false);
  });

  it('bleibt leer, wenn es keinen Text gibt', () => {
    expect(ordneBuchungenSeitenZu([], [pos({ id: 'a', betrag: -1 })]).size).toBe(0);
  });

  it('kommt mit Leerraum im Zahlenformat zurecht', () => {
    // pdfjs liefert Zahlen mitunter in Bruchstuecken mit Leerzeichen dazwischen.
    const zuordnung = ordneBuchungenSeitenZu(
      ['Betrag  595,17  EUR'],
      [pos({ id: 'a', betrag: -595.17 })],
    );
    expect(zuordnung.get('a')).toBe(0);
  });
});
