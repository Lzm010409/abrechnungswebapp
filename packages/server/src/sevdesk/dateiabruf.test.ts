import { describe, expect, it, vi } from 'vitest';
import { SevDeskClient } from './client.js';

/**
 * Regression zum Produktionsfehler
 *
 *   Belegabruf fehlgeschlagen
 *   err: Unexpected token '%', "%PDF-1.4..." is not valid JSON
 *
 * sevDesk antwortet auf den Datei-Endpunkten mal mit einer JSON-Huelle und
 * base64-Inhalt, mal mit dem rohen Dateistrom. Der Client hat bedingungslos
 * res.json() aufgerufen und ist an der Rohvariante zerbrochen - und zwar fuer
 * jede einzelne Position, der komplette Monat blieb dadurch ohne Belege.
 */

const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\nInhalt', 'latin1');

function baueClient(fetchImpl: typeof fetch) {
  return new SevDeskClient({
    token: 'test',
    baseUrl: 'https://my.sevdesk.de/api/v1',
    fetchImpl,
    maxRetries: 0,
  });
}

function rohAntwort(daten: Buffer, contentType: string, disposition?: string) {
  const headers = new Map<string, string>([['content-type', contentType]]);
  if (disposition) headers.set('content-disposition', disposition);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () =>
      daten.buffer.slice(daten.byteOffset, daten.byteOffset + daten.byteLength),
  } as unknown as Response;
}

function jsonAntwort(koerper: unknown) {
  const text = JSON.stringify(koerper);
  return rohAntwort(Buffer.from(text, 'utf8'), 'application/json; charset=utf-8');
}

describe('Belegdatei - base64 ohne Huelle', () => {
  /*
   * Zweiter Produktionsfehler an derselben Stelle: die Datei liess sich
   * herunterladen, der PDF-Betrachter meldete aber "Datei kann nicht geoeffnet
   * werden". Auf der Platte lag base64-TEXT statt eines PDF - sevDesk hatte
   * ihn ohne JSON-Huelle und mit unauffaelligem Content-Type geschickt, und
   * der Client hatte ihn ungeprueft durchgereicht.
   */

  const base64 = PDF.toString('base64');

  it('dekodiert blanken base64-Text', async () => {
    const fetchImpl = vi.fn(async () =>
      rohAntwort(Buffer.from(base64, 'ascii'), 'text/plain'),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
    expect(datei!.mimeType).toBe('application/pdf');
  });

  it('dekodiert base64 auch mit Zeilenumbruechen', async () => {
    const umbrochen = base64.replace(/(.{20})/g, '$1\n');
    const fetchImpl = vi.fn(async () =>
      rohAntwort(Buffer.from(umbrochen, 'ascii'), 'application/octet-stream'),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('kommt mit einem blanken JSON-String zurecht', async () => {
    const fetchImpl = vi.fn(async () =>
      rohAntwort(Buffer.from(`"${base64}"`, 'ascii'), 'application/json'),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('kommt mit einer data-URL zurecht', async () => {
    const fetchImpl = vi.fn(async () =>
      rohAntwort(
        Buffer.from(`data:application/pdf;base64,${base64}`, 'ascii'),
        'text/plain',
      ),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('macht aus lesbarem Text keinen Datenmuell', async () => {
    // Wuerde blind dekodiert, entstuende Unsinn statt einer erkennbaren Datei.
    const text = Buffer.from('Beleg konnte nicht erzeugt werden', 'ascii');
    const fetchImpl = vi.fn(async () => rohAntwort(text, 'text/plain'));

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.toString()).toBe('Beleg konnte nicht erzeugt werden');
    expect(datei!.mimeType).toBe('text/plain');
  });

  it('laesst ein rohes PDF unangetastet, auch bei falschem Content-Type', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'text/html'));

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.equals(PDF)).toBe(true);
    expect(datei!.mimeType).toBe('application/pdf');
  });
});

describe('Belegdatei - unerwartete JSON-Formen', () => {
  /*
   * Regression: nach der Umstellung auf inhaltsgetriebene Auswertung kamen
   * gar keine Ausgabenbelege mehr an. Ursache war die Annahme, der Inhalt
   * stehe unter objects.content - sevDesk verschachtelt die Datei-Antworten
   * je nach Endpunkt anders. Feldnamen fest zu verdrahten war der Fehler;
   * gesucht wird jetzt im gesamten Antwortbaum.
   */

  const base64 = PDF.toString('base64');

  const formen: Array<[string, unknown]> = [
    ['objects als Array', { objects: [{ content: base64, filename: 'a.pdf' }] }],
    ['objects als Array von Strings', { objects: [base64] }],
    ['ohne objects-Huelle', { content: base64, filename: 'a.pdf' }],
    ['zusaetzlich verschachtelt', { objects: { document: { content: base64 } } }],
    ['Inhalt unter "file"', { objects: { file: base64 } }],
    ['Inhalt tief im Baum', { objects: { a: { b: { c: { content: base64 } } } } }],
    ['als data-URL', { objects: { content: `data:application/pdf;base64,${base64}` } }],
  ];

  for (const [name, koerper] of formen) {
    it(`findet den Beleg: ${name}`, async () => {
      const fetchImpl = vi.fn(async () => jsonAntwort(koerper));

      const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

      expect(datei, name).toBeDefined();
      expect(datei!.daten.subarray(0, 5).toString(), name).toBe('%PDF-');
      expect(datei!.mimeType, name).toBe('application/pdf');
    });
  }

  it('uebernimmt den Dateinamen aus der Naehe des Inhalts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({ objects: [{ content: base64, filename: 'Telekom_4711.pdf' }] }),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.dateiname).toBe('Telekom_4711.pdf');
  });

  it('meldet eine unbekannte Antwortform, statt sie zu verschweigen', async () => {
    // Sonst faellt eine geaenderte API erst auf, wenn ein ganzer Monat leer ist.
    const warnungen: unknown[] = [];
    const fetchImpl = vi.fn(async () => jsonAntwort({ objects: { status: 'leer' } }));

    const client = new SevDeskClient({
      token: 't',
      baseUrl: 'https://my.sevdesk.de/api/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
      log: { warn: (o) => warnungen.push(o) },
    });

    expect(await client.holeVoucherDateien('v-1')).toEqual([]);
    expect(warnungen).toHaveLength(1);
    // Die Struktur wird gemeldet, nicht der Inhalt - der kann der Beleg sein.
    expect(JSON.stringify(warnungen[0])).toContain('status');
    expect(JSON.stringify(warnungen[0])).not.toContain('leer');
  });

  it('bleibt bei einem leeren Beleg bei null', async () => {
    const fetchImpl = vi.fn(async () => jsonAntwort({ objects: null }));
    expect(
      await baueClient(fetchImpl as unknown as typeof fetch).holeVoucherDateien('v-1'),
    ).toEqual([]);
  });
});

describe('Belegdatei - JSON-Huelle', () => {
  it('liest den Inhalt auch unter abweichendem Feldnamen', async () => {
    for (const feld of ['content', 'base64', 'file', 'data']) {
      const fetchImpl = vi.fn(async () =>
        jsonAntwort({ objects: { [feld]: PDF.toString('base64') } }),
      );

      const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

      expect(datei!.daten.subarray(0, 5).toString(), feld).toBe('%PDF-');
    }
  });

  it('nimmt den Inhalt roh, wenn base64encoded false ist', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({
        objects: { content: PDF.toString('latin1'), base64encoded: false },
      }),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('glaubt der Signatur mehr als dem gemeldeten Typ', async () => {
    // sevDesk hat PDFs schon als image/jpeg ausgewiesen - im Browser blieb
    // die Vorschau dann leer.
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({
        objects: { content: PDF.toString('base64'), mimeType: 'image/jpeg' },
      }),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.mimeType).toBe('application/pdf');
  });
});

describe('Belegdatei - rohe Dateistroeme', () => {
  it('nimmt ein rohes PDF entgegen, statt daran zu scheitern', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'application/pdf'));

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei).toBeDefined();
    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
    expect(datei!.mimeType).toBe('application/pdf');
  });

  it('uebernimmt den Dateinamen aus Content-Disposition', async () => {
    const fetchImpl = vi.fn(async () =>
      rohAntwort(PDF, 'application/pdf', 'attachment; filename="Telekom_4711.pdf"'),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.dateiname).toBe('Telekom_4711.pdf');
  });

  it('versteht auch die RFC-5987-Form mit Umlauten', async () => {
    const fetchImpl = vi.fn(async () =>
      rohAntwort(
        PDF,
        'application/pdf',
        "attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20Beleg.pdf",
      ),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.dateiname).toBe('Grüße Beleg.pdf');
  });

  it('faellt auf einen sprechenden Standardnamen zurueck', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'application/pdf'));
    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-42');
    expect(datei!.dateiname).toBe('beleg-v-42.pdf');
  });

  it('erkennt den Typ an den Magic Bytes, wenn der Header nichts hergibt', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, ''));
    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');
    expect(datei!.mimeType).toBe('application/pdf');
  });

  it('erkennt ein rohes JPEG', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fetchImpl = vi.fn(async () => rohAntwort(jpeg, ''));
    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');
    expect(datei!.mimeType).toBe('image/jpeg');
  });

  it('behandelt eine leere Antwort als "keine Datei"', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(Buffer.alloc(0), 'application/pdf'));
    expect(
      await baueClient(fetchImpl as unknown as typeof fetch).holeVoucherDateien('v-1'),
    ).toEqual([]);
  });
});

describe('Belegdatei - JSON-Huelle', () => {
  it('dekodiert die dokumentierte Form mit objects.content', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({
        objects: {
          content: PDF.toString('base64'),
          filename: 'beleg.pdf',
          base64encoded: 'true',
          mimeType: 'application/pdf',
        },
      }),
    );

    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(datei!.daten.equals(PDF)).toBe(true);
    expect(datei!.dateiname).toBe('beleg.pdf');
  });

  it('versteht objects als blossen Base64-String', async () => {
    const fetchImpl = vi.fn(async () => jsonAntwort({ objects: PDF.toString('base64') }));
    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');
    expect(datei!.daten.equals(PDF)).toBe(true);
  });

  it('liefert nichts, wenn kein Dokument angehaengt ist', async () => {
    const fetchImpl = vi.fn(async () => jsonAntwort({ objects: null }));
    expect(
      await baueClient(fetchImpl as unknown as typeof fetch).holeVoucherDateien('v-1'),
    ).toEqual([]);
  });

  it('rettet sich, wenn JSON angekuendigt aber Binaerdaten geliefert werden', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'application/json'));
    const [datei] = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');
    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('Rechnungs-PDF', () => {
  it('nimmt auch hier den rohen Dateistrom entgegen', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'application/pdf'));
    const datei = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeRechnungsPdf('inv-1');
    expect(datei!.daten.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('behandelt 404 als "nicht vorhanden", nicht als Fehler', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => 'not found',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    const datei = await baueClient(fetchImpl).holeRechnungsPdf('inv-1');
    expect(datei).toBeNull();
  });

  it('meldet einen echten Serverfehler weiterhin als Fehler', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => 'kaputt',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    await expect(baueClient(fetchImpl).holeRechnungsPdf('inv-1')).rejects.toThrow(
      /sevDesk 500/,
    );
  });

  it('akzeptiert beide Formate ueber den Accept-Header', async () => {
    const fetchImpl = vi.fn(async () => rohAntwort(PDF, 'application/pdf'));
    await baueClient(fetchImpl as unknown as typeof fetch).holeVoucherDateien('v-1');

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    const accept = (init.headers as Record<string, string>).Accept;
    expect(accept).toContain('application/json');
    expect(accept).toContain('application/pdf');
  });
});

describe('Belegdatei - mehrere Seiten', () => {
  /*
   * Ein Beleg besteht nicht immer aus einer Datei: eine Tankquittung wird
   * gelegentlich als zwei Scans abgelegt, mitunter erst die Rueckseite. Frueher
   * wurde nur der erste Fund genommen - im Abrechnungs-PDF fehlte dann die
   * andere Seite, ohne dass es jemandem auffiel.
   */

  const seite = (kennung: string) =>
    Buffer.from(`%PDF-1.4\n${kennung}`, 'latin1').toString('base64');

  it('nimmt alle Seiten aus einem Array', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({
        objects: [
          { content: seite('RUECKSEITE'), filename: 'scan-1.pdf' },
          { content: seite('VORDERSEITE'), filename: 'scan-2.pdf' },
        ],
      }),
    );

    const dateien = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-1');

    expect(dateien).toHaveLength(2);
    expect(dateien.map((d) => d.dateiname)).toEqual(['scan-1.pdf', 'scan-2.pdf']);
    expect(dateien[0]!.daten.toString()).toContain('RUECKSEITE');
    expect(dateien[1]!.daten.toString()).toContain('VORDERSEITE');
  });

  it('nummeriert die Seiten, wenn keine Namen mitkommen', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({ objects: [seite('A'), seite('B'), seite('C')] }),
    );

    const dateien = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-7');

    expect(dateien.map((d) => d.dateiname)).toEqual([
      'beleg-v-7 (1 von 3).pdf',
      'beleg-v-7 (2 von 3).pdf',
      'beleg-v-7 (3 von 3).pdf',
    ]);
  });

  it('zaehlt dieselbe Seite nicht doppelt', async () => {
    // Manche Antworten fuehren denselben Inhalt mehrfach auf.
    const gleich = seite('EINMAL');
    const fetchImpl = vi.fn(async () =>
      jsonAntwort({ objects: [{ content: gleich }, { content: gleich }] }),
    );

    expect(
      await baueClient(fetchImpl as unknown as typeof fetch).holeVoucherDateien('v-1'),
    ).toHaveLength(1);
  });

  it('laesst den Namen bei einer einzelnen Seite unveraendert', async () => {
    const fetchImpl = vi.fn(async () => jsonAntwort({ objects: [seite('EINE')] }));
    const dateien = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDateien('v-7');

    expect(dateien[0]!.dateiname).toBe('beleg-v-7.pdf');
  });
});
