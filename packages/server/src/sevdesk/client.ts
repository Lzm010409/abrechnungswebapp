import type {
  CheckAccount,
  CheckAccountTransaction,
  DokumentBild,
  Invoice,
  RechnungsPdf,
  SevDeskAntwort,
  Voucher,
} from './types.js';

export class SevDeskFehler extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly pfad: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'SevDeskFehler';
  }
}

export interface SevDeskClientOptionen {
  token: string;
  baseUrl: string;
  /** Maximale Wiederholungen bei 429/5xx. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Duenner, typisierter Client fuer die von uns genutzten sevDesk-Endpunkte.
 *
 * Paginierung: sevDesk liefert per Default 100 Objekte. `holeAlle` laeuft
 * ueber limit/offset, bis eine Seite kuerzer als das Limit zurueckkommt.
 */
export class SevDeskClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: SevDeskClientOptionen) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 3;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    pfad: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${pfad}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let letzterFehler: unknown;
    for (let versuch = 0; versuch <= this.maxRetries; versuch++) {
      try {
        const res = await this.doFetch(url, {
          headers: {
            // sevDesk erwartet das Token nackt im Authorization-Header,
            // ohne "Bearer "-Praefix.
            Authorization: this.token,
            Accept: 'application/json',
          },
        });

        if (res.status === 429 || res.status >= 500) {
          if (versuch < this.maxRetries) {
            await warte(2 ** versuch * 500);
            continue;
          }
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new SevDeskFehler(
            `sevDesk ${res.status} bei ${pfad}`,
            res.status,
            pfad,
            body.slice(0, 500),
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        letzterFehler = err;
        if (err instanceof SevDeskFehler) throw err;
        if (versuch < this.maxRetries) {
          await warte(2 ** versuch * 500);
          continue;
        }
      }
    }
    throw letzterFehler instanceof Error
      ? letzterFehler
      : new Error(`sevDesk-Aufruf ${pfad} fehlgeschlagen`);
  }

  /** Laeuft ueber limit/offset, bis alle Objekte eingesammelt sind. */
  private async holeAlle<T>(
    pfad: string,
    query: Record<string, string | number | undefined> = {},
    seitengroesse = 100,
  ): Promise<T[]> {
    const alle: T[] = [];
    let offset = 0;

    for (;;) {
      const antwort = await this.request<SevDeskAntwort<T[]>>(pfad, {
        ...query,
        limit: seitengroesse,
        offset,
      });
      const seite = antwort.objects ?? [];
      alle.push(...seite);
      if (seite.length < seitengroesse) break;
      offset += seitengroesse;

      // Notbremse gegen Endlosschleifen bei unerwartetem API-Verhalten.
      if (offset > 20_000) break;
    }
    return alle;
  }

  // -------------------------------------------------------------------------
  // Bankkonten
  // -------------------------------------------------------------------------

  async holeCheckAccounts(): Promise<CheckAccount[]> {
    return this.holeAlle<CheckAccount>('/CheckAccount');
  }

  /**
   * Ermittelt das Bankkonto fuer die Abrechnung.
   *
   * Ist SEVDESK_CHECK_ACCOUNT_ID gesetzt, wird nur geprueft, ob es das Konto
   * gibt. Sonst wird automatisch gewaehlt: aktives Online-Bankkonto. Bleibt
   * mehr als eines uebrig, ist die Auswahl nicht entscheidbar und der Aufruf
   * schlaegt mit einer Liste der Kandidaten fehl.
   */
  async ermittleCheckAccount(vorgabe?: string): Promise<CheckAccount> {
    const konten = await this.holeCheckAccounts();

    if (vorgabe) {
      const treffer = konten.find((k) => k.id === vorgabe);
      if (!treffer) {
        throw new Error(
          `SEVDESK_CHECK_ACCOUNT_ID=${vorgabe} existiert nicht. ` +
            `Vorhanden: ${konten.map((k) => `${k.id} (${k.name})`).join(', ')}`,
        );
      }
      return treffer;
    }

    const aktiv = konten.filter((k) => k.status === '100');
    const online = aktiv.filter((k) => k.type === 'online');
    const kandidaten = online.length > 0 ? online : aktiv;

    if (kandidaten.length === 1) return kandidaten[0]!;

    if (kandidaten.length === 0) {
      throw new Error(
        'Kein aktives Bankkonto in sevDesk gefunden. Bitte SEVDESK_CHECK_ACCOUNT_ID setzen.',
      );
    }

    throw new Error(
      `Mehrere aktive Bankkonten gefunden - bitte SEVDESK_CHECK_ACCOUNT_ID setzen: ` +
        kandidaten.map((k) => `${k.id} (${k.name}, ${k.iban ?? 'ohne IBAN'})`).join(', '),
    );
  }

  // -------------------------------------------------------------------------
  // Buchungen
  // -------------------------------------------------------------------------

  /**
   * Buchungen eines Kontos im Zeitraum [von, bis] (jeweils inklusive, ISO-Datum).
   *
   * SPIKE: sevDesk dokumentiert die Datumsfilter fuer diesen Endpunkt nur
   * unvollstaendig. Wir senden Unix-Sekunden (die in der Praxis uebliche Form).
   * Sollte der Filter serverseitig ignoriert werden, greift der zusaetzliche
   * clientseitige Filter unten - das Ergebnis stimmt also in jedem Fall,
   * schlimmstenfalls holen wir zu viele Datensaetze.
   */
  async holeTransaktionen(
    checkAccountId: string,
    von: string,
    bis: string,
  ): Promise<CheckAccountTransaction[]> {
    const roh = await this.holeAlle<CheckAccountTransaction>('/CheckAccountTransaction', {
      'checkAccount[id]': checkAccountId,
      'checkAccount[objectName]': 'CheckAccount',
      startDate: unixSekunden(von, false),
      endDate: unixSekunden(bis, true),
    });

    const vonMs = Date.parse(`${von}T00:00:00Z`);
    const bisMs = Date.parse(`${bis}T23:59:59Z`);

    return roh.filter((t) => {
      if (t.checkAccount?.id !== checkAccountId) return false;
      const ms = Date.parse(t.valueDate);
      return Number.isFinite(ms) && ms >= vonMs && ms <= bisMs;
    });
  }

  // -------------------------------------------------------------------------
  // Belege und Rechnungen
  // -------------------------------------------------------------------------

  async holeVouchers(von: string, bis: string): Promise<Voucher[]> {
    return this.holeAlle<Voucher>('/Voucher', {
      startDate: unixSekunden(von, false),
      endDate: unixSekunden(bis, true),
      'embed': 'document,supplier',
    });
  }

  async holeInvoices(von: string, bis: string): Promise<Invoice[]> {
    return this.holeAlle<Invoice>('/Invoice', {
      startDate: unixSekunden(von, false),
      endDate: unixSekunden(bis, true),
      'embed': 'contact',
    });
  }

  /**
   * Buchungen, die an diesem Beleg haengen.
   * Dokumentierter Endpunkt - Basis fuer die Rueckwaerts-Zuordnung
   * Buchung -> Beleg.
   */
  async holeVoucherTransaktionen(voucherId: string): Promise<CheckAccountTransaction[]> {
    const antwort = await this.request<SevDeskAntwort<CheckAccountTransaction[]>>(
      `/Voucher/${voucherId}/getCheckAccountTransactions`,
    );
    return antwort.objects ?? [];
  }

  /**
   * Buchungen, die an dieser Rechnung haengen.
   *
   * SPIKE: Fuer Invoice ist dieser Endpunkt nicht so klar dokumentiert wie fuer
   * Voucher. Faellt er aus, greift die Fallback-Zuordnung ueber das Aktenzeichen
   * im Verwendungszweck (siehe verknuepfer.ts) - deshalb wird der Fehler hier
   * geschluckt statt den gesamten Monatsabruf zu kippen.
   */
  async holeInvoiceTransaktionen(invoiceId: string): Promise<CheckAccountTransaction[]> {
    try {
      const antwort = await this.request<SevDeskAntwort<CheckAccountTransaction[]>>(
        `/Invoice/${invoiceId}/getCheckAccountTransactions`,
      );
      return antwort.objects ?? [];
    } catch (err) {
      if (err instanceof SevDeskFehler && (err.status === 404 || err.status === 400)) {
        return [];
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Dateien
  // -------------------------------------------------------------------------

  /** Belegdatei eines Vouchers als Buffer, oder null wenn keine angehaengt ist. */
  async holeVoucherDatei(
    voucherId: string,
  ): Promise<{ daten: Buffer; dateiname: string; mimeType: string } | null> {
    try {
      const antwort = await this.request<SevDeskAntwort<DokumentBild>>(
        `/Voucher/${voucherId}/getDocumentImage`,
      );
      const obj = antwort.objects;
      if (!obj?.content) return null;
      return {
        daten: Buffer.from(obj.content, 'base64'),
        dateiname: obj.filename ?? `beleg-${voucherId}.pdf`,
        mimeType: obj.mimeType ?? 'application/pdf',
      };
    } catch (err) {
      if (err instanceof SevDeskFehler && err.status === 404) return null;
      throw err;
    }
  }

  /** Ausgangsrechnung als PDF - Fallback, wenn n8n/OneDrive nichts liefert. */
  async holeRechnungsPdf(
    invoiceId: string,
  ): Promise<{ daten: Buffer; dateiname: string; mimeType: string } | null> {
    try {
      const antwort = await this.request<SevDeskAntwort<RechnungsPdf>>(
        `/Invoice/${invoiceId}/getPdf`,
        { download: 'false' },
      );
      const obj = antwort.objects;
      if (!obj?.content) return null;
      return {
        daten: Buffer.from(obj.content, 'base64'),
        dateiname: obj.filename ?? `rechnung-${invoiceId}.pdf`,
        mimeType: obj.mimeType ?? 'application/pdf',
      };
    } catch (err) {
      if (err instanceof SevDeskFehler && err.status === 404) return null;
      throw err;
    }
  }
}

/** ISO-Datum -> Unix-Sekunden. `endeDesTages` schiebt auf 23:59:59. */
function unixSekunden(isoDatum: string, endeDesTages: boolean): number {
  const zeit = endeDesTages ? 'T23:59:59Z' : 'T00:00:00Z';
  return Math.floor(Date.parse(`${isoDatum}${zeit}`) / 1000);
}

function warte(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
