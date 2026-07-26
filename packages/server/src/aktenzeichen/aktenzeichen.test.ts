import { describe, expect, it } from 'vitest';
import {
  dateiPraefix,
  dateiPraefixMitIndex,
  erzeugeVarianten,
  extrahiereAusVerwendungszweck,
  parseAktenzeichen,
} from './index.js';

describe('parseAktenzeichen', () => {
  it('zerlegt ein vollstaendiges Aktenzeichen', () => {
    const az = parseAktenzeichen('0126/1800TG01');
    expect(az).not.toBeNull();
    expect(az!.normalisiert).toBe('0126/1800TG01');
    expect(az!.monat).toBe('01');
    expect(az!.jahr).toBe('2026');
    expect(az!.schadennummer).toBe('1800');
    expect(az!.rechnungsindex).toBe('01');
    expect(az!.basis).toBe('0126/1800TG');
  });

  it('haelt fuehrende Nullen der Schadennummer', () => {
    // Beispiel aus aktenzeichen.md: Dezember 2025, Schadennummer 42
    const az = parseAktenzeichen('1225/0042TG01');
    expect(az!.schadennummer).toBe('0042');
    expect(az!.normalisiert).toBe('1225/0042TG01');
    expect(az!.jahr).toBe('2025');
  });

  it('weist einen unmoeglichen Monat zurueck', () => {
    expect(parseAktenzeichen('1326/1800TG01')).toBeNull();
    expect(parseAktenzeichen('0026/1800TG01')).toBeNull();
  });

  it('weist Text ohne Aktenzeichen zurueck', () => {
    expect(parseAktenzeichen('Telekom Deutschland GmbH')).toBeNull();
  });
});

describe('Normalisierung der Schreibweisen aus aktenzeichen.md', () => {
  // Die Tabelle "Haeufige Schreibweisen im Verwendungszweck"
  const faelle: Array<[string, string]> = [
    ['0126/1800 TG01', '0126/1800TG01'],
    ['0126 / 1800TG01', '0126/1800TG01'],
    ['0126/1800 TG 01', '0126/1800TG01'],
    ['AZ 0126/1800TG01', '0126/1800TG01'],
    ['RE 0126/1800TG01', '0126/1800TG01'],
    ['Zahlung Gutachten 0126/1800TG02 Danke', '0126/1800TG02'],
  ];

  for (const [roh, erwartet] of faelle) {
    it(`normalisiert "${roh}"`, () => {
      const { treffer } = extrahiereAusVerwendungszweck(roh, '2026-01-15');
      expect(treffer).toHaveLength(1);
      expect(treffer[0]!.normalisiert).toBe(erwartet);
    });
  }
});

describe('extrahiereAusVerwendungszweck', () => {
  it('ergaenzt fehlendes MMYY aus dem Buchungsdatum', () => {
    const { treffer } = extrahiereAusVerwendungszweck('1800TG01', '2026-01-15');
    expect(treffer[0]!.normalisiert).toBe('0126/1800TG01');
  });

  it('ergaenzt MMYY auch fuer Dezember korrekt', () => {
    const { treffer } = extrahiereAusVerwendungszweck('0042TG01', '2025-12-03');
    expect(treffer[0]!.normalisiert).toBe('1225/0042TG01');
  });

  it('erkennt zwei Aktenzeichen in einer Sammelzahlung', () => {
    const { treffer } = extrahiereAusVerwendungszweck(
      'RE 0126/1800TG01 und 0126/1800TG02',
      '2026-02-02',
    );
    expect(treffer.map((t) => t.normalisiert)).toEqual([
      '0126/1800TG01',
      '0126/1800TG02',
    ]);
  });

  it('meldet "Rechnung 1800/26" als mehrdeutig statt zu raten', () => {
    const ergebnis = extrahiereAusVerwendungszweck('Rechnung 1800/26', '2026-01-15');
    expect(ergebnis.treffer).toHaveLength(0);
    expect(ergebnis.mehrdeutig).toBe(true);
  });

  it('markiert eine Sammelueberweisung ohne Aktenzeichen nicht als mehrdeutig', () => {
    const ergebnis = extrahiereAusVerwendungszweck(
      'Sammelueberweisung Allianz Versicherung',
      '2026-01-15',
    );
    expect(ergebnis.treffer).toHaveLength(0);
    expect(ergebnis.mehrdeutig).toBe(false);
  });

  it('zaehlt ein vollstaendiges Aktenzeichen nicht doppelt', () => {
    // Der Rumpf "1800TG01" darf nach dem Volltreffer nicht erneut matchen.
    const { treffer } = extrahiereAusVerwendungszweck('0126/1800TG01', '2026-01-15');
    expect(treffer).toHaveLength(1);
  });

  it('normalisiert einstelligen Rechnungsindex auf zwei Stellen', () => {
    const { treffer } = extrahiereAusVerwendungszweck('0126/1800TG1', '2026-01-15');
    expect(treffer[0]!.normalisiert).toBe('0126/1800TG01');
  });
});

describe('erzeugeVarianten', () => {
  it('liefert die Retry-Kette in der dokumentierten Reihenfolge', () => {
    const az = parseAktenzeichen('0126/1800TG01')!;
    expect(erzeugeVarianten(az)).toEqual([
      '0126/1800TG01', // wie erkannt
      '1225/1800TG01', // Vormonat - Buchung bis 30 Tage nach Rechnung
      '0126/1800TG02', // anderer Rechnungsindex
      '1225/1800TG02', // beides kombiniert
    ]);
  });

  it('rechnet den Jahreswechsel korrekt zurueck', () => {
    const az = parseAktenzeichen('0126/1800TG01')!;
    expect(erzeugeVarianten(az)[1]).toBe('1225/1800TG01');
  });

  it('erzeugt keine Duplikate', () => {
    const az = parseAktenzeichen('0626/1811TG01')!;
    const varianten = erzeugeVarianten(az);
    expect(new Set(varianten).size).toBe(varianten.length);
  });
});

describe('Dateinamens-Praefixe fuer die OneDrive-Suche', () => {
  it('bildet die Basis ohne Rechnungsindex ab (so sucht der n8n-Workflow)', () => {
    const az = parseAktenzeichen('0126/1800TG01')!;
    expect(dateiPraefix(az)).toBe('0126_1800TG');
  });

  it('bildet die praezise Form mit Index ab (trennt TG01 von TG02)', () => {
    const az = parseAktenzeichen('0126/1800TG01')!;
    expect(dateiPraefixMitIndex(az)).toBe('0126_1800TG01');
  });
});
