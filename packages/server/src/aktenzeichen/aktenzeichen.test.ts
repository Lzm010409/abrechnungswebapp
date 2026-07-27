import { describe, expect, it } from 'vitest';
import {
  dateiPraefix,
  dateiPraefixMitIndex,
  erzeugeVarianten,
  extrahiereAusVerwendungszweck,
  parseAktenzeichen,
  workflowEingabe,
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
  it('variiert nur den Monat - der Index ist fuer die Suche belanglos', () => {
    // Der Workflow verwirft den Index und sucht ueber das Aktenzeichen.
    // Ueber TG01/TG02 zu iterieren waere derselbe Aufruf zweimal.
    const az = parseAktenzeichen('0126/1800TG01')!;
    expect(erzeugeVarianten(az)).toEqual([
      '0126/1800TG01', // wie erkannt
      '1225/1800TG01', // Vormonat - Buchung bis 30 Tage nach Rechnung
    ]);
  });

  it('haengt bei unbekanntem Index "01" an, damit die Workflow-Regex greift', () => {
    const az = parseAktenzeichen('0126/1800TG')!;
    expect(az.rechnungsindex).toBeUndefined();
    expect(erzeugeVarianten(az)).toEqual(['0126/1800TG01', '1225/1800TG01']);
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

describe('Aktenzeichen ohne Rechnungsindex', () => {
  // Regression: im Verwendungszweck steht oft nur der Vorgang, etwa
  // "IMRE 0724/1279TG KR O 68". Frueher verlangte das Muster zwingend einen
  // Index - solche Zahlungen blieben komplett ohne Aktenzeichen.

  it('erkennt das blosse Aktenzeichen im Verwendungszweck', () => {
    const { treffer } = extrahiereAusVerwendungszweck(
      'IMRE 0724/1279TG KR O 68',
      '2026-06-01',
    );
    expect(treffer).toHaveLength(1);
    expect(treffer[0]!.normalisiert).toBe('0724/1279TG');
    expect(treffer[0]!.basis).toBe('0724/1279TG');
    expect(treffer[0]!.rechnungsindex).toBeUndefined();
  });

  it('parst es auch als direkte Eingabe', () => {
    const az = parseAktenzeichen('0124/1234TG')!;
    expect(az.basis).toBe('0124/1234TG');
    expect(az.rechnungsindex).toBeUndefined();
    expect(az.jahr).toBe('2024');
  });

  it('liest den Index weiterhin, wenn er dabeisteht', () => {
    const az = parseAktenzeichen('0124/1234TG03')!;
    expect(az.rechnungsindex).toBe('03');
    expect(az.normalisiert).toBe('0124/1234TG03');
  });

  it('unterscheidet Aktenzeichen und Rechnungsnummer sauber', () => {
    const vorgang = parseAktenzeichen('0124/1234TG')!;
    const rechnung = parseAktenzeichen('0124/1234TG02')!;
    expect(vorgang.basis).toBe(rechnung.basis);
    expect(vorgang.normalisiert).not.toBe(rechnung.normalisiert);
  });

  it('liefert kein Index-Praefix, wenn der Index fehlt', () => {
    expect(dateiPraefixMitIndex(parseAktenzeichen('0124/1234TG')!)).toBeUndefined();
    expect(dateiPraefixMitIndex(parseAktenzeichen('0124/1234TG02')!)).toBe('0124_1234TG02');
  });

  it('sucht in beiden Faellen im selben Ordner', () => {
    expect(dateiPraefix(parseAktenzeichen('0124/1234TG')!)).toBe('0124_1234TG');
    expect(dateiPraefix(parseAktenzeichen('0124/1234TG03')!)).toBe('0124_1234TG');
  });

  it('erzeugt eine fuer den Workflow parsbare Eingabe', () => {
    // Die Workflow-Regex ist /^(\d{4})\/(.*TG)\d+$/ - ohne Ziffern am Ende
    // greift sie nicht.
    const regex = /^(\d{4})\/(.*TG)\d+$/;
    expect(workflowEingabe(parseAktenzeichen('0124/1234TG')!)).toMatch(regex);
    expect(workflowEingabe(parseAktenzeichen('0124/1234TG03')!)).toMatch(regex);
    expect(workflowEingabe(parseAktenzeichen('0124/1234TG03')!)).toBe('0124/1234TG03');
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

  it('normalisiert ein Aktenzeichen mit Leerzeichen und ohne Index', () => {
    const { treffer } = extrahiereAusVerwendungszweck('AZ 0724/1279 TG', '2026-06-01');
    expect(treffer[0]!.normalisiert).toBe('0724/1279TG');
  });
});
