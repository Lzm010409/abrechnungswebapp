import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baueApp } from './app.js';
import type { Config } from './config.js';
import type { Datenbank } from './db/index.js';
import { starteMockSevDesk, type MockSevDesk } from './testhilfen/mockSevdesk.js';

/**
 * Auslieferung des gebauten Frontends.
 *
 * Hintergrund: nach einem Deploy hielt der Browser noch die alte index.html und
 * forderte damit Dateinamen an, die es nicht mehr gab. Der SPA-Rueckfall
 * antwortete darauf mit der index.html - also HTML statt JavaScript, was der
 * Browser mit "Expected a JavaScript-or-Wasm module script" quittierte. Die
 * Anwendung startete nicht mehr, und die Fehlermeldung verwies auf die falsche
 * Ursache.
 */

describe('Auslieferung des Frontends', () => {
  let app: FastifyInstance;
  let db: Datenbank;
  let sevdesk: MockSevDesk;
  let dataDir: string;
  let webDist: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'abrechnung-web-'));
    webDist = mkdtempSync(join(tmpdir(), 'abrechnung-dist-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(
      join(webDist, 'index.html'),
      '<!doctype html><script type="module" src="/assets/index-NEU.js"></script>',
    );
    writeFileSync(join(webDist, 'assets', 'index-NEU.js'), 'console.log(1)');

    sevdesk = await starteMockSevDesk({
      checkAccounts: [
        {
          id: 'konto-1', objectName: 'CheckAccount', name: 'Konto',
          type: 'online', status: '100', currency: 'EUR',
        },
      ],
      transaktionen: [], vouchers: [], invoices: [],
      voucherTransaktionen: {}, invoiceTransaktionen: {},
      voucherDateien: {}, invoicePdfs: {},
    });

    const config: Config = {
      port: 0,
      logLevel: 'silent',
      dataDir,
      webDist,
      sevdesk: { token: 't', baseUrl: sevdesk.url },
      auth: { deaktiviert: true, sicher: false, sessionDauer: 3600 },
    };
    const instanz = await baueApp(config);
    app = instanz.app;
    db = instanz.db;
  });

  afterEach(async () => {
    await app?.close();
    db?.schliesse();
    await sevdesk?.schliesse();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(webDist, { recursive: true, force: true });
  });

  it('liefert die index.html aus', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('liefert eine vorhandene Datei mit ihrem eigenen Typ aus', async () => {
    const res = await app.inject({ url: '/assets/index-NEU.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('antwortet auf eine Datei aus einem alten Build mit 404, nicht mit HTML', async () => {
    // Genau der Fall aus der Produktion: der Browser hielt die alte index.html.
    const res = await app.inject({ url: '/assets/index-ALT.css' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
  });

  it('gibt auch fuer andere Dateiendungen kein HTML zurueck', async () => {
    for (const pfad of ['/logo.png', '/irgendwas.js', '/style.css', '/x.woff2']) {
      const res = await app.inject({ url: pfad });
      expect(res.statusCode, pfad).toBe(404);
      expect(res.headers['content-type'], pfad).not.toContain('text/html');
    }
  });

  it('faellt fuer Routen des Frontends weiterhin auf die index.html zurueck', async () => {
    const res = await app.inject({ url: '/monat/2026-06' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('laesst die index.html nicht im Browser-Cache liegen', async () => {
    // Der eigentliche Schutz: nach einem Deploy holt der Browser sie neu und
    // erfaehrt so von den neuen Dateinamen.
    for (const pfad of ['/', '/monat/2026-06']) {
      const res = await app.inject({ url: pfad });
      expect(String(res.headers['cache-control']), pfad).toContain('no-store');
    }
  });

  it('laesst die gehashten Dateien dauerhaft im Cache liegen', async () => {
    const res = await app.inject({ url: '/assets/index-NEU.js' });
    expect(String(res.headers['cache-control'])).toContain('immutable');
  });

  it('beantwortet unbekannte API-Pfade weiterhin als JSON', async () => {
    const res = await app.inject({ url: '/api/gibtsnicht' });
    expect(res.statusCode).toBe(404);
    expect(res.json().fehler).toBeTruthy();
  });
});
