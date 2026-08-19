import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AblageEintrag, LadeFortschritt, Monat, Position } from '@abrechnung/shared';
import {
  leseDateiliste,
  OneDriveAblage,
  sucheOrdnerId,
  type AblageOptionen,
} from './ablage.js';

/**
 * Die Belege wandern am Ende in die OneDrive-Monatsordner Konto, Bar und
 * Tanken. Die Einteilung haengt daran, welche Buchung sich auf einer Seite des
 * Kontoauszugs wiederfindet - deshalb geschieht sie erst beim Erzeugen des
 * Abrechnungs-PDF und nicht schon bei der Zuordnung.
 */

async function auszugMitText(zeilen: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const seite = doc.addPage([595, 842]);
  zeilen.forEach((zeile, i) => {
    seite.drawText(zeile, { x: 50, y: 700 - i * 16, size: 10, font });
  });
  return Buffer.from(await doc.save());
}

function pos(teil: Partial<Position> & { id: string }): Position {
  return {
    datum: '2026-06-02',
    betrag: -100,
    waehrung: 'EUR',
    verwendungszweck: '',
    typ: 'AUSGANG',
    sevdeskStatus: 'verknuepft',
    dateien: [
      { id: `${teil.id}-datei`, dateiname: `${teil.id}.pdf`, groesse: 1, mimeType: 'application/pdf', quelle: 'sevdesk-voucher' },
    ],
    status: 'ok',
    manuellBestaetigt: false,
    ...teil,
  };
}

function monat(teil: Partial<Monat> = {}): Monat {
  return {
    monat: '2026-06',
    checkAccountId: 'k1',
    positionen: [],
    summen: {
      einnahmen: 0, ausgaben: 0, saldo: 0, anzahlGesamt: 0, anzahlOk: 0,
      anzahlMehrdeutig: 0, anzahlOffen: 0, anzahlIgnoriert: 0, anzahlNichtZugeordnet: 0,
    },
    verwaisteBelege: [],
    kontoauszuege: [],
    ...teil,
  };
}

describe('Einteilung auf die Ordner', () => {
  it('legt Buchungen vom Kontoauszug nach Konto, den Rest nach Bar und Tanken', async () => {
    const auszug = await auszugMitText(['02.06.2026 Telekom 100,00']);
    const ablage = new OneDriveAblage(
      {},
      { ladeDatei: async () => auszug },
    );

    const ergebnis = await ablage.lege(
      monat({
        positionen: [
          pos({ id: 'telekom', verwendungszweck: 'Telekom', betrag: -100 }),
          pos({ id: 'tanken', verwendungszweck: 'ARAL TANKSTELLE', betrag: -62.4 }),
          pos({ id: 'sonst', verwendungszweck: 'Buerobedarf', betrag: -19.9 }),
        ],
        kontoauszuege: [
          { id: 'ka1', dateiname: 'Auszug.pdf', groesse: 1, hochgeladenAm: '2026-07-01T00:00:00Z' },
        ],
      }),
    );

    const nach = (id: string) =>
      ergebnis.eintraege.find((e) => e.positionId === id)?.ordner;

    expect(nach('telekom')).toBe('Konto');
    expect(nach('tanken')).toBe('Tanken');
    expect(nach('sonst')).toBe('Bar');
  });

  it('legt eine Tankfuellung vom Kontoauszug nach Konto', async () => {
    // Mit Karte bezahlt heisst: sie steht auf dem Auszug. Tanken meint bar.
    const auszug = await auszugMitText(['02.06.2026 ARAL 62,40']);
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => auszug });

    const ergebnis = await ablage.lege(
      monat({
        positionen: [pos({ id: 'a', verwendungszweck: 'ARAL TANKSTELLE', betrag: -62.4 })],
        kontoauszuege: [
          { id: 'ka1', dateiname: 'A.pdf', groesse: 1, hochgeladenAm: '2026-07-01T00:00:00Z' },
        ],
      }),
    );

    expect(ergebnis.eintraege[0]!.ordner).toBe('Konto');
  });

  it('laesst ignorierte Buchungen und solche ohne Beleg aussen vor', async () => {
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => Buffer.alloc(0) });

    const ergebnis = await ablage.lege(
      monat({
        positionen: [
          pos({ id: 'ignoriert', status: 'ignoriert' }),
          pos({ id: 'ohne', dateien: [] }),
          pos({ id: 'mit' }),
        ],
      }),
    );

    expect(ergebnis.eintraege.map((e) => e.positionId)).toEqual(['mit']);
    expect(ergebnis.ohneBeleg).toBe(1);
  });

  it('nimmt den an der Buchung gesetzten Ordner, nicht den der Regel', async () => {
    // Die Buchung steht auf dem Auszug, waere also Konto. Von Hand gesetzt
    // schlaegt das - genau dafuer ist die Einstellung da.
    const auszug = await auszugMitText(['02.06.2026 Telekom 100,00']);
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => auszug });

    const ergebnis = await ablage.lege(
      monat({
        positionen: [
          pos({ id: 'a', verwendungszweck: 'Telekom', betrag: -100, ablageordner: 'Tanken' }),
        ],
        kontoauszuege: [
          { id: 'ka1', dateiname: 'A.pdf', groesse: 1, hochgeladenAm: '2026-07-01T00:00:00Z' },
        ],
      }),
    );

    expect(ergebnis.eintraege[0]!.ordner).toBe('Tanken');
    expect(ergebnis.eintraege[0]!.vonHand).toBe(true);
    expect(ergebnis.eintraege[0]!.begruendung).toContain('von Hand');
  });

  it('faellt ohne gesetzten Ordner auf die Regel zurueck', async () => {
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => Buffer.alloc(0) });

    const ergebnis = await ablage.lege(
      monat({ positionen: [pos({ id: 'a', verwendungszweck: 'ARAL TANKSTELLE' })] }),
    );

    expect(ergebnis.eintraege[0]!.ordner).toBe('Tanken');
    expect(ergebnis.eintraege[0]!.vonHand).toBeUndefined();
  });

  it('laesst Geldeingaenge aussen vor - Rechnungen liegen woanders', async () => {
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => Buffer.alloc(0) });

    const ergebnis = await ablage.lege(
      monat({
        positionen: [
          pos({ id: 'ausgabe', typ: 'AUSGANG', betrag: -100 }),
          pos({ id: 'eingang', typ: 'EINGANG', betrag: 892.5 }),
        ],
      }),
    );

    expect(ergebnis.eintraege.map((e) => e.positionId)).toEqual(['ausgabe']);
    // Ein Eingang ohne Beleg ist fuer die Ablage kein fehlender Beleg.
    expect(ergebnis.ohneBeleg).toBe(0);
  });

  it('laesst ein Rechnungs-PDF auch an einer Ausgabenbuchung liegen', async () => {
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => Buffer.alloc(0) });

    const ergebnis = await ablage.lege(
      monat({
        positionen: [
          pos({
            id: 'gutschrift',
            typ: 'AUSGANG',
            dateien: [
              {
                id: 'r1',
                dateiname: 'Rechnung.pdf',
                groesse: 1,
                mimeType: 'application/pdf',
                quelle: 'onedrive-n8n',
              },
              {
                id: 'q1',
                dateiname: 'Quittung.pdf',
                groesse: 1,
                mimeType: 'application/pdf',
                quelle: 'manuell',
              },
            ],
          }),
        ],
      }),
    );

    expect(ergebnis.eintraege.map((e) => e.dateiname)).toEqual(['Quittung.pdf']);
  });

  it('bleibt ohne konfigurierte Webhooks bei der Vorschau', async () => {
    const ablage = new OneDriveAblage({}, { ladeDatei: async () => Buffer.alloc(0) });
    const ergebnis = await ablage.lege(monat({ positionen: [pos({ id: 'a' })] }));

    expect(ergebnis.ausgefuehrt).toBe(false);
    expect(ergebnis.hinweis).toContain('Vorschau');
    expect(ergebnis.eintraege).toHaveLength(1);
  });
});

describe('Ablegen ueber n8n', () => {
  /** Gewartete Zeiten je Instanz - so laesst sich die Drosselung pruefen. */
  let gewartet: number[] = [];

  beforeEach(() => {
    gewartet = [];
  });

  const bereit = (fetchImpl: typeof fetch, opts: Partial<AblageOptionen> = {}) =>
    new OneDriveAblage(
      {
        ordnerUrl: 'https://n8n.example/ordner',
        ablageUrl: 'https://n8n.example/ablage',
        fetchImpl,
        // Im Test wird nicht wirklich gewartet, nur mitgeschrieben.
        schlafImpl: async (ms) => {
          gewartet.push(ms);
        },
        ...opts,
      },
      { ladeDatei: async () => Buffer.from('%PDF-1.4 x') },
    );

  const antwort = (koerper: unknown) =>
    ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(koerper),
    }) as unknown as Response;

  /** Fehlerantwort mit optionalem Retry-After. */
  const fehler = (status: number, retryAfter?: string) =>
    ({
      ok: false,
      status,
      text: async () => 'ausgelastet',
      headers: { get: (name: string) => (name === 'retry-after' ? (retryAfter ?? null) : null) },
    }) as unknown as Response;

  it('kommt mit der echten Antwort des Ordner-Workflows durch', async () => {
    // Ende zu Ende mit dem tatsaechlichen Rueckgabekoerper - der Test oben
    // prueft nur die Suchfunktion, dieser den ganzen Weg bis zur Ablage.
    const aufrufe: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      aufrufe.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return antwort(
        String(url).endsWith('/ordner')
          ? [{ id: '017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B' }]
          : { ok: true },
      );
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, { pauseMs: 0 }).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.ausgefuehrt).toBe(true);
    expect(ergebnis.ordnerId).toBe('017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B');
    expect(ergebnis.hinweis).toBeUndefined();
    expect(aufrufe[1]!.body).toMatchObject({
      ordnerId: '017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B',
    });
  });

  it('holt die Ordner-ID und legt jede Datei ab', async () => {
    const aufrufe: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      aufrufe.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return antwort(String(url).endsWith('/ordner') ? { ordnerId: 'ORDNER-123' } : { ok: true });
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a', verwendungszweck: 'Buerobedarf' })] }),
      false,
    );

    expect(ergebnis.ausgefuehrt).toBe(true);
    expect(ergebnis.ordnerId).toBe('ORDNER-123');

    // Liste mit einem Eintrag, Jahr vierstellig - so erwartet es der Workflow.
    expect(aufrufe[0]!.body).toEqual([{ jahr: '2026', monat: '06' }]);
    expect(aufrufe[1]!.body).toMatchObject({
      ordnerId: 'ORDNER-123',
      unterordner: 'Bar',
      dateiname: 'a.pdf',
    });
  });

  it('macht ohne ausdruecklichen Auftrag nichts', async () => {
    const fetchImpl = vi.fn(async () => antwort({ ordnerId: 'X' }));

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      true,
    );

    expect(ergebnis.ausgefuehrt).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('vermerkt einen Fehlschlag an der Datei, statt alles abzubrechen', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/ordner')) return antwort({ ordnerId: 'X' });
      return { ok: false, status: 500, text: async () => 'kaputt' } as unknown as Response;
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' }), pos({ id: 'b' })] }),
      false,
    );

    expect(ergebnis.eintraege).toHaveLength(2);
    expect(ergebnis.eintraege.every((e) => e.fehler)).toBe(true);
  });

  it('legt zwischen zwei Dateien eine Pause ein', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      antwort(String(url).endsWith('/ordner') ? { ordnerId: 'X' } : { ok: true }),
    );

    await bereit(fetchImpl as unknown as typeof fetch, { pauseMs: 250 }).lege(
      monat({ positionen: [pos({ id: 'a' }), pos({ id: 'b' }), pos({ id: 'c' })] }),
      false,
    );

    // Drei Dateien, zwei Pausen - vor der ersten wird nicht gewartet.
    expect(gewartet).toEqual([250, 250]);
  });

  it('versucht es nach einem 429 erneut und haelt sich an Retry-After', async () => {
    let ablagen = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/ordner')) return antwort({ ordnerId: 'X' });
      ablagen++;
      return ablagen === 1 ? fehler(429, '5') : antwort({ ok: true });
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, { pauseMs: 0 }).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.eintraege[0]!.fehler).toBeUndefined();
    expect(ablagen).toBe(2);
    // Retry-After in Sekunden, umgerechnet in Millisekunden.
    expect(gewartet).toEqual([5000]);
  });

  it('gibt bei dauerhafter Ueberlast auf, statt endlos zu wiederholen', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/ordner') ? antwort({ ordnerId: 'X' }) : fehler(503),
    );

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, {
      pauseMs: 0,
      versuche: 3,
    }).lege(monat({ positionen: [pos({ id: 'a' })] }), false);

    expect(ergebnis.eintraege[0]!.fehler).toContain('503');
    // Ein Ordner-Aufruf plus drei Ablage-Versuche.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // Rueckzug verdoppelt sich: 1s, dann 2s.
    expect(gewartet).toEqual([1000, 2000]);
  });

  it('wiederholt einen 400 nicht - der faellt beim zweiten Mal genauso aus', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith('/ordner') ? antwort({ ordnerId: 'X' }) : fehler(400),
    );

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, { pauseMs: 0 }).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.eintraege[0]!.fehler).toContain('400');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(gewartet).toEqual([]);
  });

  it('meldet einen fehlenden Monatsordner verstaendlich', async () => {
    const fetchImpl = vi.fn(async () => antwort({ objects: [] }));

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.ausgefuehrt).toBe(false);
    expect(ergebnis.hinweis).toContain('kein Ausgabenordner');
    // Ohne die Antwort des Workflows laesst sich nicht unterscheiden, ob er
    // nichts gefunden hat oder ob er gar nicht erst antwortet.
    expect(ergebnis.hinweis).toContain('jahr: "2026"');
    expect(ergebnis.hinweis).toContain('{"objects":[]}');
  });

  it('erkennt einen Webhook, der nur den Start bestaetigt', async () => {
    // Die haeufigste Fehlkonfiguration: "Respond: Immediately". n8n schickt
    // dann nie das Ergebnis - von "nichts gefunden" nicht zu unterscheiden.
    const fetchImpl = vi.fn(async () => antwort({ message: 'Workflow was started' }));

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.hinweis).toContain('antwortet sofort');
    expect(ergebnis.hinweis).toContain('Respond to Webhook');
  });

  it('unterscheidet ein leeres Ergebnis von einer kaputten Antwort', async () => {
    const fetchImpl = vi.fn(async () => antwort([]));

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
    );

    expect(ergebnis.hinweis).toContain('keinen Ordner');
  });

  it('verschiebt eine vorhandene Datei, statt eine Kopie hochzuladen', async () => {
    const aufrufe: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const pfad = String(url);
      aufrufe.push({ url: pfad, body: JSON.parse(String(init.body)) });

      if (pfad.endsWith('/ordner')) return antwort({ id: 'ORDNER-1' });
      if (pfad.endsWith('/dateien')) {
        return antwort([
          { id: 'od-1', name: 'a.pdf', size: 1 },
          { id: 'od-2', name: 'Fremd.pdf', size: 99 },
        ]);
      }
      return antwort({ ok: true });
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, {
      pauseMs: 0,
      ordnerDateienUrl: 'https://n8n.example/dateien',
      verschiebeUrl: 'https://n8n.example/verschieben',
    }).lege(monat({ positionen: [pos({ id: 'a' })] }), false);

    expect(ergebnis.eintraege[0]).toMatchObject({
      aktion: 'verschieben',
      quelle: { id: 'od-1' },
    });

    // Verschoben, nicht hochgeladen: kein Aufruf an den Ablage-Webhook.
    const ziele = aufrufe.map((a) => a.url);
    expect(ziele).toContain('https://n8n.example/verschieben');
    expect(ziele).not.toContain('https://n8n.example/ablage');
    expect(aufrufe.at(-1)!.body).toMatchObject({
      ordnerId: 'ORDNER-1',
      unterordner: 'Bar',
      dateiId: 'od-1',
    });

    // Was zu keiner Buchung passt, bleibt liegen - und wird gemeldet.
    expect(ergebnis.uebrig?.map((d) => d.dateiname)).toEqual(['Fremd.pdf']);
  });

  it('laedt hoch, wenn in OneDrive nichts Passendes liegt', async () => {
    const ziele: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const pfad = String(url);
      ziele.push(pfad);
      if (pfad.endsWith('/ordner')) return antwort({ id: 'ORDNER-1' });
      if (pfad.endsWith('/dateien')) return antwort([]);
      return antwort({ ok: true });
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, {
      pauseMs: 0,
      ordnerDateienUrl: 'https://n8n.example/dateien',
      verschiebeUrl: 'https://n8n.example/verschieben',
    }).lege(monat({ positionen: [pos({ id: 'a' })] }), false);

    expect(ergebnis.eintraege[0]!.aktion).toBe('hochladen');
    expect(ziele).toContain('https://n8n.example/ablage');
  });

  it('laedt hoch, wenn sich der Monatsordner nicht auflisten laesst', async () => {
    // Ein Ausfall des Listen-Workflows darf die Ablage nicht anhalten.
    const ziele: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const pfad = String(url);
      ziele.push(pfad);
      if (pfad.endsWith('/ordner')) return antwort({ id: 'ORDNER-1' });
      if (pfad.endsWith('/dateien')) return fehler(500);
      return antwort({ ok: true });
    });

    const ergebnis = await bereit(fetchImpl as unknown as typeof fetch, {
      pauseMs: 0,
      versuche: 1,
      ordnerDateienUrl: 'https://n8n.example/dateien',
      verschiebeUrl: 'https://n8n.example/verschieben',
    }).lege(monat({ positionen: [pos({ id: 'a' })] }), false);

    expect(ergebnis.ausgefuehrt).toBe(true);
    expect(ergebnis.eintraege[0]!.aktion).toBe('hochladen');
    expect(ziele).toContain('https://n8n.example/ablage');
  });

  it('laedt hoch, solange die Verschiebe-Adresse fehlt', async () => {
    // Nur die Liste ohne das Verschieben waere nutzlos - dann gar nicht erst
    // auflisten und den Workflow unnoetig belasten.
    const ziele: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      ziele.push(String(url));
      return antwort(String(url).endsWith('/ordner') ? { id: 'X' } : { ok: true });
    });

    await bereit(fetchImpl as unknown as typeof fetch, {
      pauseMs: 0,
      ordnerDateienUrl: 'https://n8n.example/dateien',
    }).lege(monat({ positionen: [pos({ id: 'a' })] }), false);

    expect(ziele).not.toContain('https://n8n.example/dateien');
    expect(ziele).toContain('https://n8n.example/ablage');
  });

  it('meldet, welche Datei gerade drankommt', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      antwort(String(url).endsWith('/ordner') ? { ordnerId: 'X' } : { ok: true }),
    );

    const staende: LadeFortschritt[] = [];
    await bereit(fetchImpl as unknown as typeof fetch, { pauseMs: 0 }).lege(
      monat({ positionen: [pos({ id: 'a' }), pos({ id: 'b' })] }),
      false,
      (f) => staende.push(f),
    );

    const schritte = staende.map((s) => s.schritt);
    expect(schritte).toContain('einteilung');
    expect(schritte).toContain('ordner');
    expect(schritte).toContain('ablegen');

    // Der letzte Stand sagt, was tatsaechlich durchging.
    const letzter = staende.at(-1)!;
    expect(letzter.schritt).toBe('ablegen');
    expect(letzter.erledigt).toBe(2);
    expect(letzter.gesamt).toBe(2);
    expect(letzter.text).toContain('2 von 2');
  });

  it('meldet auch, wenn der Monatsordner fehlt - der Lauf endet dort', async () => {
    const fetchImpl = vi.fn(async () => antwort({ objects: [] }));

    const staende: LadeFortschritt[] = [];
    await bereit(fetchImpl as unknown as typeof fetch).lege(
      monat({ positionen: [pos({ id: 'a' })] }),
      false,
      (f) => staende.push(f),
    );

    expect(staende.at(-1)).toMatchObject({ schritt: 'ordner', text: 'nicht gefunden' });
    expect(staende.map((s) => s.schritt)).not.toContain('ablegen');
  });
});

describe('sucheOrdnerId', () => {
  it('findet die ID unter verschiedenen Feldnamen', () => {
    expect(sucheOrdnerId({ ordnerId: '01ABCDEF' })).toBe('01ABCDEF');
    expect(sucheOrdnerId({ folderId: '01ABCDEF' })).toBe('01ABCDEF');
    expect(sucheOrdnerId([{ id: '01ABCDEF' }])).toBe('01ABCDEF');
    expect(sucheOrdnerId({ objects: { item: { driveItemId: '01ABCDEF' } } })).toBe('01ABCDEF');
  });

  it('liest die Antwort des Workflows so, wie sie tatsaechlich kommt', () => {
    // Wortwoertlich der Rueckgabekoerper von "Find Ausgabenordner":
    // eine Liste mit einem Objekt, die Kennung unter "id".
    expect(sucheOrdnerId([{ id: '017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B' }])).toBe(
      '017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B',
    );
  });

  it('nimmt keine Wortgruppe fuer eine Kennung', () => {
    expect(sucheOrdnerId({ text: 'kein Ordner gefunden' })).toBeUndefined();
    expect(sucheOrdnerId({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('leseDateiliste', () => {
  it('liest Kennung, Name und Groesse aus der OneDrive-Antwort', () => {
    expect(
      leseDateiliste([{ id: '01ABC', name: 'Beleg.pdf', size: 4711 }]),
    ).toEqual([{ id: '01ABC', dateiname: 'Beleg.pdf', groesse: 4711 }]);
  });

  it('nimmt Abrufadresse und Inhaltsmarke mit - ohne sie gibt es keinen Abgleich', () => {
    // Graph legt beides jeder Dateiantwort bei. Die Adresse ist vorab
    // beglaubigt, der cTag aendert sich mit dem Inhalt.
    expect(
      leseDateiliste([
        {
          id: '01ABC',
          name: 'Beleg.pdf',
          size: 4711,
          cTag: '"c:{EA85},0"',
          '@microsoft.graph.downloadUrl': 'https://example.invalid/inhalt',
        },
      ]),
    ).toEqual([
      {
        id: '01ABC',
        dateiname: 'Beleg.pdf',
        groesse: 4711,
        downloadUrl: 'https://example.invalid/inhalt',
        cTag: '"c:{EA85},0"',
      },
    ]);
  });

  it('ueberspringt Ordner - die sollen nicht in sich selbst wandern', () => {
    expect(
      leseDateiliste([
        { id: '01ORD', name: 'Konto', folder: { childCount: 3 } },
        { id: '01DAT', name: 'Beleg.pdf', size: 1 },
      ]).map((d) => d.id),
    ).toEqual(['01DAT']);
  });

  it('kommt ohne Groessenangabe aus', () => {
    expect(leseDateiliste([{ id: '01ABC', name: 'Beleg.pdf' }])).toEqual([
      { id: '01ABC', dateiname: 'Beleg.pdf' },
    ]);
  });

  it('ignoriert Eintraege ohne Kennung oder Namen', () => {
    expect(leseDateiliste([{ name: 'ohne Kennung.pdf' }, { id: '01X' }, 'Text'])).toEqual([]);
  });
});
