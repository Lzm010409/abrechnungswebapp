import { describe, expect, it } from 'vitest';
import type { AblageEintrag, OneDriveDatei } from '@abrechnung/shared';
import type { Abdruck } from './abdruck.js';
import { betragsMuster, gleicheAb, type BelegMitAbdruck, type DateiMitAbdruck } from './abgleich.js';

/**
 * Der Abgleich entscheidet, ob ein Beleg verschoben oder als Kopie hochgeladen
 * wird. Er darf lieber zu wenig zuordnen als falsch: eine Kopie zu viel sieht
 * man, eine falsch einsortierte Datei nicht.
 */

const abdruck = (teil: Partial<Abdruck> = {}): Abdruck => ({
  groesse: 100,
  sha256: 'sha-standard',
  bilder: [],
  ...teil,
});

function beleg(
  dateiId: string,
  teil: Partial<AblageEintrag> = {},
  ab?: Partial<Abdruck>,
): BelegMitAbdruck {
  return {
    eintrag: {
      positionId: `p-${dateiId}`,
      dateiId,
      dateiname: `beleg-${dateiId}.pdf`,
      ordner: 'Konto',
      begruendung: 'Test',
      ...teil,
    },
    ...(ab ? { abdruck: abdruck({ sha256: `sha-${dateiId}`, ...ab }) } : {}),
  };
}

function datei(
  id: string,
  teil: Partial<OneDriveDatei> = {},
  ab?: Partial<Abdruck>,
): DateiMitAbdruck {
  return {
    datei: { id, dateiname: `${id}.pdf`, ...teil },
    ...(ab ? { abdruck: abdruck({ sha256: `sha-${id}`, ...ab }) } : {}),
  };
}

describe('gleicheAb', () => {
  it('erkennt die byteweise gleiche Datei', async () => {
    const { zugeordnet, uebrig, stufen } = gleicheAb(
      [beleg('a', {}, { sha256: 'gleich' })],
      [datei('od-1', {}, { sha256: 'gleich' })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'bytes' });
    expect(zugeordnet[0]!.quelle?.id).toBe('od-1');
    expect(uebrig).toHaveLength(0);
    expect(stufen.bytes).toBe(1);
  });

  it('erkennt denselben Beleg an den eingebetteten Bildern', async () => {
    // Der Regelfall bei Scans: sevDesk gibt die Seiten heraus, die Anwendung
    // setzt sie zusammen - die Datei ist danach eine andere.
    const { zugeordnet } = gleicheAb(
      [beleg('a', {}, { sha256: 'neu-zusammengesetzt', bilder: ['b1', 'b2'] })],
      [datei('od-1', {}, { sha256: 'original', bilder: ['b1', 'b2'] })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'bilder' });
  });

  it('erkennt eine Seite, die im zusammengefassten Beleg steckt', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', {}, { bilder: ['b1', 'b2', 'b3'] })],
      [datei('od-1', {}, { bilder: ['b2'] })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'bilder-teil' });
  });

  it('erkennt eine neu erzeugte Rechnung am Text', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', {}, { textHash: 't1' })],
      [datei('od-1', {}, { textHash: 't1' })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'text' });
  });

  it('nimmt den Betrag der Buchung als letzten Anker', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', { betrag: -49.99 }, { textHash: 't-beleg' })],
      [
        datei('od-1', {}, { textHash: 't-eins', text: 'rechnungsbetrag 49,99 eur' }),
        datei('od-2', {}, { textHash: 't-zwei', text: 'rechnungsbetrag 12,00 eur' }),
      ],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'betrag' });
    expect(zugeordnet[0]!.quelle?.id).toBe('od-1');
  });

  it('verwechselt 4,38 nicht mit 14,38', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', { betrag: -4.38 }, {})],
      [datei('od-1', {}, { text: 'endbetrag 14,38 eur' })],
    );

    expect(zugeordnet[0]!.aktion).toBe('hochladen');
  });

  it('raet nicht, wenn der Betrag in zwei Dateien steht', async () => {
    const { zugeordnet, uebrig } = gleicheAb(
      [beleg('a', { betrag: -49.99 }, {})],
      [
        datei('od-1', {}, { text: 'betrag 49,99' }),
        datei('od-2', {}, { text: 'auch 49,99' }),
      ],
    );

    expect(zugeordnet[0]!.aktion).toBe('hochladen');
    expect(uebrig).toHaveLength(2);
  });

  it('raet nicht, wenn eine Datei zu zwei Belegen passt', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', { betrag: -49.99 }, {}), beleg('b', { betrag: -49.99 }, {})],
      [datei('od-1', {}, { text: 'betrag 49,99' })],
    );

    expect(zugeordnet.map((e) => e.aktion)).toEqual(['hochladen', 'hochladen']);
  });

  it('raet nicht bei mehrfach vorkommender Groesse', async () => {
    // Der Grund fuer den Umbau: in einem echten Monatsordner lagen vier
    // verschiedene Rechnungen mit exakt 95370 Bytes.
    const { zugeordnet, uebrig } = gleicheAb(
      [beleg('a', { groesse: 95370 })],
      [
        datei('od-1', { groesse: 95370 }),
        datei('od-2', { groesse: 95370 }),
      ],
    );

    expect(zugeordnet[0]!.aktion).toBe('hochladen');
    expect(uebrig).toHaveLength(2);
  });

  it('laesst die harte Stufe vor der weichen laufen', async () => {
    // Sonst schnappt der Groessentreffer des einen Belegs die Datei weg, die
    // inhaltlich eindeutig zum anderen gehoert.
    const { zugeordnet } = gleicheAb(
      [
        beleg('a', { groesse: 500 }, { sha256: 'x' }),
        beleg('b', { groesse: 500 }, { sha256: 'treffer' }),
      ],
      [datei('od-1', { groesse: 500 }, { sha256: 'treffer' })],
    );

    expect(zugeordnet[1]).toMatchObject({ stufe: 'bytes', quelle: { id: 'od-1' } });
    expect(zugeordnet[0]!.aktion).toBe('hochladen');
  });

  it('vergibt dieselbe Datei nicht zweimal', async () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', { dateiname: 'Doppelt.pdf' }), beleg('b', { dateiname: 'Doppelt.pdf' })],
      [datei('od-1', { dateiname: 'Doppelt.pdf' })],
    );

    expect(zugeordnet.filter((e) => e.aktion === 'verschieben')).toHaveLength(0);
  });

  it('meldet die Dateien, zu denen keine Buchung passt', async () => {
    const { uebrig } = gleicheAb(
      [beleg('a', { dateiname: 'Bekannt.pdf' })],
      [datei('od-1', { dateiname: 'Bekannt.pdf' }), datei('od-2', { dateiname: 'Fremd.pdf' })],
    );

    expect(uebrig.map((d) => d.dateiname)).toEqual(['Fremd.pdf']);
  });

  it('laedt alles hoch, wenn OneDrive nichts liefert', async () => {
    const { zugeordnet } = gleicheAb([beleg('a')], []);
    expect(zugeordnet[0]!.aktion).toBe('hochladen');
  });

  it('kommt ohne Fingerabdruecke aus und faellt auf Name und Groesse zurueck', async () => {
    // Ist der Inhalt nicht zu holen, soll der Abgleich nicht ausfallen.
    const { zugeordnet } = gleicheAb(
      [beleg('a', { dateiname: 'Tankquittung.pdf' })],
      [datei('od-1', { dateiname: 'tankquittung.pdf' })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'name' });
  });
});

describe('betragsMuster', () => {
  it('findet den Betrag mit und ohne Tausenderpunkt', () => {
    const muster = betragsMuster(-1234.5);
    expect(muster.some((m) => m.test('summe 1234,50 eur'))).toBe(true);
    expect(muster.some((m) => m.test('summe 1.234,50 eur'))).toBe(true);
  });

  it('greift nicht in eine laengere Zahl hinein', () => {
    const muster = betragsMuster(-4.38);
    expect(muster.some((m) => m.test('14,38'))).toBe(false);
    expect(muster.some((m) => m.test('4,380'))).toBe(false);
    expect(muster.some((m) => m.test('endbetrag 4,38 eur'))).toBe(true);
  });
});

describe('Dubletten im Monatsordner', () => {
  it('nimmt eine von zwei inhaltsgleichen Dateien, statt zu verzagen', () => {
    /*
     * Im gepruefen Monatsordner lagen zwei Dateien mit demselben Inhalt. Passen
     * beide byteweise auf denselben Beleg, ist die Wahl gleichgueltig - die
     * andere bleibt liegen und faellt in der Vorschau als Dublette auf.
     */
    const { zugeordnet, uebrig } = gleicheAb(
      [beleg('a', {}, { sha256: 'gleich' })],
      [datei('od-2', {}, { sha256: 'gleich' }), datei('od-1', {}, { sha256: 'gleich' })],
    );

    expect(zugeordnet[0]).toMatchObject({ aktion: 'verschieben', stufe: 'bytes' });
    expect(zugeordnet[0]!.quelle?.id).toBe('od-1');
    expect(uebrig.map((d) => d.id)).toEqual(['od-2']);
  });

  it('bleibt bei derselben Wahl, egal wie OneDrive sortiert', () => {
    const eins = gleicheAb(
      [beleg('a', {}, { sha256: 'gleich' })],
      [datei('od-1', {}, { sha256: 'gleich' }), datei('od-2', {}, { sha256: 'gleich' })],
    );
    const zwei = gleicheAb(
      [beleg('a', {}, { sha256: 'gleich' })],
      [datei('od-2', {}, { sha256: 'gleich' }), datei('od-1', {}, { sha256: 'gleich' })],
    );

    expect(eins.zugeordnet[0]!.quelle?.id).toBe(zwei.zugeordnet[0]!.quelle?.id);
  });

  it('gibt eine Datei nicht an zwei Belege - auch nicht bei Byte-Gleichheit', () => {
    const { zugeordnet } = gleicheAb(
      [beleg('a', {}, { sha256: 'gleich' }), beleg('b', {}, { sha256: 'gleich' })],
      [datei('od-1', {}, { sha256: 'gleich' })],
    );

    expect(zugeordnet.map((e) => e.aktion)).toEqual(['hochladen', 'hochladen']);
  });
});
