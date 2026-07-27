import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BelegDatei } from '@abrechnung/shared';
import { Dateiablage } from './dateien.js';

/**
 * Die Unversehrtheitspruefung entscheidet, ob ein Beleg beim naechsten Laden
 * neu geholt wird. Sie muss zwei Dinge auseinanderhalten: eine Datei, die
 * schlicht ein anderes Format hat als der Name verspricht - und eine, in der
 * gar keine Datei steht.
 */

const PDF = Buffer.from('%PDF-1.4\nInhalt', 'latin1');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

describe('Dateiablage.istUnversehrt', () => {
  let wurzel: string;
  let ablage: Dateiablage;

  beforeEach(() => {
    wurzel = mkdtempSync(join(tmpdir(), 'ablage-'));
    ablage = new Dateiablage(wurzel);
  });

  afterEach(() => rmSync(wurzel, { recursive: true, force: true }));

  const lege = async (daten: Buffer, name: string): Promise<BelegDatei> =>
    ablage.speichere('2026-06', daten, name, 'sevdesk-voucher');

  it('erkennt ein PDF als unversehrt', async () => {
    const datei = await lege(PDF, 'beleg.pdf');
    expect(await ablage.istUnversehrt('2026-06', datei)).toBe(true);
  });

  it('nimmt ein Bild hin, auch wenn es .pdf heisst', async () => {
    /*
     * Genau hier lag der Fehler: sevDesk liefert Belege auch als Bild, der
     * Dateiname ist trotzdem "beleg-123.pdf". Nach der Endung zu urteilen hiess
     * das "kaputt" - und der Beleg wurde bei jedem Laden des Monats erneut
     * geholt, auch beim blossen Setzen einer Markierung.
     */
    const datei = await lege(JPEG, 'beleg-123.pdf');
    expect(await ablage.istUnversehrt('2026-06', datei)).toBe(true);
  });

  it('erkennt base64-Text als unbrauchbar', async () => {
    const datei = await lege(PDF, 'beleg.pdf');
    writeFileSync(await ablage.pfadFuer('2026-06', datei.id), PDF.toString('base64'));
    expect(await ablage.istUnversehrt('2026-06', datei)).toBe(false);
  });

  it('erkennt eine fehlende Datei als unbrauchbar', async () => {
    expect(
      await ablage.istUnversehrt('2026-06', {
        id: 'gibtsnicht.pdf', dateiname: 'x.pdf', groesse: 0,
        mimeType: 'application/pdf', quelle: 'manuell',
      }),
    ).toBe(false);
  });
});
