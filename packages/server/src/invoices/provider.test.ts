import { describe, expect, it, vi } from 'vitest';
import { parseAktenzeichen } from '../aktenzeichen/index.js';
import { StandardRechnungsProvider } from './provider.js';
import type { SevDeskClient } from '../sevdesk/client.js';

const AZ = parseAktenzeichen('0126/1800TG01')!;

function pdfAntwort(eintraege: Array<{ file: string; filename: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => eintraege,
  } as unknown as Response;
}

const leererSevDesk = {
  holeRechnungsPdf: async () => null,
} as unknown as SevDeskClient;

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('StandardRechnungsProvider - n8n', () => {
  it('liefert die Datei beim ersten Treffer und probiert nichts weiter', async () => {
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([{ file: b64('PDF'), filename: '0126_1800TG01_Rechnung.pdf' }]),
    );

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);

    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.quelle).toBe('onedrive-n8n');
    expect(ergebnis.treffer[0]!.gefundenMit).toBe('0126/1800TG01');
    expect(ergebnis.versucht).toEqual(['0126/1800TG01']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sendet die Rechnungsnummer im vom Workflow erwarteten Format', async () => {
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([{ file: b64('PDF'), filename: 'r.pdf' }]),
    );
    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.holeRechnung(AZ);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ Rechnungsnummer: '0126/1800TG01' });
  });

  it('arbeitet die Retry-Kette ab, wenn der erste Versuch leer bleibt', async () => {
    // Erst beim dritten Versuch (anderer Rechnungsindex) gibt es einen Treffer.
    let aufrufe = 0;
    const fetchImpl = vi.fn(async () => {
      aufrufe++;
      if (aufrufe < 3) return pdfAntwort([]);
      return pdfAntwort([{ file: b64('PDF'), filename: '0126_1800TG02_Rechnung.pdf' }]);
    });

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);

    expect(ergebnis.versucht).toEqual([
      '0126/1800TG01',
      '1225/1800TG01',
      '0126/1800TG02',
    ]);
    expect(ergebnis.treffer[0]!.gefundenMit).toBe('0126/1800TG02');
  });

  it('grenzt mehrere Treffer auf den exakten Rechnungsindex ein', async () => {
    // Der Workflow filtert per startsWith auf "0126_1800TG" und liefert daher
    // beide Dateien. Gesucht ist TG01 - genau die muss gewinnen.
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([
        { file: b64('A'), filename: '0126_1800TG01_Rechnung.pdf' },
        { file: b64('B'), filename: '0126_1800TG02_Rechnung.pdf' },
      ]),
    );

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.dateiname).toBe('0126_1800TG01_Rechnung.pdf');
  });

  it('behaelt alle Treffer, wenn keiner exakt passt - statt blind den ersten zu nehmen', async () => {
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([
        { file: b64('A'), filename: 'Rechnung_alt.pdf' },
        { file: b64('B'), filename: 'Rechnung_neu.pdf' },
      ]),
    );

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.treffer).toHaveLength(2);
  });

  it('ignoriert Eintraege ohne file-Feld', async () => {
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([{ file: '', filename: 'leer.pdf' }] as never),
    );
    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.treffer).toHaveLength(0);
    expect(ergebnis.fehler).toContain('Keine Rechnungsdatei gefunden');
  });
});

describe('StandardRechnungsProvider - Rueckfallebene sevDesk', () => {
  it('nutzt Invoice/getPdf, wenn n8n nicht konfiguriert ist', async () => {
    const sevdesk = {
      holeRechnungsPdf: vi.fn(async () => ({
        daten: Buffer.from('PDF'),
        dateiname: 'RE-0126-1800TG01.pdf',
        mimeType: 'application/pdf',
      })),
    } as unknown as SevDeskClient;

    const provider = new StandardRechnungsProvider(sevdesk);
    const ergebnis = await provider.holeRechnung(AZ, 'inv-1');

    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.quelle).toBe('sevdesk-invoice');
    expect(sevdesk.holeRechnungsPdf).toHaveBeenCalledWith('inv-1');
  });

  it('faellt auf sevDesk zurueck, wenn n8n nichts findet', async () => {
    const sevdesk = {
      holeRechnungsPdf: vi.fn(async () => ({
        daten: Buffer.from('PDF'),
        dateiname: 'fallback.pdf',
        mimeType: 'application/pdf',
      })),
    } as unknown as SevDeskClient;

    const provider = new StandardRechnungsProvider(sevdesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: (async () => pdfAntwort([])) as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ, 'inv-1');
    expect(ergebnis.treffer[0]!.quelle).toBe('sevdesk-invoice');
    // Alle vier Varianten wurden vorher bei n8n probiert.
    expect(ergebnis.versucht).toHaveLength(4);
  });

  it('meldet einen klaren Fehler, wenn gar nichts konfiguriert ist', async () => {
    const provider = new StandardRechnungsProvider(leererSevDesk);
    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.fehler).toContain('N8N_FIND_RECHNUNG_URL nicht gesetzt');
  });

  it('meldet einen n8n-Ausfall als Konfigurationsfehler statt still zu scheitern', async () => {
    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.fehler).toContain('n8n nicht erreichbar');
  });
});
