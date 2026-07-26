import { describe, expect, it, vi } from 'vitest';
import { SevDeskClient, SevDeskFehler } from './client.js';
import type { CheckAccountTransaction } from './types.js';

function antwort(objects: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ objects }),
  } as unknown as Response;
}

function fehlerAntwort(status: number) {
  return {
    ok: false,
    status,
    text: async () => 'Fehlermeldung',
  } as unknown as Response;
}

function tx(id: string, valueDate: string, kontoId = 'konto-1'): CheckAccountTransaction {
  return {
    id,
    objectName: 'CheckAccountTransaction',
    valueDate,
    amount: '100.00',
    status: '200',
    checkAccount: { id: kontoId, objectName: 'CheckAccount' },
  };
}

function baueClient(fetchImpl: typeof fetch) {
  return new SevDeskClient({
    token: 'test',
    baseUrl: 'https://my.sevdesk.de/api/v1',
    fetchImpl,
    maxRetries: 0,
  });
}

describe('holeTransaktionen - Zeitzonen', () => {
  // Regression: sevDesk liefert valueDate mit Offset. "2026-06-01T00:00:00+02:00"
  // ist in UTC der 31.05. um 22:00 Uhr. Ein Vergleich ueber Zeitstempel hat
  // deshalb den kompletten Monatsersten verloren und den Ersten des
  // Folgemonats faelschlich aufgenommen.

  it('behaelt Buchungen vom Monatsersten in deutscher Sommerzeit', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([tx('erster', '2026-06-01T00:00:00+02:00')]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer.map((t) => t.id)).toEqual(['erster']);
  });

  it('behaelt Buchungen vom Monatsletzten', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([tx('letzter', '2026-06-30T23:30:00+02:00')]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer.map((t) => t.id)).toEqual(['letzter']);
  });

  it('schliesst den Ersten des Folgemonats aus', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([tx('juli', '2026-07-01T00:00:00+02:00')]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer).toHaveLength(0);
  });

  it('schliesst den Letzten des Vormonats aus', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([tx('mai', '2026-05-31T23:59:00+02:00')]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer).toHaveLength(0);
  });

  it('arbeitet auch in der Winterzeit korrekt (+01:00)', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([
        tx('jan-erster', '2026-01-01T00:00:00+01:00'),
        tx('feb-erster', '2026-02-01T00:00:00+01:00'),
      ]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-01-01', '2026-01-31');

    expect(treffer.map((t) => t.id)).toEqual(['jan-erster']);
  });

  it('weitet das serverseitige Fenster, damit keine Randbuchung verlorengeht', async () => {
    const fetchImpl = vi.fn(async () => antwort([]));
    await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    const url = new URL((fetchImpl.mock.calls[0] as unknown as [URL])[0].toString());
    const start = Number(url.searchParams.get('startDate')) * 1000;
    const ende = Number(url.searchParams.get('endDate')) * 1000;

    // zwei Tage Puffer auf beiden Seiten
    expect(start).toBeLessThanOrEqual(Date.parse('2026-05-30T00:00:00Z'));
    expect(ende).toBeGreaterThanOrEqual(Date.parse('2026-07-02T00:00:00Z'));
  });

  it('filtert Buchungen fremder Konten heraus', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([
        tx('eigen', '2026-06-15T00:00:00+02:00', 'konto-1'),
        tx('fremd', '2026-06-15T00:00:00+02:00', 'konto-2'),
      ]),
    );
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer.map((t) => t.id)).toEqual(['eigen']);
  });
});

describe('Paginierung', () => {
  it('laeuft ueber mehrere Seiten, bis eine unvollstaendige kommt', async () => {
    const seite1 = Array.from({ length: 100 }, (_, i) =>
      tx(`a${i}`, '2026-06-15T00:00:00+02:00'),
    );
    const seite2 = Array.from({ length: 30 }, (_, i) =>
      tx(`b${i}`, '2026-06-15T00:00:00+02:00'),
    );

    let aufruf = 0;
    const fetchImpl = vi.fn(async () => antwort(aufruf++ === 0 ? seite1 : seite2));

    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(treffer).toHaveLength(130);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('hoert nach einer einzelnen unvollstaendigen Seite auf', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([tx('a', '2026-06-15T00:00:00+02:00')]),
    );
    await baueClient(fetchImpl as unknown as typeof fetch)
      .holeTransaktionen('konto-1', '2026-06-01', '2026-06-30');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('ermittleCheckAccount', () => {
  const konto = (id: string, name: string, type = 'online', status = '100') => ({
    id, objectName: 'CheckAccount' as const, name, type, status, currency: 'EUR',
  });

  it('waehlt das einzige aktive Online-Konto', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([konto('1', 'Geschaeftskonto'), konto('2', 'Alt', 'online', '0')]),
    );
    const gewaehlt = await baueClient(fetchImpl as unknown as typeof fetch)
      .ermittleCheckAccount();
    expect(gewaehlt.id).toBe('1');
  });

  it('zieht Online-Konten Offline-Konten vor', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([konto('kasse', 'Kasse', 'offline'), konto('bank', 'Bank', 'online')]),
    );
    const gewaehlt = await baueClient(fetchImpl as unknown as typeof fetch)
      .ermittleCheckAccount();
    expect(gewaehlt.id).toBe('bank');
  });

  it('nennt bei Mehrdeutigkeit alle Kandidaten', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([konto('1', 'Geschaeft'), konto('2', 'Ruecklagen')]),
    );
    await expect(
      baueClient(fetchImpl as unknown as typeof fetch).ermittleCheckAccount(),
    ).rejects.toThrow(/1 \(Geschaeft.*2 \(Ruecklagen/s);
  });

  it('meldet, wenn gar kein aktives Konto existiert', async () => {
    const fetchImpl = vi.fn(async () => antwort([konto('1', 'Alt', 'online', '0')]));
    await expect(
      baueClient(fetchImpl as unknown as typeof fetch).ermittleCheckAccount(),
    ).rejects.toThrow(/Kein aktives Bankkonto/);
  });

  it('akzeptiert eine gueltige Vorgabe ohne Ruecksicht auf die Heuristik', async () => {
    const fetchImpl = vi.fn(async () =>
      antwort([konto('1', 'Geschaeft'), konto('2', 'Ruecklagen')]),
    );
    const gewaehlt = await baueClient(fetchImpl as unknown as typeof fetch)
      .ermittleCheckAccount('2');
    expect(gewaehlt.name).toBe('Ruecklagen');
  });
});

describe('Fehlerbehandlung', () => {
  it('reicht einen HTTP-Fehler mit Status und Pfad weiter', async () => {
    const fetchImpl = vi.fn(async () => fehlerAntwort(403));
    await expect(
      baueClient(fetchImpl as unknown as typeof fetch).holeCheckAccounts(),
    ).rejects.toMatchObject({ name: 'SevDeskFehler', status: 403 });
  });

  it('liefert null statt zu scheitern, wenn ein Beleg keine Datei hat', async () => {
    const fetchImpl = vi.fn(async () => antwort(null));
    const datei = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDatei('v-1');
    expect(datei).toBeNull();
  });

  it('behandelt einen 404 beim Rechnungs-PDF als "nicht vorhanden"', async () => {
    const fetchImpl = vi.fn(async () => fehlerAntwort(404));
    const pdf = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeRechnungsPdf('inv-1');
    expect(pdf).toBeNull();
  });

  it('faengt einen 404 bei Invoice-Verknuepfungen ab - der SPIKE-Fall', async () => {
    const fetchImpl = vi.fn(async () => fehlerAntwort(404));
    const treffer = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeInvoiceTransaktionen('inv-1');
    expect(treffer).toEqual([]);
  });

  it('laesst einen 500 bei Invoice-Verknuepfungen durch - das ist kein Normalfall', async () => {
    const fetchImpl = vi.fn(async () => fehlerAntwort(500));
    await expect(
      baueClient(fetchImpl as unknown as typeof fetch).holeInvoiceTransaktionen('inv-1'),
    ).rejects.toBeInstanceOf(SevDeskFehler);
  });

  it('dekodiert die Base64-Belegdatei korrekt', async () => {
    const inhalt = Buffer.from('%PDF-1.7 Testinhalt');
    const fetchImpl = vi.fn(async () =>
      antwort({
        content: inhalt.toString('base64'),
        filename: 'beleg.pdf',
        base64encoded: 'true',
        mimeType: 'application/pdf',
      }),
    );

    const datei = await baueClient(fetchImpl as unknown as typeof fetch)
      .holeVoucherDatei('v-1');

    expect(datei!.daten.equals(inhalt)).toBe(true);
    expect(datei!.dateiname).toBe('beleg.pdf');
  });

  it('sendet das Token ohne Bearer-Praefix', async () => {
    const fetchImpl = vi.fn(async () => antwort([]));
    await baueClient(fetchImpl as unknown as typeof fetch).holeCheckAccounts();

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('test');
  });
});
