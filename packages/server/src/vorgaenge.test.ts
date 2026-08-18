import { describe, expect, it } from 'vitest';
import { Vorgaenge } from './vorgaenge.js';

/**
 * Der Sinn der Hintergrundvorgaenge ist, dass kein Aufruf mehr auf das Modell
 * wartet. Genau daran ist die Monatspruefung frueher gescheitert: der
 * Reverse-Proxy kappte die Verbindung nach 100 Sekunden ohne Daten.
 */

/** Wartet, bis der Vorgang nicht mehr laeuft. */
async function warte(v: Vorgaenge, id: string) {
  for (let i = 0; i < 200; i++) {
    const stand = v.hole(id)!;
    if (stand.status !== 'laeuft') return stand;
    await new Promise<void>((f) => setTimeout(f, 5));
  }
  throw new Error('Vorgang wurde nicht fertig');
}

const start = { art: 'ki-pruefung', monat: '2026-06', titel: 'Test' } as const;

describe('Vorgaenge', () => {
  it('kehrt sofort zurueck, statt die Arbeit abzuwarten', async () => {
    const v = new Vorgaenge();
    let fertig = false;

    const vorgang = v.starte(start, async () => {
      await new Promise<void>((f) => setTimeout(f, 30));
      fertig = true;
      return 'Ergebnis';
    });

    // Das ist der ganze Punkt: hier wartet niemand.
    expect(vorgang.status).toBe('laeuft');
    expect(fertig).toBe(false);

    expect(await warte(v, vorgang.id)).toMatchObject({
      status: 'fertig',
      ergebnis: 'Ergebnis',
    });
  });

  it('haelt den Fortschritt bereit, einen Stand je Schritt', async () => {
    const v = new Vorgaenge();

    const vorgang = v.starte(start, async (melde) => {
      melde({ phase: 'ki-pruefung', schritt: 'a', text: 'erst' });
      melde({ phase: 'ki-pruefung', schritt: 'b', text: 'zweitens' });
      // Derselbe Schritt erneut - ersetzt den vorigen Stand, statt anzuhaengen.
      melde({ phase: 'ki-pruefung', schritt: 'a', text: 'dann doch anders' });
      return null;
    });

    const fertig = await warte(v, vorgang.id);
    expect(fertig.fortschritt).toHaveLength(2);
    expect(fertig.fortschritt[0]).toMatchObject({ schritt: 'a', text: 'dann doch anders' });
    expect(fertig.fortschritt[1]).toMatchObject({ schritt: 'b' });
  });

  it('haelt einen Fehler als Zustand fest, statt ihn zu verschlucken', async () => {
    const v = new Vorgaenge();

    const vorgang = v.starte(start, async () => {
      throw new Error('Modell nicht erreichbar');
    });

    expect(await warte(v, vorgang.id)).toMatchObject({
      status: 'fehler',
      fehler: 'Modell nicht erreichbar',
    });
  });

  it('filtert nach Monat und sortiert neueste zuerst', async () => {
    const v = new Vorgaenge();
    v.starte({ ...start, monat: '2026-05' }, async () => null);
    const juni = v.starte({ ...start, monat: '2026-06' }, async () => null);

    expect(v.alle('2026-06').map((x) => x.id)).toEqual([juni.id]);
    expect(v.alle()).toHaveLength(2);
  });

  it('vergisst einen abgeschlossenen Vorgang, aber keinen laufenden', async () => {
    const v = new Vorgaenge();

    const laeuft = v.starte(start, () => new Promise(() => undefined));
    // Einen laufenden zu entfernen wuerde ihn nicht anhalten, nur unsichtbar
    // machen - das waere schlimmer als ihn stehen zu lassen.
    expect(v.entferne(laeuft.id)).toBe(false);
    expect(v.hole(laeuft.id)).toBeDefined();

    const fertig = v.starte(start, async () => null);
    await warte(v, fertig.id);
    expect(v.entferne(fertig.id)).toBe(true);
    expect(v.hole(fertig.id)).toBeUndefined();
  });
});
