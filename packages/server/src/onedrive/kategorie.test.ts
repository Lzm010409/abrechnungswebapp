import { describe, expect, it } from 'vitest';
import type { Position } from '@abrechnung/shared';
import { bestimmeOrdner, istTankbeleg } from './kategorie.js';

function pos(teil: Partial<Position> = {}): Position {
  return {
    id: 'tx-1',
    datum: '2026-06-02',
    betrag: -62.4,
    waehrung: 'EUR',
    verwendungszweck: '',
    typ: 'AUSGANG',
    sevdeskStatus: 'verknuepft',
    dateien: [],
    status: 'ok',
    manuellBestaetigt: false,
    ...teil,
  };
}

describe('istTankbeleg', () => {
  it('erkennt bekannte Marken im Verwendungszweck', () => {
    for (const zweck of [
      'ARAL TANKSTELLE 12345 OLDENBURG',
      'Shell Deutschland Oil GmbH',
      'ESSO STATION 4711',
      'TotalEnergies Marketing',
    ]) {
      expect(istTankbeleg(pos({ verwendungszweck: zweck })), zweck).toBe(true);
    }
  });

  it('erkennt den Zweck auch ohne Marke', () => {
    expect(istTankbeleg(pos({ verwendungszweck: 'Kraftstoff Diesel' }))).toBe(true);
    expect(istTankbeleg(pos({ verwendungszweck: 'Autohof Rasthof Nord' }))).toBe(true);
  });

  it('nimmt den Aussteller aus der KI-Extraktion', () => {
    expect(
      istTankbeleg(pos({ extraktion: { aussteller: 'Aral AG' } })),
    ).toBe(true);
  });

  it('nimmt auch den Dateinamen des Belegs', () => {
    expect(
      istTankbeleg(
        pos({
          dateien: [
            { id: 'd', dateiname: 'Tankquittung_Juni.pdf', groesse: 1, mimeType: 'application/pdf', quelle: 'manuell' },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('zaehlt Ladestrom mit - fuer die Ablage ist das dasselbe', () => {
    expect(istTankbeleg(pos({ verwendungszweck: 'EnBW mobility+ Ladevorgang' }))).toBe(true);
  });

  it('haelt sich bei allem anderen zurueck', () => {
    for (const zweck of [
      'Telekom Deutschland GmbH',
      'Miete Buero Juni',
      'IMRE 0724/1279TG KR O 68',
      '',
    ]) {
      expect(istTankbeleg(pos({ verwendungszweck: zweck })), zweck).toBe(false);
    }
  });

  it('schliesst nicht vom Betrag auf den Zweck', () => {
    // 62,40 sieht nach einer Tankfuellung aus - ist aber kein Beleg dafuer.
    expect(istTankbeleg(pos({ betrag: -62.4 }))).toBe(false);
  });
});

describe('bestimmeOrdner', () => {
  it('legt alles auf dem Kontoauszug nach Konto', () => {
    expect(bestimmeOrdner(pos({ verwendungszweck: 'Telekom' }), true)).toBe('Konto');
  });

  it('legt auch eine Kartenzahlung an der Tankstelle nach Konto', () => {
    // Sie steht auf dem Auszug - Tanken meint die bar bezahlten Belege.
    expect(bestimmeOrdner(pos({ verwendungszweck: 'ARAL TANKSTELLE' }), true)).toBe('Konto');
  });

  it('legt einen Tankbeleg ohne Kontobezug nach Tanken', () => {
    expect(bestimmeOrdner(pos({ verwendungszweck: 'ARAL TANKSTELLE' }), false)).toBe('Tanken');
  });

  it('legt alles Uebrige nach Bar', () => {
    expect(bestimmeOrdner(pos({ verwendungszweck: 'Buerobedarf' }), false)).toBe('Bar');
  });
});
