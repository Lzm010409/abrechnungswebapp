import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kontoauszug, Monat, Position } from '@abrechnung/shared';
import type { Datenbank } from './index.js';
import { bereiteTestDatenbankVor, legeTestDatenbankAn } from '../testhilfen/datenbank.js';

/**
 * Die Zugriffsschicht auf Postgres.
 *
 * Geprueft wird gegen eine echte, in den Prozess eingebettete Postgres - nicht
 * gegen eine Nachbildung. Was hier gruen ist, ist damit auch in der Datenbank
 * des Betriebs gruen.
 */
describe('Datenbank', () => {
  // Der Aufbau der eingebetteten Datenbank dauert einige Sekunden und gehoert
  // deshalb nicht in die Zeitvorgabe des ersten Tests.
  beforeAll(bereiteTestDatenbankVor, 60_000);

  let db: Datenbank;

  beforeEach(async () => {
    db = await legeTestDatenbankAn();
  });

  afterEach(async () => {
    await db.schliesse();
  });

  const monat = (name = '2026-06'): Monat => ({
    monat: name,
    checkAccountId: 'konto-1',
    positionen: [],
    summen: {
      anzahlGesamt: 0,
      anzahlOffen: 0,
      anzahlMehrdeutig: 0,
      anzahlNichtZugeordnet: 0,
      anzahlFertig: 0,
      summeEingang: 0,
      summeAusgang: 0,
    } as Monat['summen'],
    verwaisteBelege: [],
    kontoauszuege: [],
    synchronisiertAm: '2026-06-30T12:00:00.000Z',
  });

  // -- Monatscache ----------------------------------------------------------

  describe('Monatscache', () => {
    it('gibt fuer einen unbekannten Monat null zurueck', async () => {
      expect(await db.ladeMonat('2026-01')).toBeNull();
    });

    it('speichert und liest einen Monat unveraendert', async () => {
      await db.speichereMonat(monat());
      expect(await db.ladeMonat('2026-06')).toEqual(monat());
    });

    it('ueberschreibt beim zweiten Speichern, statt zu verdoppeln', async () => {
      await db.speichereMonat(monat());
      await db.speichereMonat({ ...monat(), checkAccountName: 'Geschaeftskonto' });

      const geladen = await db.ladeMonat('2026-06');
      expect(geladen?.checkAccountName).toBe('Geschaeftskonto');
    });

    it('loescht einen Monat', async () => {
      await db.speichereMonat(monat());
      await db.loescheMonat('2026-06');
      expect(await db.ladeMonat('2026-06')).toBeNull();
    });
  });

  // -- Manuelle Korrekturen -------------------------------------------------

  describe('Manuelle Korrekturen', () => {
    it('liefert eine leere Karte, solange nichts korrigiert wurde', async () => {
      expect(await db.ladeOverrides('2026-06')).toEqual(new Map());
    });

    it('haelt Korrekturen je Monat und Buchung auseinander', async () => {
      await db.speichereOverride('2026-06', 'p1', { markierung: 'gruen' } as Partial<Position>);
      await db.speichereOverride('2026-07', 'p1', { markierung: 'rot' } as Partial<Position>);

      expect((await db.ladeOverrides('2026-06')).get('p1')).toEqual({ markierung: 'gruen' });
      expect((await db.ladeOverrides('2026-07')).get('p1')).toEqual({ markierung: 'rot' });
    });

    it('fuehrt zwei getrennte Korrekturen zusammen, statt die erste zu verlieren', async () => {
      await db.speichereOverride('2026-06', 'p1', { markierung: 'gruen' } as Partial<Position>);
      await db.speichereOverride('2026-06', 'p1', { status: 'fertig' } as Partial<Position>);

      expect((await db.ladeOverrides('2026-06')).get('p1')).toEqual({
        markierung: 'gruen',
        status: 'fertig',
      });
    });

    it('nimmt ein Feld zurueck, wenn es ausdruecklich auf undefined gesetzt wird', async () => {
      // So setzt die Anwendung ein Aktenzeichen zurueck: das Feld faellt aus
      // dem gespeicherten Patch heraus, damit wieder der sevDesk-Stand gilt.
      await db.speichereOverride('2026-06', 'p1', {
        markierung: 'gruen',
        status: 'fertig',
      } as Partial<Position>);
      await db.speichereOverride('2026-06', 'p1', {
        markierung: undefined,
      } as Partial<Position>);

      expect((await db.ladeOverrides('2026-06')).get('p1')).toEqual({ status: 'fertig' });
    });

    it('loescht eine einzelne Korrektur', async () => {
      await db.speichereOverride('2026-06', 'p1', { markierung: 'gruen' } as Partial<Position>);
      await db.loescheOverride('2026-06', 'p1');
      expect((await db.ladeOverrides('2026-06')).has('p1')).toBe(false);
    });

    it('behaelt die Korrekturen, wenn der Monatscache verworfen wird', async () => {
      // Der wichtigste Fall ueberhaupt: `monate` ist Zwischenspeicher, die
      // Korrekturen sind die Arbeit des Nutzers und duerfen nicht mitgehen.
      await db.speichereMonat(monat());
      await db.speichereOverride('2026-06', 'p1', { markierung: 'gruen' } as Partial<Position>);

      await db.loescheMonat('2026-06');

      expect((await db.ladeOverrides('2026-06')).get('p1')).toEqual({ markierung: 'gruen' });
    });
  });

  // -- Kontoauszuege --------------------------------------------------------

  describe('Kontoauszuege', () => {
    const auszug = (id: string, name: string): Kontoauszug => ({
      id,
      dateiname: name,
      groesse: 1234,
      seiten: 3,
      hochgeladenAm: '2026-06-30T12:00:00.000Z',
    });

    it('gibt die Auszuege in der Reihenfolge des Hochladens zurueck', async () => {
      await db.speichereKontoauszug('2026-06', auszug('a', 'Erster.pdf'));
      await db.speichereKontoauszug('2026-06', auszug('b', 'Zweiter.pdf'));
      await db.speichereKontoauszug('2026-06', auszug('c', 'Dritter.pdf'));

      expect((await db.ladeKontoauszuege('2026-06')).map((a) => a.id)).toEqual(['a', 'b', 'c']);
    });

    it('gibt den Zeitpunkt als ISO-Zeichenkette zurueck', async () => {
      await db.speichereKontoauszug('2026-06', auszug('a', 'Erster.pdf'));
      expect((await db.ladeKontoauszuege('2026-06'))[0]).toEqual(auszug('a', 'Erster.pdf'));
    });

    it('laesst die Seitenzahl weg, wenn sie unbekannt ist', async () => {
      const ohne = { ...auszug('a', 'Erster.pdf'), seiten: undefined };
      await db.speichereKontoauszug('2026-06', ohne);
      expect((await db.ladeKontoauszuege('2026-06'))[0]).not.toHaveProperty('seiten');
    });

    it('behaelt beim erneuten Hochladen derselben Datei ihren Platz', async () => {
      await db.speichereKontoauszug('2026-06', auszug('a', 'Erster.pdf'));
      await db.speichereKontoauszug('2026-06', auszug('b', 'Zweiter.pdf'));
      await db.ordneKontoauszuege('2026-06', ['b', 'a']);

      await db.speichereKontoauszug('2026-06', { ...auszug('a', 'Neuer Name.pdf') });

      const geladen = await db.ladeKontoauszuege('2026-06');
      expect(geladen.map((a) => a.id)).toEqual(['b', 'a']);
      expect(geladen[1]?.dateiname).toBe('Neuer Name.pdf');
    });

    it('setzt die Reihenfolge neu', async () => {
      await db.speichereKontoauszug('2026-06', auszug('a', 'Erster.pdf'));
      await db.speichereKontoauszug('2026-06', auszug('b', 'Zweiter.pdf'));
      await db.speichereKontoauszug('2026-06', auszug('c', 'Dritter.pdf'));

      await db.ordneKontoauszuege('2026-06', ['c', 'a', 'b']);

      expect((await db.ladeKontoauszuege('2026-06')).map((a) => a.id)).toEqual(['c', 'a', 'b']);
    });

    it('loescht einen Auszug nur im angegebenen Monat', async () => {
      await db.speichereKontoauszug('2026-06', auszug('a', 'Erster.pdf'));
      await db.loescheKontoauszug('2026-07', 'a');
      expect(await db.ladeKontoauszuege('2026-06')).toHaveLength(1);

      await db.loescheKontoauszug('2026-06', 'a');
      expect(await db.ladeKontoauszuege('2026-06')).toHaveLength(0);
    });

    it('weist einen unbrauchbaren Zeitstempel deutlich zurueck', async () => {
      await expect(
        db.speichereKontoauszug('2026-06', { ...auszug('a', 'x.pdf'), hochgeladenAm: 'gestern' }),
      ).rejects.toThrow(/hochgeladenAm/);
    });
  });

  // -- KI-Ergebnisse --------------------------------------------------------

  describe('KI-Ergebnisse', () => {
    it('speichert und liest eine Belegextraktion', async () => {
      expect(await db.ladeExtraktion('datei-1')).toBeNull();

      await db.speichereExtraktion('datei-1', { betrag: 12.5, waehrung: 'EUR' });
      expect(await db.ladeExtraktion('datei-1')).toEqual({ betrag: 12.5, waehrung: 'EUR' });
    });

    it('ersetzt eine Extraktion, statt sie zu verdoppeln', async () => {
      await db.speichereExtraktion('datei-1', { betrag: 12.5 });
      await db.speichereExtraktion('datei-1', { betrag: 99 });
      expect(await db.ladeExtraktion('datei-1')).toEqual({ betrag: 99 });
    });

    it('speichert und liest eine Monatspruefung', async () => {
      expect(await db.ladeReview('2026-06')).toBeNull();

      await db.speichereReview('2026-06', { zusammenfassung: 'passt', auffaelligkeiten: [] });
      expect(await db.ladeReview('2026-06')).toEqual({
        zusammenfassung: 'passt',
        auffaelligkeiten: [],
      });
    });
  });
});
