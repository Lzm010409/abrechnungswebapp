import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BelegDatei } from '@abrechnung/shared';
import type { Datenbank } from '../db/index.js';
import { bereiteTestDatenbankVor, legeTestDatenbankAn } from '../testhilfen/datenbank.js';
import { Dateiablage } from './dateien.js';

/**
 * Die Unversehrtheitspruefung entscheidet, ob ein Beleg beim naechsten Laden
 * neu geholt wird. Sie muss zwei Dinge auseinanderhalten: eine Datei, die
 * schlicht ein anderes Format hat als der Name verspricht - und eine, in der
 * gar keine Datei steht.
 */

const PDF = Buffer.from('%PDF-1.4\nInhalt', 'latin1');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

describe('Dateiablage', () => {
  beforeAll(bereiteTestDatenbankVor, 60_000);

  let wurzel: string;
  let db: Datenbank;
  let ablage: Dateiablage;

  beforeEach(async () => {
    wurzel = mkdtempSync(join(tmpdir(), 'ablage-'));
    db = await legeTestDatenbankAn();
    ablage = new Dateiablage(wurzel, db);
  });

  afterEach(async () => {
    await db.schliesse();
    rmSync(wurzel, { recursive: true, force: true });
  });

  const lege = async (daten: Buffer, name: string): Promise<BelegDatei> =>
    ablage.speichere('2026-06', daten, name, 'sevdesk-voucher');

  describe('Ablegen und Lesen', () => {
    it('gibt zurueck, was abgelegt wurde', async () => {
      const datei = await lege(PDF, 'beleg.pdf');
      expect(await ablage.lese('2026-06', datei.id)).toEqual(PDF);
      expect(await ablage.existiert('2026-06', datei.id)).toBe(true);
    });

    it('vergibt dieselbe ID fuer denselben Inhalt', async () => {
      const a = await lege(PDF, 'beleg.pdf');
      const b = await lege(PDF, 'beleg.pdf');
      expect(b.id).toBe(a.id);
    });

    it('haelt Monate auseinander', async () => {
      const datei = await lege(PDF, 'beleg.pdf');
      expect(await ablage.existiert('2026-07', datei.id)).toBe(false);
    });

    it('loescht in der Datenbank und auf der Platte', async () => {
      const datei = await lege(PDF, 'beleg.pdf');
      await ablage.loesche('2026-06', datei.id);
      expect(await ablage.existiert('2026-06', datei.id)).toBe(false);
    });

    it('liest eine noch nicht uebertragene Datei von der Platte', async () => {
      // Der Zustand zwischen Deploy und Import: die Datei liegt nur dort.
      mkdirSync(join(wurzel, 'monate', '2026-06'), { recursive: true });
      writeFileSync(join(wurzel, 'monate', '2026-06', 'alt.pdf'), PDF);

      expect(await ablage.existiert('2026-06', 'alt.pdf')).toBe(true);
      expect(await ablage.lese('2026-06', 'alt.pdf')).toEqual(PDF);
    });

    it('legt eine Zweitschrift auf der Platte ab, damit ein Rueckweg bleibt', async () => {
      const datei = await lege(PDF, 'beleg.pdf');
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(await ablage.pfadFuer('2026-06', datei.id))).toEqual(PDF);
    });
  });

  describe('istUnversehrt', () => {
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
      await db.speichereDatei('2026-06', datei.id, Buffer.from(PDF.toString('base64')));
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
});
