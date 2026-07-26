import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import type {
  CheckAccount,
  CheckAccountTransaction,
  Invoice,
  Voucher,
} from '../sevdesk/types.js';

/**
 * Nachbau der genutzten sevDesk-Endpunkte als lokaler HTTP-Server.
 *
 * Bildet die Eigenheiten der echten API nach, damit der Client gegen dieselben
 * Bedingungen laeuft wie in Produktion:
 *  - Antworten in { "objects": ... } gekapselt
 *  - Betraege als Strings
 *  - Paginierung ueber limit/offset
 *  - Authorization-Header ohne "Bearer "-Praefix, sonst 401
 */

export interface MockDaten {
  checkAccounts: CheckAccount[];
  transaktionen: CheckAccountTransaction[];
  vouchers: Voucher[];
  invoices: Invoice[];
  /** Beleg-ID -> Buchungs-IDs */
  voucherTransaktionen: Record<string, string[]>;
  /** Rechnungs-ID -> Buchungs-IDs */
  invoiceTransaktionen: Record<string, string[]>;
  /** Beleg-ID -> Dateiinhalt; fehlt der Eintrag, gibt es keine Datei */
  voucherDateien: Record<string, Buffer>;
  invoicePdfs: Record<string, Buffer>;
}

export interface MockSevDesk {
  url: string;
  daten: MockDaten;
  /** Alle eingegangenen Anfragen - fuer Zusicherungen im Test */
  aufrufe: Array<{ pfad: string; query: Record<string, string> }>;
  /** Erzwingt einen Statuscode fuer einen Pfad, z. B. um 404 zu simulieren */
  erzwingeStatus: Map<string, number>;
  schliesse: () => Promise<void>;
}

/**
 * Erzeugt ein echtes PDF mit `seiten` Seiten.
 *
 * `kennung` setzt den Titel und macht die Bytes damit unterscheidbar. Ohne das
 * waeren zwei PDFs gleicher Seitenzahl byteidentisch - die Dateiablage
 * dedupliziert ueber den Inhalts-Hash und wuerde sie zu einer Datei
 * zusammenfassen, was in Tests mit mehreren Dokumenten irrefuehrend ist.
 */
export async function testPdf(seiten = 1, kennung?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (kennung) doc.setTitle(kennung);
  for (let i = 0; i < seiten; i++) doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
}

export async function starteMockSevDesk(daten: MockDaten): Promise<MockSevDesk> {
  const aufrufe: MockSevDesk['aufrufe'] = [];
  const erzwingeStatus = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pfad = url.pathname.replace(/^\/api\/v1/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    aufrufe.push({ pfad, query });

    const sende = (status: number, koerper: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(koerper));
    };

    // Die echte API lehnt fehlende oder falsche Tokens mit 401 ab.
    if (!req.headers.authorization) {
      return sende(401, { error: { message: 'Unauthorized' } });
    }

    const erzwungen = erzwingeStatus.get(pfad);
    if (erzwungen !== undefined) {
      return sende(erzwungen, { error: { message: 'erzwungen' } });
    }

    // Paginierung wie im Original: limit/offset auf das Gesamtergebnis.
    const seite = <T>(alle: T[]) => {
      const limit = Number(query.limit ?? 100);
      const offset = Number(query.offset ?? 0);
      return { objects: alle.slice(offset, offset + limit) };
    };

    if (pfad === '/CheckAccount') return sende(200, seite(daten.checkAccounts));

    if (pfad === '/CheckAccountTransaction') {
      let treffer = daten.transaktionen;

      // Der echte Endpunkt filtert serverseitig nach Konto und Zeitraum.
      const kontoId = query['checkAccount[id]'];
      if (kontoId) treffer = treffer.filter((t) => t.checkAccount.id === kontoId);

      if (query.startDate) {
        const ab = Number(query.startDate) * 1000;
        treffer = treffer.filter((t) => Date.parse(t.valueDate) >= ab);
      }
      if (query.endDate) {
        const bis = Number(query.endDate) * 1000;
        treffer = treffer.filter((t) => Date.parse(t.valueDate) <= bis);
      }
      return sende(200, seite(treffer));
    }

    if (pfad === '/Voucher') return sende(200, seite(daten.vouchers));
    if (pfad === '/Invoice') return sende(200, seite(daten.invoices));

    let m = pfad.match(/^\/Voucher\/([^/]+)\/getCheckAccountTransactions$/);
    if (m) {
      const ids = daten.voucherTransaktionen[m[1]!] ?? [];
      return sende(200, {
        objects: daten.transaktionen.filter((t) => ids.includes(t.id)),
      });
    }

    m = pfad.match(/^\/Invoice\/([^/]+)\/getCheckAccountTransactions$/);
    if (m) {
      const ids = daten.invoiceTransaktionen[m[1]!] ?? [];
      return sende(200, {
        objects: daten.transaktionen.filter((t) => ids.includes(t.id)),
      });
    }

    m = pfad.match(/^\/Voucher\/([^/]+)\/getDocumentImage$/);
    if (m) {
      const datei = daten.voucherDateien[m[1]!];
      if (!datei) return sende(200, { objects: null });
      return sende(200, {
        objects: {
          content: datei.toString('base64'),
          filename: `beleg-${m[1]}.pdf`,
          base64encoded: 'true',
          mimeType: 'application/pdf',
        },
      });
    }

    m = pfad.match(/^\/Invoice\/([^/]+)\/getPdf$/);
    if (m) {
      const datei = daten.invoicePdfs[m[1]!];
      if (!datei) return sende(404, { error: { message: 'kein PDF' } });
      return sende(200, {
        objects: {
          content: datei.toString('base64'),
          filename: `rechnung-${m[1]}.pdf`,
          base64encoded: 'true',
          mimeType: 'application/pdf',
        },
      });
    }

    return sende(404, { error: { message: `unbekannter Pfad ${pfad}` } });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    daten,
    aufrufe,
    erzwingeStatus,
    schliesse: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// Mock des n8n-Webhooks "Find Rechnung API"
// ---------------------------------------------------------------------------

export interface MockN8n {
  url: string;
  /** Rechnungsnummer -> zurueckzugebende Dateien */
  antworten: Map<string, Array<{ file: string; filename: string }>>;
  angefragt: string[];
  schliesse: () => Promise<void>;
}

export async function starteMockN8n(): Promise<MockN8n> {
  const antworten = new Map<string, Array<{ file: string; filename: string }>>();
  const angefragt: string[] = [];

  const server = createServer((req, res) => {
    let koerper = '';
    req.on('data', (c) => (koerper += c));
    req.on('end', () => {
      const { Rechnungsnummer } = JSON.parse(koerper || '{}') as {
        Rechnungsnummer?: string;
      };
      angefragt.push(Rechnungsnummer ?? '');

      // Wie der echte Workflow: kein Treffer -> ein leeres Objekt,
      // weil alwaysOutputData greift.
      const treffer = antworten.get(Rechnungsnummer ?? '') ?? [{}];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(treffer));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/webhook/abrechnung/find-rechnung`,
    antworten,
    angefragt,
    schliesse: () => new Promise<void>((r) => server.close(() => r())),
  };
}
