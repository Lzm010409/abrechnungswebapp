import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Position } from '@abrechnung/shared';
import { KiDienst } from './client.js';

/**
 * Prueft den Aufbau der Anfragen an die Claude-API gegen einen lokalen
 * Nachbau des Endpunkts.
 *
 * Ohne API-Key laesst sich kein echter Aufruf machen. Ein falsch gebautes
 * Anfrageobjekt - veraltetes Thinking-Format, Schema an der falschen Stelle,
 * fehlerhafter Dokumentblock - wuerde sonst erst in Produktion auffallen,
 * und zwar als 400 mitten im Belegauslesen.
 */

interface AufgezeichneteAnfrage {
  pfad: string;
  koerper: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let anfragen: AufgezeichneteAnfrage[];
let antwortText: string;
let basisUrl: string;

beforeEach(async () => {
  anfragen = [];
  antwortText = '{}';

  server = createServer((req, res) => {
    let roh = '';
    req.on('data', (c) => (roh += c));
    req.on('end', () => {
      anfragen.push({
        pfad: req.url ?? '',
        koerper: JSON.parse(roh || '{}'),
        headers: req.headers,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: antwortText }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  basisUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function dienst(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high') {
  return new KiDienst({
    apiKey: 'test-key',
    modell: 'claude-opus-5',
    effort,
    baseUrl: basisUrl,
  });
}

async function testPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return Buffer.from(await doc.save());
}

function position(teil: Partial<Position> & { id: string }): Position {
  return {
    datum: '2026-06-03',
    betrag: 100,
    waehrung: 'EUR',
    verwendungszweck: 'Test',
    typ: 'EINGANG',
    sevdeskStatus: 'verknuepft',
    dateien: [],
    status: 'offen',
    manuellBestaetigt: false,
    ...teil,
  };
}

// ---------------------------------------------------------------------------

describe('Aufbau der Anfragen', () => {
  it('nutzt adaptives Thinking statt des entfernten budget_tokens', async () => {
    antwortText = JSON.stringify({
      betrag: 119, belegdatum: '2026-06-01', aussteller: 'Telekom',
      ustBetrag: 19, ustSatz: 19, kategorie: 'Telekommunikation',
      aktenzeichen: null, konfidenz: 0.9,
    });

    await dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf');

    const k = anfragen[0]!.koerper;
    expect(k.thinking).toEqual({ type: 'adaptive' });
    // budget_tokens wird von aktuellen Modellen mit 400 abgelehnt.
    expect(JSON.stringify(k)).not.toContain('budget_tokens');
  });

  it('sendet keine Sampling-Parameter - die aktuellen Modelle lehnen sie ab', async () => {
    antwortText = JSON.stringify({
      betrag: null, belegdatum: null, aussteller: null, ustBetrag: null,
      ustSatz: null, kategorie: null, aktenzeichen: null, konfidenz: 0,
    });
    await dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf');

    const k = anfragen[0]!.koerper;
    expect(k).not.toHaveProperty('temperature');
    expect(k).not.toHaveProperty('top_p');
    expect(k).not.toHaveProperty('top_k');
  });

  it('legt effort und Schema gemeinsam in output_config ab', async () => {
    antwortText = JSON.stringify({
      betrag: null, belegdatum: null, aussteller: null, ustBetrag: null,
      ustSatz: null, kategorie: null, aktenzeichen: null, konfidenz: 0,
    });
    await dienst('xhigh').extrahiereBeleg(await testPdf(), 'beleg.pdf');

    const oc = anfragen[0]!.koerper.output_config as Record<string, unknown>;
    expect(oc.effort).toBe('xhigh');
    const format = oc.format as Record<string, unknown>;
    expect(format.type).toBe('json_schema');
    // Structured Outputs verlangen additionalProperties:false und required.
    const schema = format.schema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('betrag');
  });

  it('schickt das PDF als Dokumentblock, nicht als Text', async () => {
    antwortText = JSON.stringify({
      betrag: null, belegdatum: null, aussteller: null, ustBetrag: null,
      ustSatz: null, kategorie: null, aktenzeichen: null, konfidenz: 0,
    });
    const pdf = await testPdf();
    await dienst().extrahiereBeleg(pdf, 'beleg.pdf');

    const nachrichten = anfragen[0]!.koerper.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    const dok = nachrichten[0]!.content[0] as {
      type: string;
      source: { type: string; media_type: string; data: string };
    };

    expect(dok.type).toBe('document');
    expect(dok.source.media_type).toBe('application/pdf');
    expect(dok.source.type).toBe('base64');
    expect(Buffer.from(dok.source.data, 'base64').equals(pdf)).toBe(true);
  });

  it('verwendet das konfigurierte Modell', async () => {
    antwortText = JSON.stringify({
      betrag: null, belegdatum: null, aussteller: null, ustBetrag: null,
      ustSatz: null, kategorie: null, aktenzeichen: null, konfidenz: 0,
    });
    await dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf');
    expect(anfragen[0]!.koerper.model).toBe('claude-opus-5');
  });
});

// ---------------------------------------------------------------------------

describe('Auswertung der Antworten', () => {
  it('wandelt null-Werte des Schemas in undefined um', async () => {
    antwortText = JSON.stringify({
      betrag: 119, belegdatum: '2026-06-01', aussteller: 'Telekom',
      ustBetrag: null, ustSatz: null, kategorie: null,
      aktenzeichen: null, konfidenz: 0.8,
    });

    const e = await dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf');

    expect(e.betrag).toBe(119);
    expect(e.aussteller).toBe('Telekom');
    // Das Schema erlaubt null; intern arbeiten wir mit undefined.
    expect(e).not.toHaveProperty('ustBetrag');
    expect(e).not.toHaveProperty('kategorie');
    expect(e.extrahiertAm).toBeTruthy();
  });

  it('meldet eine Ablehnung als verstaendlichen Fehler', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-opus-5',
          content: [], stop_reason: 'refusal',
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      );
    });

    await expect(
      dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf'),
    ).rejects.toThrow(/abgelehnt/);
  });

  it('meldet eine abgeschnittene Antwort, statt kaputtes JSON zu parsen', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'text', text: '{"betrag": 1' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });

    await expect(
      dienst().extrahiereBeleg(await testPdf(), 'beleg.pdf'),
    ).rejects.toThrow(/abgeschnitten/);
  });

  it('filtert bereits geprueffte Aktenzeichen aus den Vorschlaegen', async () => {
    antwortText = JSON.stringify({
      kandidaten: ['0626/1811TG01', '0526/1811TG01', '0626/1900TG01'],
    });

    const kandidaten = await dienst().schlageAktenzeichenVor(
      'Zahlung ohne klares AZ',
      '2026-06-15',
      ['0626/1811TG01', '0526/1811TG01'],
    );

    expect(kandidaten).toEqual(['0626/1900TG01']);
  });
});

// ---------------------------------------------------------------------------

describe('Sparsamkeit', () => {
  it('ruft die API gar nicht auf, wenn es nichts zuzuordnen gibt', async () => {
    const vorschlaege = await dienst().schlageZuordnungVor([], []);
    expect(vorschlaege).toEqual([]);
    expect(anfragen).toHaveLength(0);
  });

  it('ruft die API nicht auf, wenn es keine freien Belege gibt', async () => {
    await dienst().schlageZuordnungVor([position({ id: 'a' })], []);
    expect(anfragen).toHaveLength(0);
  });

  it('uebergibt beim Monats-Review nur die noetigen Felder', async () => {
    antwortText = JSON.stringify({ zusammenfassung: 'alles ok', auffaelligkeiten: [] });

    await dienst().pruefeMonat('2026-06', [
      position({ id: 'a', verwendungszweck: 'Test', betrag: 100 }),
    ]);

    const inhalt = (anfragen[0]!.koerper.messages as Array<{ content: string }>)[0]!.content;
    // Interne Felder gehoeren nicht in den Prompt.
    expect(inhalt).not.toContain('manuellBestaetigt');
    expect(inhalt).not.toContain('voucherId');
    expect(inhalt).toContain('2026-06');
  });
});
