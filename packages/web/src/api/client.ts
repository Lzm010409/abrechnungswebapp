import type {
  AblageErgebnis,
  Capabilities,
  LadeEreignis,
  Monat,
  MonatsReview,
  PositionsPatch,
  ZuordnungsVorschlag,
} from '@abrechnung/shared';

/** Fehler mit der Meldung, die der Server geliefert hat. */
export class ApiFehler extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiFehler';
  }
}

async function anfrage<T>(pfad: string, init?: RequestInit): Promise<T> {
  /*
   * Der Typ wird nur gesetzt, wenn tatsaechlich JSON mitgeht. Ein POST ohne
   * Body, aber mit "application/json" im Kopf, weist Fastify mit 400 ab
   * (FST_ERR_CTP_EMPTY_JSON_BODY) - das hat alle Aufrufe ohne Body getroffen,
   * darunter saemtliche KI-Funktionen.
   */
  const hatJsonKoerper =
    init?.body !== undefined && init.body !== null && !(init.body instanceof FormData);

  const res = await fetch(pfad, {
    ...init,
    headers: {
      ...(hatJsonKoerper ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let meldung = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { fehler?: string };
      if (body.fehler) meldung = body.fehler;
    } catch {
      // Antwort war kein JSON - Statuscode als Meldung belassen.
    }
    throw new ApiFehler(meldung, res.status);
  }

  return (await res.json()) as T;
}

/**
 * Liest den Lade-Stream (Server-Sent Events) Ereignis fuer Ereignis.
 *
 * Bewusst ueber fetch statt EventSource: EventSource verbindet nach dem Ende
 * des Streams automatisch neu und wuerde den kompletten Abruf wiederholen -
 * und es kann keinen 401 von einem normalen Verbindungsabbruch unterscheiden.
 */
export async function leseLadeStream(
  monat: string,
  optionen: { neuLaden?: boolean; signal?: AbortSignal },
  aufEreignis: (ereignis: LadeEreignis) => void,
): Promise<void> {
  const res = await fetch(
    `/api/months/${monat}/stream${optionen.neuLaden ? '?refresh=true' : ''}`,
    { headers: { Accept: 'text/event-stream' }, signal: optionen.signal },
  );

  if (!res.ok) {
    let meldung = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { fehler?: string };
      if (body.fehler) meldung = body.fehler;
    } catch {
      // kein JSON - Statuscode genuegt
    }
    throw new ApiFehler(meldung, res.status);
  }
  if (!res.body) throw new ApiFehler('Der Server liefert keinen Datenstrom.', 500);

  const leser = res.body.getReader();
  const dekoder = new TextDecoder();
  let puffer = '';

  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    puffer += dekoder.decode(value, { stream: true });

    let ende = puffer.indexOf('\n\n');
    while (ende >= 0) {
      const block = puffer.slice(0, ende);
      puffer = puffer.slice(ende + 2);
      for (const zeile of block.split('\n')) {
        if (!zeile.startsWith('data:')) continue;
        aufEreignis(JSON.parse(zeile.slice(5).trim()) as LadeEreignis);
      }
      ende = puffer.indexOf('\n\n');
    }
  }
}

export const api = {
  capabilities: () => anfrage<Capabilities>('/api/capabilities'),

  monat: (monat: string, neuLaden = false) =>
    anfrage<Monat>(`/api/months/${monat}${neuLaden ? '?refresh=true' : ''}`),

  stream: leseLadeStream,

  abmelden: (auchBeiMicrosoft = false) =>
    anfrage<{ abgemeldet: boolean; weiterZu?: string }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ abmeldenBeiMicrosoft: auchBeiMicrosoft }),
    }),

  synchronisiere: (monat: string) =>
    anfrage<Monat>(`/api/months/${monat}/sync`, { method: 'POST' }),

  patchePosition: (monat: string, positionId: string, patch: PositionsPatch) =>
    anfrage<Monat>(`/api/months/${monat}/positions/${positionId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** Dieselbe Aenderung an mehreren Buchungen. */
  patcheMehrere: (monat: string, positionIds: string[], patch: PositionsPatch) =>
    anfrage<Monat>(`/api/months/${monat}/positions`, {
      method: 'PATCH',
      body: JSON.stringify({ positionIds, patch }),
    }),

  setzeZurueck: (monat: string, positionId: string) =>
    anfrage<Monat>(`/api/months/${monat}/positions/${positionId}/override`, {
      method: 'DELETE',
    }),

  ladeBelegHoch: (monat: string, positionId: string, datei: File) => {
    const form = new FormData();
    form.append('datei', datei);
    return anfrage<Monat>(`/api/months/${monat}/positions/${positionId}/upload`, {
      method: 'POST',
      body: form,
    });
  },

  ladeKontoauszugHoch: (monat: string, datei: File) => {
    const form = new FormData();
    form.append('datei', datei);
    return anfrage<Monat>(`/api/months/${monat}/statements`, {
      method: 'POST',
      body: form,
    });
  },

  loescheKontoauszug: (monat: string, id: string) =>
    anfrage<Monat>(`/api/months/${monat}/statements/${id}`, { method: 'DELETE' }),

  dateiUrl: (monat: string, dateiId: string) => `/api/months/${monat}/files/${dateiId}`,

  /** Erzeugt das Abrechnungs-PDF und gibt eine Blob-URL zurueck. */
  erzeugeBericht: async (monat: string, buero?: string): Promise<Blob> => {
    const res = await fetch(`/api/months/${monat}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buero }),
    });
    if (!res.ok) throw new ApiFehler('PDF konnte nicht erzeugt werden', res.status);
    return res.blob();
  },

  /** Belege in die OneDrive-Monatsordner einsortieren. */
  ablage: (monat: string, ausfuehren = false) =>
    anfrage<AblageErgebnis>(
      `/api/months/${monat}/ablage${ausfuehren ? '?ausfuehren=true' : ''}`,
      { method: 'POST' },
    ),

  ki: {
    extrahiere: (monat: string) =>
      anfrage<{ neuAnalysiert: number; monat: Monat }>(
        `/api/months/${monat}/ai/extract`,
        { method: 'POST' },
      ),

    schlageZuordnungVor: (monat: string) =>
      anfrage<{ vorschlaege: ZuordnungsVorschlag[] }>(`/api/months/${monat}/ai/match`, {
        method: 'POST',
      }),

    schlageAktenzeichenVor: (monat: string, positionId: string) =>
      anfrage<{ kandidaten: string[] }>(
        `/api/months/${monat}/ai/aktenzeichen/${positionId}`,
        { method: 'POST' },
      ),

    pruefe: (monat: string) =>
      anfrage<MonatsReview>(`/api/months/${monat}/ai/review`, { method: 'POST' }),
  },
};

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

const EURO = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

export function euro(betrag: number): string {
  return EURO.format(betrag);
}

export function deutschesDatum(iso: string): string {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}

const MONATSNAMEN = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export function monatsTitel(monat: string): string {
  const [jahr, mon] = monat.split('-');
  return `${MONATSNAMEN[Number(mon) - 1] ?? monat} ${jahr}`;
}

export function aktuellerMonat(): string {
  const heute = new Date();
  return `${heute.getFullYear()}-${String(heute.getMonth() + 1).padStart(2, '0')}`;
}

export function verschiebeMonat(monat: string, delta: number): string {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(jahr, mon - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
