import { describe, expect, it, vi } from 'vitest';
import { parseAktenzeichen } from '../aktenzeichen/index.js';
import { StandardRechnungsProvider } from './provider.js';
import type { SevDeskClient } from '../sevdesk/client.js';

const AZ = parseAktenzeichen('0126/1800TG01')!;

function pdfAntwort(eintraege: Array<{ file: string; filename: string }>) {
  const koerper = Buffer.from(JSON.stringify(eintraege), 'utf8');
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    arrayBuffer: async () =>
      koerper.buffer.slice(koerper.byteOffset, koerper.byteOffset + koerper.byteLength),
  } as unknown as Response;
}

/** n8n-Antwort als roher Dateistrom - moeglich, wenn der Workflow auf
 *  "Respond with binary" umgestellt wird. */
function binaerAntwort(daten: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () =>
      daten.buffer.slice(daten.byteOffset, daten.byteOffset + daten.byteLength),
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

  it('probiert den Vormonat, wenn der erste Versuch leer bleibt', async () => {
    let aufrufe = 0;
    const fetchImpl = vi.fn(async () => {
      aufrufe++;
      if (aufrufe < 2) return pdfAntwort([]);
      return pdfAntwort([{ file: b64('PDF'), filename: '1225_1800TG01_Rechnung.pdf' }]);
    });

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);

    expect(ergebnis.versucht).toEqual(['0126/1800TG01', '1225/1800TG01']);
    expect(ergebnis.treffer[0]!.gefundenMit).toBe('1225/1800TG01');
  });

  it('stellt bei unbekanntem Index alle Rechnungen des Vorgangs zur Auswahl', async () => {
    // "0724/1279TG" ohne Index: es gibt keinen Anhaltspunkt, welche der
    // Rechnungen gemeint ist - also entscheidet der Nutzer.
    const ohneIndex = parseAktenzeichen('0126/1800TG')!;
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

    const ergebnis = await provider.holeRechnung(ohneIndex);
    expect(ergebnis.treffer).toHaveLength(2);
    expect(ergebnis.versucht[0]).toBe('0126/1800TG01');
  });

  it('findet auch eine Rechnung mit Index 03', async () => {
    const ohneIndex = parseAktenzeichen('0126/1800TG')!;
    const fetchImpl = vi.fn(async () =>
      pdfAntwort([{ file: b64('C'), filename: '0126_1800TG03_Rechnung.pdf' }]),
    );

    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(ohneIndex);
    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.dateiname).toBe('0126_1800TG03_Rechnung.pdf');
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

  it('nimmt auch einen rohen Dateistrom entgegen', async () => {
    const pdf = Buffer.from('%PDF-1.4 Rechnung');
    const provider = new StandardRechnungsProvider(leererSevDesk, {
      url: 'http://n8n.local/webhook/find',
      fetchImpl: (async () => binaerAntwort(pdf)) as unknown as typeof fetch,
    });

    const ergebnis = await provider.holeRechnung(AZ);
    expect(ergebnis.treffer).toHaveLength(1);
    expect(ergebnis.treffer[0]!.daten.equals(pdf)).toBe(true);
    expect(ergebnis.treffer[0]!.dateiname).toBe('0126_1800TG01.pdf');
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
    // Beide Monatsvarianten wurden vorher bei n8n probiert.
    expect(ergebnis.versucht).toEqual(['0126/1800TG01', '1225/1800TG01']);
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
