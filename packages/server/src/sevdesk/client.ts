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
   * Zur Zeitzone: sevDesk liefert valueDate mit Offset, z. B.
   * "2026-06-01T00:00:00+02:00". In UTC ist das der 31.05. um 22:00 Uhr. Ein
   * Vergleich ueber Zeitstempel wuerde deshalb Buchungen vom Monatsersten
   * verlieren und solche vom Ersten des Folgemonats faelschlich aufnehmen.
   * Massgeblich ist das Datum so, wie sevDesk es anzeigt - also der Datumsteil
   * des Strings. Genau darauf wird gefiltert.
   *
   * SPIKE: sevDesk dokumentiert die Datumsfilter fuer diesen Endpunkt nur
   * unvollstaendig. Wir senden Unix-Sekunden und weiten das Fenster serverseitig
   * um zwei Tage, damit keine Randbuchung verlorengeht, egal wie der Server die
   * Zeitstempel interpretiert. Die exakte Abgrenzung macht der Filter unten.
   */
  async holeTransaktionen(
    checkAccountId: string,
    von: string,
    bis: string,
  ): Promise<CheckAccountTransaction[]> {
    const roh = await this.holeAlle<CheckAccountTransaction>('/CheckAccountTransaction', {
      'checkAccount[id]': checkAccountId,
      'checkAccount[objectName]': 'CheckAccount',
      startDate: unixSekunden(verschiebeTage(von, -2), false),
      endDate: unixSekunden(verschiebeTage(bis, 2), true),
    });

    return roh.filter((t) => {
      if (t.checkAccount?.id !== checkAccountId) return false;
      const datum = String(t.valueDate ?? '').slice(0, 10);
      return datum >= von && datum <= bis;
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

  /**
   * Laedt eine Datei von sevDesk.
   *
   * sevDesk antwortet auf den Datei-Endpunkten uneinheitlich: mal mit einer
   * JSON-Huelle, die den Inhalt base64-kodiert traegt, mal mit dem rohen
   * Dateistrom. Beobachtet wurde beides. Diese Methode entscheidet anhand des
   * tatsaechlichen Content-Type statt anhand einer Annahme - der frueher
   * bedingungslose Aufruf von res.json() ist an einem "%PDF-1.4" zerbrochen
   * und hat den kompletten Belegabruf scheitern lassen.
   */
  private async holeDatei(
    pfad: string,
    query: Record<string, string | number | undefined>,
    standardName: string,
  ): Promise<Datei | null> {
    const url = new URL(`${this.baseUrl}${pfad}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let letzterFehler: unknown;
    for (let versuch = 0; versuch <= this.maxRetries; versuch++) {
      try {
        const res = await this.doFetch(url, {
          headers: {
            Authorization: this.token,
            // Beide Formate ausdruecklich akzeptieren.
            Accept: 'application/json, application/pdf, application/octet-stream, */*',
          },
        });

        if (res.status === 404) return null;

        if ((res.status === 429 || res.status >= 500) && versuch < this.maxRetries) {
          await warte(2 ** versuch * 500);
          continue;
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

        const contentType = res.headers.get('content-type') ?? '';
        const rohdaten = Buffer.from(await res.arrayBuffer());

        // Fall 1: JSON-Huelle mit base64-Inhalt.
        if (contentType.includes('json')) {
          return this.leseJsonDatei(rohdaten, standardName);
        }

        // Fall 2: roher Dateistrom.
        if (rohdaten.byteLength === 0) return null;
        return {
          daten: rohdaten,
          dateiname: dateinameAusHeader(res.headers.get('content-disposition')) ?? standardName,
          mimeType: contentType.split(';')[0]?.trim() || erkenneMimeType(rohdaten),
        };
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
      : new Error(`Dateiabruf ${pfad} fehlgeschlagen`);
  }

  /**
   * Wertet die JSON-Variante aus. sevDesk legt den Inhalt je nach Endpunkt
   * unter objects.content ab oder gibt objects direkt als Base64-String zurueck.
   */
  private leseJsonDatei(rohdaten: Buffer, standardName: string): Datei | null {
    let geparst: SevDeskAntwort<DokumentBild | RechnungsPdf | string | null>;
    try {
      geparst = JSON.parse(rohdaten.toString('utf8'));
    } catch {
      // Als JSON angekuendigt, war aber keines - dann eben als Datei behandeln.
      return {
        daten: rohdaten,
        dateiname: standardName,
        mimeType: erkenneMimeType(rohdaten),
      };
    }

    const obj = geparst.objects;
    if (!obj) return null;

    if (typeof obj === 'string') {
      return {
        daten: Buffer.from(obj, 'base64'),
        dateiname: standardName,
        mimeType: 'application/pdf',
      };
    }

    if (!obj.content) return null;
    return {
      daten: Buffer.from(obj.content, 'base64'),
      dateiname: obj.filename ?? standardName,
      mimeType: obj.mimeType ?? 'application/pdf',
    };
  }

  /** Belegdatei eines Vouchers, oder null wenn keine angehaengt ist. */
  async holeVoucherDatei(voucherId: string): Promise<Datei | null> {
    return this.holeDatei(
      `/Voucher/${voucherId}/getDocumentImage`,
      {},
      `beleg-${voucherId}.pdf`,
    );
  }

  /** Ausgangsrechnung als PDF - Fallback, wenn n8n/OneDrive nichts liefert. */
  async holeRechnungsPdf(invoiceId: string): Promise<Datei | null> {
    return this.holeDatei(
      `/Invoice/${invoiceId}/getPdf`,
      { download: 'false' },
      `rechnung-${invoiceId}.pdf`,
    );
  }
}

export interface Datei {
  daten: Buffer;
  dateiname: string;
  mimeType: string;
}

/** Dateinamen aus einem Content-Disposition-Header ziehen. */
function dateinameAusHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const stern = header.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i);
  if (stern?.[1]) return decodeURIComponent(stern[1]);
  const einfach = header.match(/filename="?([^";]+)"?/i);
  return einfach?.[1];
}

/** Notbehelf, wenn der Server keinen brauchbaren Content-Type mitschickt. */
function erkenneMimeType(daten: Buffer): string {
  const kopf = daten.subarray(0, 5).toString('latin1');
  if (kopf.startsWith('%PDF-')) return 'application/pdf';
  if (daten[0] === 0xff && daten[1] === 0xd8) return 'image/jpeg';
  if (kopf.startsWith('\x89PNG')) return 'image/png';
  return 'application/octet-stream';
}

/** ISO-Datum -> Unix-Sekunden. `endeDesTages` schiebt auf 23:59:59. */
function unixSekunden(isoDatum: string, endeDesTages: boolean): number {
  const zeit = endeDesTages ? 'T23:59:59Z' : 'T00:00:00Z';
  return Math.floor(Date.parse(`${isoDatum}${zeit}`) / 1000);
}

function verschiebeTage(isoDatum: string, tage: number): string {
  const d = new Date(`${isoDatum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

function warte(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
