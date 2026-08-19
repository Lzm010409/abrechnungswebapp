import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  LadeEreignis,
  Monat,
  MonatsStatus,
  Vorgang,
} from '@abrechnung/shared';
import { baueApp } from './app.js';
import type { Config } from './config.js';
import type { Datenbank } from './db/index.js';
import { bereiteTestDatenbankVor, legeTestDatenbankAn } from './testhilfen/datenbank.js';
import {
  starteMockN8n,
  starteMockSevDesk,
  testPdf,
  type MockDaten,
  type MockN8n,
  type MockSevDesk,
} from './testhilfen/mockSevdesk.js';
import type { CheckAccountTransaction } from './sevdesk/types.js';

/**
 * Integrationstest der gesamten Kette:
 *
 *   HTTP-Route -> MonatsDienst -> sevDesk-Client -> Mock-sevDesk
 *                              -> RechnungsProvider -> Mock-n8n
 *                              -> Dateiablage -> SQLite -> PDF
 *
 * Es laeuft die echte Anwendung (baueApp), nur die beiden externen Systeme
 * sind lokale HTTP-Server. Damit wird alles getestet ausser der Frage, ob die
 * echte sevDesk-API dieselben Formate liefert wie der Mock.
 */

const MONAT = '2026-06';

function tx(
  teil: Partial<CheckAccountTransaction> & { id: string; amount: string },
): CheckAccountTransaction {
  return {
    objectName: 'CheckAccountTransaction',
    valueDate: '2026-06-03T00:00:00+02:00',
    status: '200',
    checkAccount: { id: 'konto-1', objectName: 'CheckAccount' },
    ...teil,
  };
}

/** Zerlegt eine Server-Sent-Events-Antwort in die einzelnen Ereignisse. */
function leseEreignisse(rohtext: string): LadeEreignis[] {
  return rohtext
    .split('\n\n')
    .flatMap((block) => block.split('\n'))
    .filter((zeile) => zeile.startsWith('data:'))
    .map((zeile) => JSON.parse(zeile.slice(5).trim()) as LadeEreignis);
}

function basisDaten(): MockDaten {
  return {
    checkAccounts: [
      {
        id: 'konto-1',
        objectName: 'CheckAccount',
        name: 'Geschaeftskonto',
        type: 'online',
        status: '100',
        currency: 'EUR',
        iban: 'DE89370400440532013000',
      },
    ],
    transaktionen: [],
    vouchers: [],
    invoices: [],
    voucherTransaktionen: {},
    invoiceTransaktionen: {},
    voucherDateien: {},
    invoicePdfs: {},
  };
}

describe('End-to-End: gesamte Programmkette', () => {
  // Der Aufbau der eingebetteten Datenbank dauert einige Sekunden und gehoert
  // deshalb nicht in die Zeitvorgabe des ersten Tests.
  beforeAll(bereiteTestDatenbankVor, 60_000);

  let sevdesk: MockSevDesk;
  let n8n: MockN8n;
  let app: FastifyInstance;
  let db: Datenbank;
  let dataDir: string;

  /**
   * Startet einen Hintergrundvorgang und wartet, bis er durch ist.
   *
   * Die Langlaeufer antworten sofort mit 202 und arbeiten weiter - abgefragt
   * wird ueber /api/vorgaenge/:id. Genau so macht es auch die Oberflaeche.
   */
  const fuehreVorgangAus = async (url: string): Promise<Vorgang> => {
    const start = await app.inject({ method: 'POST', url });
    expect(start.statusCode).toBe(202);

    const id = start.json<Vorgang>().id;

    for (let versuch = 0; versuch < 400; versuch++) {
      const stand = (await app.inject({ url: `/api/vorgaenge/${id}` })).json<Vorgang>();
      if (stand.status !== 'laeuft') return stand;
      await new Promise<void>((f) => setTimeout(f, 25));
    }
    throw new Error(`Vorgang ${url} wurde nicht fertig`);
  };

  const starteApp = async (ueberschreibungen: Partial<Config> = {}) => {
    const config: Config = {
      port: 0,
      logLevel: 'silent',
      dataDir,
      // Die Adresse bleibt ungenutzt: der Test haengt unten eine eingebettete
      // Postgres ein, statt eine echte vorauszusetzen.
      datenbankUrl: 'postgres://test/test',
      sevdesk: { token: 'test-token', baseUrl: sevdesk.url },
      n8n: { findRechnungUrl: n8n.url },
      // Die Fachlogik wird ohne Anmeldung geprueft; die Anmeldung selbst hat
      // ihre eigene Testdatei (auth.test.ts).
      auth: { deaktiviert: true, sicher: false, sessionDauer: 3600 },
      ...ueberschreibungen,
    };
    const instanz = await baueApp(config, { db: await legeTestDatenbankAn() });
    app = instanz.app;
    db = instanz.db;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'abrechnung-e2e-'));
    n8n = await starteMockN8n();
  });

  afterEach(async () => {
    await app?.close();
    await db?.schliesse();
    await sevdesk?.schliesse();
    await n8n?.schliesse();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  describe('Start und Bankkonto', () => {
    it('ermittelt das aktive Online-Bankkonto automatisch', async () => {
      sevdesk = await starteMockSevDesk(basisDaten());
      await starteApp();

      const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        sevdesk: true,
        ki: false, // kein ANTHROPIC_API_KEY gesetzt
        n8nRechnungsabruf: true,
        checkAccountId: 'konto-1',
        checkAccountName: 'Geschaeftskonto',
      });
    });

    it('ignoriert archivierte und Offline-Konten bei der Auswahl', async () => {
      const daten = basisDaten();
      daten.checkAccounts.push(
        { id: 'alt', objectName: 'CheckAccount', name: 'Altes Konto', type: 'online', status: '0', currency: 'EUR' },
        { id: 'kasse', objectName: 'CheckAccount', name: 'Kasse', type: 'offline', status: '100', currency: 'EUR' },
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();

      expect((await app.inject({ url: '/api/capabilities' })).json()).toMatchObject({
        checkAccountId: 'konto-1',
      });
    });

    it('bricht mit Kandidatenliste ab, wenn die Auswahl nicht eindeutig ist', async () => {
      const daten = basisDaten();
      daten.checkAccounts.push({
        id: 'konto-2', objectName: 'CheckAccount', name: 'Ruecklagen',
        type: 'online', status: '100', currency: 'EUR', iban: 'DE89370400440532013001',
      });
      sevdesk = await starteMockSevDesk(daten);

      await expect(starteApp()).rejects.toThrow(/Mehrere aktive Bankkonten.*konto-1.*konto-2/s);
      // Damit afterEach nicht ueber undefined stolpert
      app = { close: async () => undefined } as unknown as FastifyInstance;
      db = { schliesse: () => undefined } as unknown as Datenbank;
    });

    it('meldet ein ungueltiges SEVDESK_CHECK_ACCOUNT_ID verstaendlich', async () => {
      sevdesk = await starteMockSevDesk(basisDaten());
      await expect(
        starteApp({
          sevdesk: { token: 't', baseUrl: sevdesk.url, checkAccountId: 'gibtsnicht' },
        }),
      ).rejects.toThrow(/existiert nicht/);
      app = { close: async () => undefined } as unknown as FastifyInstance;
      db = { schliesse: () => undefined } as unknown as Datenbank;
    });
  });

  // -------------------------------------------------------------------------

  describe('Monat laden', () => {
    beforeEach(async () => {
      const daten = basisDaten();

      // AUSGANG mit Beleg in sevDesk
      daten.transaktionen.push(
        tx({
          id: 'tx-aus', amount: '-119.00',
          paymtPurpose: 'Telekom Rechnung', payeePayerName: 'Telekom',
          valueDate: '2026-06-05T00:00:00+02:00',
        }),
      );
      daten.vouchers.push({
        id: 'v-1', objectName: 'Voucher', status: '1000',
        supplierName: 'Telekom Deutschland GmbH', sumGross: '119.00',
      });
      daten.voucherTransaktionen['v-1'] = ['tx-aus'];
      daten.voucherDateien['v-1'] = await testPdf(2);

      // EINGANG mit verknuepfter Rechnung
      daten.transaktionen.push(
        tx({
          id: 'tx-ein', amount: '892.50',
          paymtPurpose: 'Zahlung Gutachten 0626/1811TG01',
          valueDate: '2026-06-03T00:00:00+02:00',
        }),
      );
      daten.invoices.push({
        id: 'inv-1', objectName: 'Invoice', status: '1000',
        invoiceNumber: '0626/1811TG01', sumGross: '892.50',
      });
      daten.invoiceTransaktionen['inv-1'] = ['tx-ein'];

      sevdesk = await starteMockSevDesk(daten);
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1)).toString('base64'), filename: '0626_1811TG01_Rechnung.pdf' },
      ]);
      await starteApp();
    });

    it('baut beide Positionen mit Beleg auf', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();

      expect(monat.positionen).toHaveLength(2);

      const aus = monat.positionen.find((p) => p.id === 'tx-aus')!;
      expect(aus.typ).toBe('AUSGANG');
      expect(aus.voucherId).toBe('v-1');
      expect(aus.dateien).toHaveLength(1);
      expect(aus.dateien[0]!.quelle).toBe('sevdesk-voucher');
      expect(aus.status).toBe('ok');

      const ein = monat.positionen.find((p) => p.id === 'tx-ein')!;
      expect(ein.typ).toBe('EINGANG');
      expect(ein.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
      expect(ein.aktenzeichen!.herkunft).toBe('sevdesk-invoice');
      expect(ein.dateien[0]!.quelle).toBe('onedrive-n8n');
      expect(ein.status).toBe('ok');
    });

    it('berechnet die Summen korrekt', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.summen).toMatchObject({
        einnahmen: 892.5,
        ausgaben: 119,
        saldo: 773.5,
        anzahlGesamt: 2,
        anzahlOk: 2,
        anzahlOffen: 0,
        anzahlNichtZugeordnet: 0,
      });
    });

    it('sortiert die Positionen nach Datum', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen.map((p) => p.id)).toEqual(['tx-ein', 'tx-aus']);
    });

    it('liefert die Belegdatei ueber die Datei-Route aus', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const dateiId = monat.positionen.find((p) => p.id === 'tx-aus')!.dateien[0]!.id;

      const res = await app.inject({ url: `/api/months/${MONAT}/files/${dateiId}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('holt beim zweiten Aufruf aus dem Cache statt erneut aus sevDesk', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const nachErstem = sevdesk.aufrufe.length;

      await app.inject({ url: `/api/months/${MONAT}` });
      expect(sevdesk.aufrufe.length).toBe(nachErstem);
    });

    it('laedt bei ?refresh=true erneut aus sevDesk', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const nachErstem = sevdesk.aufrufe.length;

      await app.inject({ url: `/api/months/${MONAT}?refresh=true` });
      expect(sevdesk.aufrufe.length).toBeGreaterThan(nachErstem);
    });

    it('weist einen ungueltigen Monatsparameter ab', async () => {
      const res = await app.inject({ url: '/api/months/Juni-2026' });
      expect(res.statusCode).toBe(400);
      expect(res.json().fehler).toContain('YYYY-MM');
    });

    it('filtert Buchungen fremder Konten heraus', async () => {
      sevdesk.daten.transaktionen.push(
        tx({
          id: 'tx-fremd', amount: '500.00',
          checkAccount: { id: 'konto-2', objectName: 'CheckAccount' },
        }),
      );
      const monat = (
        await app.inject({ url: `/api/months/${MONAT}?refresh=true` })
      ).json<Monat>();
      expect(monat.positionen.map((p) => p.id)).not.toContain('tx-fremd');
    });

    it('haelt Buchungen ausserhalb des Monats heraus', async () => {
      sevdesk.daten.transaktionen.push(
        tx({ id: 'tx-mai', amount: '100.00', valueDate: '2026-05-30T00:00:00+02:00' }),
        tx({ id: 'tx-juli', amount: '100.00', valueDate: '2026-07-01T00:00:00+02:00' }),
      );
      const monat = (
        await app.inject({ url: `/api/months/${MONAT}?refresh=true` })
      ).json<Monat>();
      const ids = monat.positionen.map((p) => p.id);
      expect(ids).not.toContain('tx-mai');
      expect(ids).not.toContain('tx-juli');
    });
  });

  // -------------------------------------------------------------------------

  describe('Verlorene Belegdateien', () => {
    /*
     * Aufgetreten in der Produktion: die Datenbank kannte einen Beleg, das
     * Datenverzeichnis nicht mehr - die Oberflaeche zeigte statt des Belegs
     * "ENOENT: no such file or directory". Ursache war ein nicht dauerhaft
     * eingebundenes Datenverzeichnis; die Anwendung muss sich davon erholen.
     */

    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({
          id: 'tx-aus', amount: '-119.00', paymtPurpose: 'Telekom',
          valueDate: '2026-06-05T00:00:00+02:00',
        }),
      );
      daten.vouchers.push({
        id: 'v-1', objectName: 'Voucher', status: '1000',
        supplierName: 'Telekom', sumGross: '119.00',
      });
      daten.voucherTransaktionen['v-1'] = ['tx-aus'];
      daten.voucherDateien['v-1'] = await testPdf(2);

      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    /**
     * Laesst die Belegdateien des Monats verschwinden - in der Datenbank wie
     * auf der Platte. Beides ist noetig: die Datei liegt seit dem Umzug in der
     * Datenbank, die Platte traegt nur noch eine Zweitschrift.
     */
    const loescheDateien = async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      for (const position of monat.positionen) {
        for (const datei of [...position.dateien, ...(position.kandidaten ?? [])]) {
          await db.loescheDatei(MONAT, datei.id);
        }
      }
      rmSync(join(dataDir, 'monate', MONAT), { recursive: true, force: true });
    };

    it('holt eine verschwundene Datei beim naechsten Laden neu', async () => {
      const vorher = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(vorher.positionen[0]!.dateien).toHaveLength(1);

      await loescheDateien();

      const nachher = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(nachher.positionen[0]!.dateien).toHaveLength(1);
      expect(nachher.positionen[0]!.status).toBe('ok');

      // Und die Datei ist wieder abrufbar - darum ging es.
      const res = await app.inject({
        url: `/api/months/${MONAT}/files/${nachher.positionen[0]!.dateien[0]!.id}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('laesst den Zwischenspeicher in Ruhe, solange alles da ist', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const nachErstem = sevdesk.aufrufe.length;

      await app.inject({ url: `/api/months/${MONAT}` });
      expect(sevdesk.aufrufe.length).toBe(nachErstem);
    });

    it('sagt deutlich, wenn die Datei weg und nicht wiederbeschaffbar ist', async () => {
      await loescheDateien();
      // sevDesk liefert den Beleg nicht mehr aus.
      sevdesk.daten.voucherDateien = {};

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen[0]!.dateien).toHaveLength(0);
      expect(monat.positionen[0]!.status).toBe('offen');
      expect(monat.positionen[0]!.hinweis).toBeTruthy();
    });

    it('ersetzt eine unbrauchbar gespeicherte Datei', async () => {
      // Der zweite Produktionsfall: die Datei war da, enthielt aber base64-Text
      // statt eines PDF - herunterladbar, aber nicht zu oeffnen.
      const vorher = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const dateiId = vorher.positionen[0]!.dateien[0]!.id;
      await db.speichereDatei(
        MONAT,
        dateiId,
        Buffer.from((await testPdf(1)).toString('base64')),
      );

      const nachher = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const res = await app.inject({
        url: `/api/months/${MONAT}/files/${nachher.positionen[0]!.dateien[0]!.id}`,
      });
      expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('beantwortet eine fehlende Datei mit 404 statt mit einem Serverfehler', async () => {
      const res = await app.inject({
        url: `/api/months/${MONAT}/files/gibtsnicht.pdf`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().fehler).toContain('Datenverzeichnis');
      // Der rohe Systemfehler hat in der Oberflaeche nichts zu suchen.
      expect(res.json().fehler).not.toContain('ENOENT');
    });
  });

  // -------------------------------------------------------------------------

  describe('Buchungen ohne Belegpflicht', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-privat', amount: '-800.00', paymtPurpose: 'Privatentnahme' }),
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('macht eine markierte Buchung gruen und haelt sie in der Abrechnung', async () => {
      let monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen[0]!.status).toBe('offen');

      monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-privat`,
          payload: { markierung: 'privatentnahme' },
        })
      ).json<Monat>();

      expect(monat.positionen[0]!.status).toBe('ok');
      expect(monat.summen.anzahlOffen).toBe(0);
      expect(monat.summen.anzahlOhneBelegpflicht).toBe(1);
      // Anders als beim Ausblenden zaehlt der Betrag weiter mit.
      expect(monat.summen.ausgaben).toBe(800);
    });

    it('gilt der Monat damit als abgeschlossen', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/tx-privat`,
        payload: { markierung: 'dauerbeleg' },
      });

      const status = (
        await app.inject({ url: `/api/months/${MONAT}/status` })
      ).json<MonatsStatus>();
      expect(status.abgeschlossen).toBe(true);
    });

    it('kennt die Umbuchung als dritte Markierung', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-privat`,
          payload: { markierung: 'umbuchung' },
        })
      ).json<Monat>();

      expect(monat.positionen[0]!.status).toBe('ok');
      expect(monat.positionen[0]!.hinweis).toContain('Umbuchung');
      expect(monat.summen.anzahlUmbuchungen).toBe(1);
    });

    it('nimmt die Markierung wieder zurueck', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/tx-privat`,
        payload: { markierung: 'privatentnahme' },
      });

      const monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-privat`,
          payload: { markierung: null },
        })
      ).json<Monat>();

      expect(monat.positionen[0]!.markierung).toBeUndefined();
      expect(monat.positionen[0]!.status).toBe('offen');
    });
  });

  // -------------------------------------------------------------------------

  describe('Belegablage mit Fortschritt', () => {
    beforeEach(async () => {
      sevdesk = await starteMockSevDesk(basisDaten());
      await starteApp();
    });

    it('meldet die Einteilung als Vorgang, nicht als stilles Warten', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const vorgang = await fuehreVorgangAus(`/api/months/${MONAT}/ablage/job`);

      expect(vorgang.status).toBe('fertig');
      expect(vorgang.art).toBe('ablage-vorschau');
      expect(vorgang.fortschritt.map((f) => f.schritt)).toContain('einteilung');
    });

    it('antwortet sofort, statt den Lauf abzuwarten', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const start = await app.inject({
        method: 'POST',
        url: `/api/months/${MONAT}/ablage/job`,
      });

      // 202: angenommen, laeuft. Genau das verhindert den Proxy-Zeitablauf.
      expect(start.statusCode).toBe(202);
      expect(start.json<Vorgang>().status).toBe('laeuft');
    });

    it('bleibt ohne konfigurierte Webhooks bei der Vorschau', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const vorgang = await fuehreVorgangAus(
        `/api/months/${MONAT}/ablage/job?ausfuehren=true`,
      );

      const ergebnis = vorgang.ergebnis as { ausgefuehrt: boolean; hinweis?: string };
      expect(ergebnis.ausgefuehrt).toBe(false);
      expect(ergebnis.hinweis).toContain('N8N_ORDNER_URL');
    });

    it('haelt den Vorgang abrufbar und laesst ihn danach vergessen', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const vorgang = await fuehreVorgangAus(`/api/months/${MONAT}/ablage/job`);

      // In der Monatsliste steht er, bis die Oberflaeche ihn gesehen hat.
      const liste = (await app.inject({ url: `/api/vorgaenge?monat=${MONAT}` })).json<
        Vorgang[]
      >();
      expect(liste.map((v) => v.id)).toContain(vorgang.id);

      expect((await app.inject({ method: 'DELETE', url: `/api/vorgaenge/${vorgang.id}` }))
        .statusCode).toBe(204);
      expect((await app.inject({ url: `/api/vorgaenge/${vorgang.id}` })).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('Ablageordner an der Buchung', () => {
    const finde = (monat: Monat, id: string) => monat.positionen.find((p) => p.id === id)!;

    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-ordner', amount: '-42.00', paymtPurpose: 'Werkstatt Meier' }),
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('merkt sich den Ordner und nimmt ihn wieder zurueck', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      let monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-ordner`,
          payload: { ablageordner: 'Tanken' },
        })
      ).json<Monat>();
      expect(finde(monat, 'tx-ordner').ablageordner).toBe('Tanken');

      // Neu laden darf die Handeinstellung nicht wegwerfen.
      monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(finde(monat, 'tx-ordner').ablageordner).toBe('Tanken');

      monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-ordner`,
          payload: { ablageordner: null },
        })
      ).json<Monat>();
      expect(finde(monat, 'tx-ordner').ablageordner).toBeUndefined();
    });

    it('weist einen unbekannten Ordner ab, statt ihn zu uebernehmen', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/tx-ordner`,
        payload: { ablageordner: 'Papierkorb' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().fehler).toContain('Konto, Bar, Tanken');
    });

    it('setzt den Ordner fuer mehrere Buchungen auf einmal', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const ids = monat.positionen.map((p) => p.id);

      const danach = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions`,
          payload: { positionIds: ids, patch: { ablageordner: 'Bar' } },
        })
      ).json<Monat>();

      expect(danach.positionen.every((p) => p.ablageordner === 'Bar')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('POST ohne Koerper', () => {
    /*
     * Die Oberflaeche schickte bei Aufrufen ohne Daten trotzdem
     * "Content-Type: application/json" mit. Fastify beantwortet das von sich
     * aus mit 400 (FST_ERR_CTP_EMPTY_JSON_BODY) - saemtliche KI-Funktionen,
     * die Ablage und der Sync liefen damit ins Leere.
     */

    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(tx({ id: 'tx-1', amount: '-50.00' }));
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    for (const pfad of ['sync', 'ablage']) {
      it(`nimmt /${pfad} auch mit leerem JSON-Koerper an`, async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/months/${MONAT}/${pfad}`,
          headers: { 'content-type': 'application/json' },
        });
        expect(res.statusCode, res.body).toBe(200);
      });
    }

    it('weist kaputtes JSON weiterhin mit 400 ab', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/months/${MONAT}/report`,
        headers: { 'content-type': 'application/json' },
        payload: '{ das ist kein JSON',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------

  describe('Sammelaenderung an mehreren Buchungen', () => {
    // Wiederkehrende Posten einzeln zu markieren waere bei einem vollen Monat
    // viel Klickarbeit - und jede Runde eine eigene Anfrage.

    beforeEach(async () => {
      const daten = basisDaten();
      for (const id of ['tx-1', 'tx-2', 'tx-3']) {
        daten.transaktionen.push(tx({ id, amount: '-50.00', paymtPurpose: id }));
      }
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('markiert mehrere Buchungen in einem Aufruf', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions`,
          payload: { positionIds: ['tx-1', 'tx-3'], patch: { markierung: 'dauerbeleg' } },
        })
      ).json<Monat>();

      const nach = (id: string) => monat.positionen.find((p) => p.id === id)!;
      expect(nach('tx-1').markierung).toBe('dauerbeleg');
      expect(nach('tx-3').markierung).toBe('dauerbeleg');
      expect(nach('tx-2').markierung).toBeUndefined();
      expect(monat.summen.anzahlOhneBelegpflicht).toBe(2);
    });

    it('blendet mehrere Buchungen auf einmal aus', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions`,
          payload: { positionIds: ['tx-1', 'tx-2'], patch: { status: 'ignoriert' } },
        })
      ).json<Monat>();

      expect(monat.summen.anzahlIgnoriert).toBe(2);
      expect(monat.summen.ausgaben).toBe(50);
    });

    it('weist eine leere Auswahl ab', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions`,
        payload: { positionIds: [], patch: { markierung: 'dauerbeleg' } },
      });
      expect(res.statusCode).toBe(400);
    });

    it('aendert nichts, wenn eine der Buchungen nicht existiert', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions`,
        payload: { positionIds: ['tx-1', 'gibtsnicht'], patch: { markierung: 'umbuchung' } },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('Lade-Stream fuer die Oberflaeche', () => {
    // Der Abruf dauert je nach Buchungszahl viele Sekunden. Die Startseite soll
    // deshalb nicht nur "wird geladen" zeigen, sondern sich aufbauen.

    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({
          id: 'tx-aus', amount: '-119.00',
          paymtPurpose: 'Telekom Rechnung',
          valueDate: '2026-06-05T00:00:00+02:00',
        }),
      );
      daten.vouchers.push({
        id: 'v-1', objectName: 'Voucher', status: '1000',
        supplierName: 'Telekom', sumGross: '119.00',
      });
      daten.voucherTransaktionen['v-1'] = ['tx-aus'];
      daten.voucherDateien['v-1'] = await testPdf(1);

      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('liefert einen Ereignisstrom statt einer einzelnen Antwort', async () => {
      const res = await app.inject({ url: `/api/months/${MONAT}/stream` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // Ohne diesen Kopf puffern Reverse-Proxies den Strom bis zum Ende.
      expect(res.headers['x-accel-buffering']).toBe('no');

      const ereignisse = leseEreignisse(res.payload);
      expect(ereignisse.length).toBeGreaterThan(3);
    });

    it('meldet die Phasen in der richtigen Reihenfolge', async () => {
      const ereignisse = leseEreignisse(
        (await app.inject({ url: `/api/months/${MONAT}/stream` })).payload,
      );
      const phasen = ereignisse
        .filter((e) => e.art === 'fortschritt')
        .map((e) => (e.art === 'fortschritt' ? e.fortschritt.phase : ''));

      expect(phasen[0]).toBe('start');
      expect(phasen).toContain('transaktionen');
      expect(phasen).toContain('belege');
      expect(phasen).toContain('verknuepfung');
      expect(phasen).toContain('dateien');
      expect(phasen.at(-1)).toBe('fertig');
    });

    it('schickt die Buchungen schon vor den Belegdateien', async () => {
      const ereignisse = leseEreignisse(
        (await app.inject({ url: `/api/months/${MONAT}/stream` })).payload,
      );

      const teilIndex = ereignisse.findIndex((e) => e.art === 'teil');
      const dateiIndex = ereignisse.findIndex(
        (e) => e.art === 'fortschritt' && e.fortschritt.phase === 'dateien',
      );

      expect(teilIndex).toBeGreaterThanOrEqual(0);
      expect(teilIndex).toBeLessThan(dateiIndex);

      const teil = ereignisse[teilIndex] as Extract<LadeEreignis, { art: 'teil' }>;
      expect(teil.monat.positionen).toHaveLength(1);
      // Die Datei fehlt im Zwischenstand noch - genau darum geht es.
      expect(teil.monat.positionen[0]!.dateien).toHaveLength(0);
    });

    it('endet mit dem vollstaendigen Monat', async () => {
      const ereignisse = leseEreignisse(
        (await app.inject({ url: `/api/months/${MONAT}/stream` })).payload,
      );

      const letztes = ereignisse.at(-1);
      expect(letztes?.art).toBe('fertig');

      const fertig = letztes as Extract<LadeEreignis, { art: 'fertig' }>;
      expect(fertig.monat.positionen[0]!.dateien).toHaveLength(1);
      expect(fertig.monat.positionen[0]!.status).toBe('ok');
    });

    it('liefert dasselbe Ergebnis wie der gewoehnliche Abruf', async () => {
      const ueberStream = leseEreignisse(
        (await app.inject({ url: `/api/months/${MONAT}/stream?refresh=true` })).payload,
      ).at(-1) as Extract<LadeEreignis, { art: 'fertig' }>;

      const gewoehnlich = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();

      expect(ueberStream.monat.positionen).toEqual(gewoehnlich.positionen);
      expect(ueberStream.monat.summen).toEqual(gewoehnlich.summen);
    });

    it('schreibt den Zwischenstand nicht in den Cache', async () => {
      // Sonst waere nach einem Abbruch ein Monat ohne Belege gespeichert.
      await app.inject({ url: `/api/months/${MONAT}/stream` });
      const gespeichert = (await db.ladeMonat(MONAT))!;
      expect(gespeichert.positionen[0]!.dateien).toHaveLength(1);
    });

    it('nutzt den Cache, wenn kein refresh verlangt wird', async () => {
      await app.inject({ url: `/api/months/${MONAT}/stream` });
      const nachErstem = sevdesk.aufrufe.length;

      await app.inject({ url: `/api/months/${MONAT}/stream` });
      expect(sevdesk.aufrufe.length).toBe(nachErstem);
    });

    it('weist einen ungueltigen Monat mit 400 ab, nicht im Strom', async () => {
      const res = await app.inject({ url: '/api/months/Juni/stream' });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('meldet einen Ausfall als Ereignis, nicht als abgebrochene Verbindung', async () => {
      await sevdesk.schliesse();

      const res = await app.inject({ url: `/api/months/${MONAT}/stream?refresh=true` });
      expect(res.statusCode).toBe(200);

      const letztes = leseEreignisse(res.payload).at(-1);
      expect(letztes?.art).toBe('fehler');
    });
  });

  // -------------------------------------------------------------------------

  describe('Noch nicht zugeordnete Buchungen', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      // status 100 = in sevDesk angelegt, aber noch keiner Rechnung zugeordnet
      daten.transaktionen.push(
        tx({
          id: 'tx-offen', amount: '1240.00', status: '100',
          paymtPurpose: 'Sammelueberweisung Allianz',
        }),
        tx({ id: 'tx-fertig', amount: '-84.20', status: '100', paymtPurpose: 'Amazon' }),
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('erkennt sie als in sevDesk unzugeordnet und sagt, wo die Korrektur hingehoert', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const p = monat.positionen.find((x) => x.id === 'tx-offen')!;

      expect(p.sevdeskStatus).toBe('offen');
      expect(p.status).toBe('offen');
      expect(p.hinweis).toContain('In sevDesk noch nicht zugeordnet');
    });

    it('zaehlt sie getrennt von "Beleg fehlt"', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.summen.anzahlNichtZugeordnet).toBe(2);
      expect(monat.summen.anzahlOffen).toBe(2);
    });

    it('meldet den Monat als nicht abgeschlossen', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const status = (
        await app.inject({ url: `/api/months/${MONAT}/status` })
      ).json<MonatsStatus>();

      expect(status.geladen).toBe(true);
      expect(status.abgeschlossen).toBe(false);
      expect(status.summen!.anzahlNichtZugeordnet).toBe(2);
      expect(status.synchronisiertAm).toBeTruthy();
    });

    it('uebernimmt die Zuordnung, sobald sie in sevDesk nachgetragen wurde', async () => {
      // Erster Lauf: nichts zugeordnet
      let monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.summen.anzahlNichtZugeordnet).toBe(2);

      // Der Nutzer verbucht beide Positionen jetzt in sevDesk.
      sevdesk.daten.transaktionen.forEach((t) => (t.status = '200'));
      sevdesk.daten.vouchers.push({
        id: 'v-neu', objectName: 'Voucher', status: '1000', supplierName: 'Amazon',
      });
      sevdesk.daten.voucherTransaktionen['v-neu'] = ['tx-fertig'];
      sevdesk.daten.voucherDateien['v-neu'] = await testPdf(1);

      sevdesk.daten.invoices.push({
        id: 'inv-neu', objectName: 'Invoice', status: '1000',
        invoiceNumber: '0626/1900TG01',
      });
      sevdesk.daten.invoiceTransaktionen['inv-neu'] = ['tx-offen'];
      n8n.antworten.set('0626/1900TG01', [
        { file: (await testPdf(1)).toString('base64'), filename: '0626_1900TG01_Rechnung.pdf' },
      ]);

      // Zweiter Lauf ueber den Sync-Endpunkt
      monat = (
        await app.inject({ method: 'POST', url: `/api/months/${MONAT}/sync` })
      ).json<Monat>();

      expect(monat.summen.anzahlNichtZugeordnet).toBe(0);
      expect(monat.summen.anzahlOk).toBe(2);
      expect(monat.positionen.find((p) => p.id === 'tx-offen')!.aktenzeichen!.normalisiert)
        .toBe('0626/1900TG01');

      const status = (
        await app.inject({ url: `/api/months/${MONAT}/status` })
      ).json<MonatsStatus>();
      expect(status.abgeschlossen).toBe(true);
    });

    it('meldet einen nie geladenen Monat als nicht geladen', async () => {
      const status = (
        await app.inject({ url: '/api/months/2026-01/status' })
      ).json<MonatsStatus>();
      expect(status).toMatchObject({ monat: '2026-01', geladen: false, abgeschlossen: false });
      expect(status.summen).toBeUndefined();
    });

    it('liefert eine Uebersicht ueber mehrere Monate', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      const liste = (
        await app.inject({ url: '/api/months?von=2026-05&bis=2026-07' })
      ).json<MonatsStatus[]>();

      expect(liste.map((m) => m.monat)).toEqual(['2026-05', '2026-06', '2026-07']);
      expect(liste.find((m) => m.monat === MONAT)!.geladen).toBe(true);
      expect(liste.find((m) => m.monat === '2026-05')!.geladen).toBe(false);
    });
  });

  // -------------------------------------------------------------------------

  describe('Manuelle Korrekturen', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-1', amount: '892.50', paymtPurpose: 'Sammelzahlung ohne AZ' }),
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
      await app.inject({ url: `/api/months/${MONAT}` });
    });

    const patch = (koerper: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/tx-1`,
        payload: koerper,
      });

    it('uebernimmt ein manuell gesetztes Aktenzeichen', async () => {
      n8n.antworten.set('0626/1811TG01', []);
      const monat = (await patch({ aktenzeichen: '0626/1811TG01' })).json<Monat>();
      const p = monat.positionen[0]!;

      expect(p.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
      expect(p.aktenzeichen!.herkunft).toBe('manuell');
      expect(p.manuellBestaetigt).toBe(true);
    });

    it('normalisiert ein manuell eingetipptes Aktenzeichen mit Leerzeichen', async () => {
      const monat = (await patch({ aktenzeichen: '0626/1811 TG 01' })).json<Monat>();
      expect(monat.positionen[0]!.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
    });

    it('weist ein unsinniges Aktenzeichen als Eingabefehler ab, nicht als Serverfehler', async () => {
      const res = await patch({ aktenzeichen: 'Rechnung 42' });
      expect(res.statusCode).toBe(400);
      expect(res.json().fehler).toContain('MMYY/NummerTGXX');
      expect(res.json().fehler).toContain('0626/1811TG01'); // Beispiel mitliefern
    });

    it('meldet eine unbekannte Buchung mit 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/gibtsnicht`,
        payload: { status: 'ignoriert' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('meldet einen noch nicht geladenen Monat mit 404 statt mit 500', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/months/2026-01/positions/tx-1',
        payload: { status: 'ignoriert' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().fehler).toContain('noch nicht geladen');
    });

    it('blendet eine Position aus und nimmt sie aus den Summen', async () => {
      const monat = (await patch({ status: 'ignoriert' })).json<Monat>();
      expect(monat.positionen[0]!.status).toBe('ignoriert');
      expect(monat.summen.einnahmen).toBe(0);
      expect(monat.summen.anzahlIgnoriert).toBe(1);
    });

    it('ueberlebt einen erneuten sevDesk-Abruf', async () => {
      await patch({ aktenzeichen: '0626/1811TG01' });

      const monat = (
        await app.inject({ method: 'POST', url: `/api/months/${MONAT}/sync` })
      ).json<Monat>();

      expect(monat.positionen[0]!.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
      expect(monat.positionen[0]!.manuellBestaetigt).toBe(true);
    });

    it('stellt beim Zuruecksetzen den sevDesk-Stand wieder her', async () => {
      // Regression: zuvor wurde die zusammengefuehrte Fassung in den Cache
      // geschrieben, wodurch der sevDesk-Stand verloren ging und das
      // Zuruecksetzen wirkungslos blieb.
      await patch({ aktenzeichen: '0626/1811TG01' });
      await patch({ status: 'ignoriert' });

      const monat = (
        await app.inject({
          method: 'DELETE',
          url: `/api/months/${MONAT}/positions/tx-1/override`,
        })
      ).json<Monat>();

      const p = monat.positionen[0]!;
      expect(p.aktenzeichen).toBeUndefined();
      expect(p.status).toBe('offen');
      expect(p.manuellBestaetigt).toBe(false);
    });

    it('fuehrt mehrere Korrekturen zusammen, statt sie zu ueberschreiben', async () => {
      await patch({ aktenzeichen: '0626/1811TG01' });
      const monat = (await patch({ hinweis: 'telefonisch geklaert' })).json<Monat>();

      expect(monat.positionen[0]!.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
      expect(monat.positionen[0]!.hinweis).toBe('telefonisch geklaert');
    });

    it('nimmt einen manuell nachgereichten Beleg entgegen', async () => {
      const pdf = await testPdf(1);
      const grenze = '----abrechnungtest';
      const koerper = Buffer.concat([
        Buffer.from(
          `--${grenze}\r\nContent-Disposition: form-data; name="datei"; filename="nachgereicht.pdf"\r\n` +
            'Content-Type: application/pdf\r\n\r\n',
        ),
        pdf,
        Buffer.from(`\r\n--${grenze}--\r\n`),
      ]);

      const monat = (
        await app.inject({
          method: 'POST',
          url: `/api/months/${MONAT}/positions/tx-1/upload`,
          payload: koerper,
          headers: { 'content-type': `multipart/form-data; boundary=${grenze}` },
        })
      ).json<Monat>();

      const p = monat.positionen[0]!;
      expect(p.dateien).toHaveLength(1);
      expect(p.dateien[0]!.quelle).toBe('manuell');
      expect(p.dateien[0]!.dateiname).toBe('nachgereicht.pdf');
      expect(p.status).toBe('ok');
    });
  });

  // -------------------------------------------------------------------------

  describe('Rechnungsabruf ueber n8n', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-1', amount: '892.50', paymtPurpose: 'RE 0626/1811TG01' }),
      );
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('arbeitet die Retry-Kette ab und findet die Rechnung im Vormonat', async () => {
      n8n.antworten.set('0526/1811TG01', [
        { file: (await testPdf(1)).toString('base64'), filename: '0526_1811TG01_Rechnung.pdf' },
      ]);

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();

      expect(n8n.angefragt).toEqual(['0626/1811TG01', '0526/1811TG01']);
      expect(monat.positionen[0]!.dateien).toHaveLength(1);
      expect(monat.positionen[0]!.status).toBe('ok');
    });

    it('stellt mehrere Treffer zur Auswahl, statt blind den ersten zu nehmen', async () => {
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1, 'A')).toString('base64'), filename: 'Rechnung_A.pdf' },
        { file: (await testPdf(2, 'B')).toString('base64'), filename: 'Rechnung_B.pdf' },
      ]);

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const p = monat.positionen[0]!;

      expect(p.status).toBe('mehrdeutig');
      expect(p.dateien).toHaveLength(1);
      expect(p.kandidaten).toHaveLength(1);
      expect(p.hinweis).toContain('bitte pruefen');
    });

    it('laesst den Nutzer aus den Kandidaten waehlen', async () => {
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1, 'A')).toString('base64'), filename: 'Rechnung_A.pdf' },
        { file: (await testPdf(2, 'B')).toString('base64'), filename: 'Rechnung_B.pdf' },
      ]);
      let monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const gewuenscht = monat.positionen[0]!.kandidaten![0]!.id;

      monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-1`,
          payload: { dateiIds: [gewuenscht] },
        })
      ).json<Monat>();

      const p = monat.positionen[0]!;
      expect(p.dateien.map((d) => d.id)).toEqual([gewuenscht]);
      expect(p.status).toBe('ok');
    });

    it('laesst den vorausgewaehlten Beleg bestaetigen', async () => {
      /*
       * Der erste Treffer wird vorgeschlagen, die Buchung bleibt aber gelb, bis
       * jemand entschieden hat. Ist die Vorauswahl die richtige, muss sich
       * genau sie bestaetigen lassen - in der Oberflaeche fehlte dafuer
       * zunaechst jede Moeglichkeit, weil ein Klick auf das bereits gewaehlte
       * Feld kein Ereignis ausloest.
       */
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1, 'A')).toString('base64'), filename: 'Rechnung_A.pdf' },
        { file: (await testPdf(2, 'B')).toString('base64'), filename: 'Rechnung_B.pdf' },
      ]);
      let monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();

      const vorausgewaehlt = monat.positionen[0]!.dateien[0]!.id;
      expect(monat.positionen[0]!.status).toBe('mehrdeutig');

      monat = (
        await app.inject({
          method: 'PATCH',
          url: `/api/months/${MONAT}/positions/tx-1`,
          payload: { dateiIds: [vorausgewaehlt] },
        })
      ).json<Monat>();

      const p = monat.positionen[0]!;
      expect(p.status).toBe('ok');
      expect(p.dateien.map((d) => d.id)).toEqual([vorausgewaehlt]);
      // Die Alternative bleibt sichtbar, macht aber nichts mehr mehrdeutig.
      expect(p.kandidaten).toHaveLength(1);
    });

    it('grenzt auf den exakten Rechnungsindex ein, wenn moeglich', async () => {
      // Der Workflow filtert per startsWith und liefert TG01 und TG02.
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1, 'TG01')).toString('base64'), filename: '0626_1811TG01_Rechnung.pdf' },
        { file: (await testPdf(2, 'TG02')).toString('base64'), filename: '0626_1811TG02_Rechnung.pdf' },
      ]);

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      const p = monat.positionen[0]!;
      expect(p.dateien).toHaveLength(1);
      expect(p.dateien[0]!.dateiname).toBe('0626_1811TG01_Rechnung.pdf');
      expect(p.status).toBe('ok');
    });

    it('meldet einen erfolglosen Abruf mit den geprueften Varianten', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen[0]!.status).toBe('offen');
      expect(monat.positionen[0]!.hinweis).toContain('2 Varianten geprueft');
    });

    it('faellt auf das sevDesk-PDF zurueck, wenn n8n nichts liefert', async () => {
      sevdesk.daten.invoices.push({
        id: 'inv-1', objectName: 'Invoice', status: '1000',
        invoiceNumber: '0626/1811TG01',
      });
      sevdesk.daten.invoiceTransaktionen['inv-1'] = ['tx-1'];
      sevdesk.daten.invoicePdfs['inv-1'] = await testPdf(1);

      const monat = (
        await app.inject({ url: `/api/months/${MONAT}?refresh=true` })
      ).json<Monat>();

      expect(monat.positionen[0]!.dateien[0]!.quelle).toBe('sevdesk-invoice');
      expect(monat.positionen[0]!.status).toBe('ok');
    });
  });

  // -------------------------------------------------------------------------

  describe('Robustheit gegenueber sevDesk-Ausfaellen', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(tx({ id: 'tx-1', amount: '-119.00' }));
      daten.vouchers.push({ id: 'v-1', objectName: 'Voucher', status: '1000' });
      daten.voucherTransaktionen['v-1'] = ['tx-1'];
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();
    });

    it('laeuft weiter, wenn ein Beleg keine Datei angehaengt hat', async () => {
      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen[0]!.hinweis).toContain('ohne angehaengte Datei');
      expect(monat.positionen[0]!.status).toBe('offen');
    });

    it('faellt auf das Aktenzeichen zurueck, wenn Invoice-Verknuepfungen 404 liefern', async () => {
      // Genau der als SPIKE markierte Fall: /Invoice/{id}/getCheckAccountTransactions
      // existiert moeglicherweise nicht.
      sevdesk.daten.transaktionen.push(
        tx({ id: 'tx-2', amount: '892.50', paymtPurpose: 'RE 0626/1811TG01' }),
      );
      sevdesk.daten.invoices.push({
        id: 'inv-1', objectName: 'Invoice', status: '1000',
        invoiceNumber: '0626/1811TG01',
      });
      sevdesk.erzwingeStatus.set('/Invoice/inv-1/getCheckAccountTransactions', 404);

      const monat = (
        await app.inject({ url: `/api/months/${MONAT}?refresh=true` })
      ).json<Monat>();

      const p = monat.positionen.find((x) => x.id === 'tx-2')!;
      // Die Rechnung wurde ueber das Aktenzeichen nachgetragen.
      expect(p.invoiceId).toBe('inv-1');
      expect(p.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
    });

    it('meldet einen sevDesk-Ausfall als Fehler, statt stillschweigend leer zu liefern', async () => {
      sevdesk.erzwingeStatus.set('/CheckAccountTransaction', 500);
      const res = await app.inject({ url: `/api/months/${MONAT}?refresh=true` });
      expect(res.statusCode).toBe(500);
      expect(res.json().fehler).toContain('sevDesk 500');
    });
  });

  // -------------------------------------------------------------------------

  describe('Kontoauszuege und Abrechnungs-PDF', () => {
    beforeEach(async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-aus', amount: '-119.00', valueDate: '2026-06-05T00:00:00+02:00' }),
        tx({
          id: 'tx-ein', amount: '892.50',
          paymtPurpose: 'RE 0626/1811TG01',
          valueDate: '2026-06-03T00:00:00+02:00',
        }),
      );
      daten.vouchers.push({ id: 'v-1', objectName: 'Voucher', status: '1000' });
      daten.voucherTransaktionen['v-1'] = ['tx-aus'];
      daten.voucherDateien['v-1'] = await testPdf(2);

      sevdesk = await starteMockSevDesk(daten);
      n8n.antworten.set('0626/1811TG01', [
        { file: (await testPdf(1)).toString('base64'), filename: '0626_1811TG01_Rechnung.pdf' },
      ]);
      await starteApp();
      await app.inject({ url: `/api/months/${MONAT}` });
    });

    const ladeKontoauszugHoch = async (dateiname: string, seiten: number) => {
      const pdf = await testPdf(seiten, dateiname);
      const grenze = '----abrechnungtest';
      const koerper = Buffer.concat([
        Buffer.from(
          `--${grenze}\r\nContent-Disposition: form-data; name="datei"; filename="${dateiname}"\r\n` +
            'Content-Type: application/pdf\r\n\r\n',
        ),
        pdf,
        Buffer.from(`\r\n--${grenze}--\r\n`),
      ]);
      return app.inject({
        method: 'POST',
        url: `/api/months/${MONAT}/statements`,
        payload: koerper,
        headers: { 'content-type': `multipart/form-data; boundary=${grenze}` },
      });
    };

    it('nimmt einen Kontoauszug entgegen und merkt ihn sich', async () => {
      const monat = (await ladeKontoauszugHoch('Auszug_Juni.pdf', 3)).json<Monat>();
      expect(monat.kontoauszuege).toHaveLength(1);
      expect(monat.kontoauszuege[0]!.dateiname).toBe('Auszug_Juni.pdf');
      expect(monat.kontoauszuege[0]!.seiten).toBe(3);
    });

    it('behaelt Kontoauszuege ueber einen sevDesk-Neuabruf hinweg', async () => {
      await ladeKontoauszugHoch('Auszug_Juni.pdf', 2);
      const monat = (
        await app.inject({ method: 'POST', url: `/api/months/${MONAT}/sync` })
      ).json<Monat>();
      expect(monat.kontoauszuege).toHaveLength(1);
    });

    it('behaelt die Upload-Reihenfolge mehrerer Auszuege bei', async () => {
      await ladeKontoauszugHoch('Seite_1.pdf', 1);
      await ladeKontoauszugHoch('Seite_2.pdf', 1);
      const monat = (await ladeKontoauszugHoch('Seite_3.pdf', 1)).json<Monat>();
      expect(monat.kontoauszuege.map((k) => k.dateiname)).toEqual([
        'Seite_1.pdf', 'Seite_2.pdf', 'Seite_3.pdf',
      ]);
    });

    it('entfernt einen Kontoauszug wieder', async () => {
      let monat = (await ladeKontoauszugHoch('Auszug.pdf', 1)).json<Monat>();
      const id = monat.kontoauszuege[0]!.id;

      monat = (
        await app.inject({ method: 'DELETE', url: `/api/months/${MONAT}/statements/${id}` })
      ).json<Monat>();
      expect(monat.kontoauszuege).toHaveLength(0);
    });

    it('erzeugt das vollstaendige Abrechnungs-PDF in der richtigen Reihenfolge', async () => {
      await ladeKontoauszugHoch('Auszug_Juni.pdf', 3);

      const res = await app.inject({
        method: 'POST',
        url: `/api/months/${MONAT}/report`,
        payload: { buero: 'Gollenstede Sachverstand' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('Abrechnung_2026-06.pdf');

      const doc = await PDFDocument.load(res.rawPayload);
      // Deckblatt(1) + Kontoauszug(3) + Journal(1) + Voucher(2) + Rechnung(1)
      expect(doc.getPageCount()).toBe(8);
    });

    it('erzeugt das PDF auch ohne Kontoauszug', async () => {
      const res = await app.inject({ method: 'POST', url: `/api/months/${MONAT}/report` });
      const doc = await PDFDocument.load(res.rawPayload);
      // Deckblatt + Journal + Voucher(2) + Rechnung(1)
      expect(doc.getPageCount()).toBe(5);
    });

    it('laesst ausgeblendete Positionen aus dem PDF heraus', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/months/${MONAT}/positions/tx-aus`,
        payload: { status: 'ignoriert' },
      });

      const res = await app.inject({ method: 'POST', url: `/api/months/${MONAT}/report` });
      const doc = await PDFDocument.load(res.rawPayload);
      // Deckblatt + Journal + nur noch die Rechnung(1)
      expect(doc.getPageCount()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------

  describe('KI-Vorgaenge mit Fortschritt', () => {
    /*
     * Belege auslesen dauert pro Datei einen Modellaufruf. Ohne Rueckmeldung
     * sieht die Oberflaeche waehrenddessen aus, als sei sie stehengeblieben -
     * deshalb laufen beide KI-Funktionen als Ereignisstrom.
     */

    let claude: Server;
    let claudeUrl: string;
    let anfragen: number;

    beforeEach(async () => {
      anfragen = 0;
      // Ereignisstrom statt einer einzelnen JSON-Antwort: der KI-Dienst fragt
      // per Strom an, weil das SDK bei den noetigen Token-Budgets gewoehnliche
      // Anfragen ablehnt.
      claude = createServer((_req, res) => {
        anfragen++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const sende = (typ: string, daten: unknown) =>
          res.write(`event: ${typ}\ndata: ${JSON.stringify(daten)}\n\n`);

        sende('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        });
        sende('content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        });
        sende('content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: '{"betrag":119,"aussteller":"Telekom"}' },
        });
        sende('content_block_stop', { type: 'content_block_stop', index: 0 });
        sende('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        });
        sende('message_stop', { type: 'message_stop' });
        res.end();
      });
      await new Promise<void>((f) => claude.listen(0, '127.0.0.1', f));
      claudeUrl = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`;

      const daten = basisDaten();
      for (const [i, id] of ['v-1', 'v-2'].entries()) {
        daten.transaktionen.push(tx({ id: `tx-${i}`, amount: '-119.00' }));
        daten.vouchers.push({ id, objectName: 'Voucher', status: '1000', sumGross: '119.00' });
        daten.voucherTransaktionen[id] = [`tx-${i}`];
        daten.voucherDateien[id] = await testPdf(1, id);
      }

      sevdesk = await starteMockSevDesk(daten);
      await starteApp({
        anthropic: {
          apiKey: 'test', modell: 'claude-opus-5', effort: 'low', baseUrl: claudeUrl,
        },
      });
    });

    afterEach(() => new Promise<void>((f) => claude.close(() => f())));

    it('meldet beim Auslesen jeden Beleg einzeln', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const vorgang = await fuehreVorgangAus(`/api/months/${MONAT}/ai/extract/job`);

      expect(vorgang.status).toBe('fertig');
      const staende = vorgang.fortschritt;

      // Erst das Zusammenstellen, dann je ein Stand nach jedem Beleg.
      expect(staende[0]).toMatchObject({ schritt: 'sammeln' });
      expect(staende.map((f) => f.schritt)).toContain('lesen');
      expect(staende.find((f) => f.schritt === 'lesen')).toMatchObject({
        erledigt: 2,
        gesamt: 2,
      });
      expect(staende.at(-1)).toMatchObject({ schritt: 'uebernehmen' });

      expect((vorgang.ergebnis as { neuAnalysiert: number }).neuAnalysiert).toBe(2);
    });

    it('schickt dieselbe Datei kein zweites Mal an das Modell', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      await fuehreVorgangAus(`/api/months/${MONAT}/ai/extract/job`);
      const nachErstem = anfragen;

      await fuehreVorgangAus(`/api/months/${MONAT}/ai/extract/job`);
      expect(anfragen).toBe(nachErstem);
    });

    it('meldet bei der Pruefung, worauf gewartet wird', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });

      const vorgang = await fuehreVorgangAus(`/api/months/${MONAT}/ai/review/job`);
      const schritte = vorgang.fortschritt.map((f) => f.schritt);

      // Mehrere benannte Schritte statt einer nichtssagenden Zeile.
      expect(schritte).toContain('sammeln');
      expect(schritte).toContain('modell');
      expect(schritte).toContain('befunde');
      expect(vorgang.status).toBe('fertig');
    });

    it('meldet einen Ausfall als Ereignis, nicht als Abbruch', async () => {
      await app.inject({ url: `/api/months/${MONAT}` });
      await new Promise<void>((f) => claude.close(() => f()));

      const vorgang = await fuehreVorgangAus(`/api/months/${MONAT}/ai/review/job`);

      // Der Vorgang scheitert - aber als Zustand, nicht als abgebrochene Anfrage.
      expect(vorgang.status).toBe('fehler');
      expect(vorgang.fehler).toBeTruthy();
      // Damit afterEach nicht ueber den geschlossenen Server stolpert
      claude = createServer();
    });
  });

  // -------------------------------------------------------------------------

  describe('KI-Funktionen ohne API-Key', () => {
    beforeEach(async () => {
      sevdesk = await starteMockSevDesk(basisDaten());
      await starteApp();
    });

    it('meldet ki:false in den Capabilities', async () => {
      expect((await app.inject({ url: '/api/capabilities' })).json().ki).toBe(false);
    });

    it('weist KI-Aufrufe mit 503 und klarer Begruendung ab', async () => {
      for (const pfad of [
        `/api/months/${MONAT}/ai/extract`,
        `/api/months/${MONAT}/ai/match`,
        `/api/months/${MONAT}/ai/review`,
      ]) {
        const res = await app.inject({ method: 'POST', url: pfad });
        expect(res.statusCode).toBe(503);
        expect(res.json().fehler).toContain('ANTHROPIC_API_KEY');
      }
    });

    it('laesst alle uebrigen Funktionen unberuehrt', async () => {
      expect((await app.inject({ url: `/api/months/${MONAT}` })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: `/api/months/${MONAT}/report` })).statusCode,
      ).toBe(200);
    });
  });

  // -------------------------------------------------------------------------

  describe('Betrieb ohne n8n', () => {
    it('nutzt ausschliesslich sevDesk und meldet das in den Capabilities', async () => {
      const daten = basisDaten();
      daten.transaktionen.push(
        tx({ id: 'tx-1', amount: '892.50', paymtPurpose: 'RE 0626/1811TG01' }),
      );
      daten.invoices.push({
        id: 'inv-1', objectName: 'Invoice', status: '1000',
        invoiceNumber: '0626/1811TG01',
      });
      daten.invoiceTransaktionen['inv-1'] = ['tx-1'];
      daten.invoicePdfs['inv-1'] = await testPdf(1);

      sevdesk = await starteMockSevDesk(daten);
      await starteApp({ n8n: undefined });

      expect((await app.inject({ url: '/api/capabilities' })).json().n8nRechnungsabruf).toBe(false);

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      expect(monat.positionen[0]!.dateien[0]!.quelle).toBe('sevdesk-invoice');
      expect(n8n.angefragt).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('Groessere Datenmengen', () => {
    it('verarbeitet einen Monat mit 150 Buchungen ueber die Paginierungsgrenze hinweg', async () => {
      const daten = basisDaten();
      for (let i = 0; i < 150; i++) {
        daten.transaktionen.push(
          tx({
            id: `tx-${i}`,
            amount: i % 2 === 0 ? '100.00' : '-50.00',
            valueDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+02:00`,
          }),
        );
      }
      sevdesk = await starteMockSevDesk(daten);
      await starteApp();

      const monat = (await app.inject({ url: `/api/months/${MONAT}` })).json<Monat>();
      // sevDesk liefert 100 pro Seite - ohne Paginierung fehlten 50.
      expect(monat.positionen).toHaveLength(150);
      expect(monat.summen.anzahlGesamt).toBe(150);
      expect(monat.summen.einnahmen).toBe(7500);
      expect(monat.summen.ausgaben).toBe(3750);
    });
  });
});
