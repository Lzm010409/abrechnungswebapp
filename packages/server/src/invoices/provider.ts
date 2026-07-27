import type { Aktenzeichen } from '@abrechnung/shared';
import { dateiPraefixMitIndex, erzeugeVarianten } from '../aktenzeichen/index.js';
import type { SevDeskClient } from '../sevdesk/client.js';

export interface RechnungsTreffer {
  daten: Buffer;
  dateiname: string;
  mimeType: string;
  /** Aktenzeichen-Variante, unter der die Datei gefunden wurde. */
  gefundenMit: string;
  quelle: 'onedrive-n8n' | 'sevdesk-invoice';
}

export interface RechnungsAbrufErgebnis {
  treffer: RechnungsTreffer[];
  /** Alle durchprobierten Varianten - fuer die Fehlermeldung in der UI. */
  versucht: string[];
  fehler?: string;
}

/**
 * Beschafft die Ausgangsrechnung zu einem Aktenzeichen.
 *
 * Zwei Quellen in dieser Reihenfolge:
 *  1. n8n -> OneDrive-Gutachtenordner. Liefert das Original, so wie es der
 *     Auftraggeber bekommen hat. Bevorzugt, weil es genau die Datei ist, die
 *     der alte Skill ueber "Find Rechnung" geholt hat.
 *  2. sevDesk GET /Invoice/{id}/getPdf als Rueckfallebene.
 */
export interface RechnungsProvider {
  holeRechnung(
    az: Aktenzeichen,
    invoiceId?: string,
  ): Promise<RechnungsAbrufErgebnis>;
}

export interface N8nOptionen {
  url: string;
  authHeader?: string;
  authValue?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Rohantwort des n8n-Workflows "Find Rechnung". */
interface N8nAntwortEintrag {
  file?: string | null;
  filename?: string | null;
}

export class StandardRechnungsProvider implements RechnungsProvider {
  constructor(
    private readonly sevdesk: SevDeskClient,
    private readonly n8n?: N8nOptionen,
  ) {}

  async holeRechnung(
    az: Aktenzeichen,
    invoiceId?: string,
  ): Promise<RechnungsAbrufErgebnis> {
    const versucht: string[] = [];

    if (this.n8n) {
      // Retry-Kette nach aktenzeichen.md: Original, Vormonat, anderer Index.
      for (const variante of erzeugeVarianten(az)) {
        versucht.push(variante);
        try {
          const treffer = await this.frageN8n(variante);
          if (treffer.length > 0) {
            return { treffer: this.praezisiere(treffer, az), versucht };
          }
        } catch (err) {
          // Ein Netzwerkfehler soll nicht die ganze Kette abbrechen -
          // die naechste Variante bekommt noch eine Chance.
          const meldung = err instanceof Error ? err.message : String(err);
          if (variante === versucht[versucht.length - 1] && versucht.length === 1) {
            // Erster Versuch bereits kaputt: wahrscheinlich Konfigurationsfehler.
            return {
              treffer: [],
              versucht,
              fehler: `n8n nicht erreichbar: ${meldung}`,
            };
          }
        }
      }
    }

    // Rueckfallebene sevDesk
    if (invoiceId) {
      const pdf = await this.sevdesk.holeRechnungsPdf(invoiceId);
      if (pdf) {
        return {
          treffer: [
            {
              daten: pdf.daten,
              dateiname: pdf.dateiname,
              mimeType: pdf.mimeType,
              gefundenMit: az.normalisiert,
              quelle: 'sevdesk-invoice',
            },
          ],
          versucht,
        };
      }
    }

    return {
      treffer: [],
      versucht,
      fehler: this.n8n
        ? `Keine Rechnungsdatei gefunden (${versucht.length} Varianten geprueft)`
        : 'N8N_FIND_RECHNUNG_URL nicht gesetzt und keine sevDesk-Rechnung verknuepft',
    };
  }

  private async frageN8n(rechnungsnummer: string): Promise<RechnungsTreffer[]> {
    const n8n = this.n8n!;
    const doFetch = n8n.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), n8n.timeoutMs ?? 60_000);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (n8n.authHeader && n8n.authValue) headers[n8n.authHeader] = n8n.authValue;

      const res = await doFetch(n8n.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Rechnungsnummer: rechnungsnummer }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`n8n antwortete mit HTTP ${res.status}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      const rohdaten = Buffer.from(await res.arrayBuffer());

      // Der Workflow antwortet als JSON-Array. Wird er aber auf "Respond with
      // binary" umgestellt, kommt die PDF-Datei direkt - dann waere ein
      // bedingungsloses res.json() an einem "%PDF-" zerbrochen.
      if (!contentType.includes('json')) {
        if (rohdaten.byteLength === 0) return [];
        return [
          {
            daten: rohdaten,
            dateiname: `${rechnungsnummer.replace(/\//g, '_')}.pdf`,
            mimeType: contentType.split(';')[0]?.trim() || 'application/pdf',
            gefundenMit: rechnungsnummer,
            quelle: 'onedrive-n8n' as const,
          },
        ];
      }

      const roh = JSON.parse(rohdaten.toString('utf8')) as
        | N8nAntwortEintrag[]
        | N8nAntwortEintrag;
      const liste = Array.isArray(roh) ? roh : [roh];

      // Der Workflow filtert per startsWith auf die Basis OHNE Rechnungsindex.
      // Er kann daher bei TG01 und TG02 beide Dateien zurueckgeben. Anders als
      // der alte Skill nehmen wir nicht blind [0], sondern reichen alles durch.
      return liste
        .filter((e): e is { file: string; filename?: string | null } =>
          typeof e?.file === 'string' && e.file.length > 0,
        )
        .map((e) => ({
          daten: Buffer.from(e.file, 'base64'),
          dateiname: e.filename ?? `${rechnungsnummer.replace(/\//g, '_')}.pdf`,
          mimeType: 'application/pdf',
          gefundenMit: rechnungsnummer,
          quelle: 'onedrive-n8n' as const,
        }));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Grenzt mehrere Treffer auf eine konkrete Rechnung ein - aber nur, wenn der
   * Rechnungsindex ueberhaupt bekannt ist.
   *
   * Der Workflow filtert im Gutachtenordner per startsWith auf das
   * AKTENZEICHEN und liefert damit alle Rechnungen des Vorgangs zurueck
   * (TG01 Gutachten, TG02 Fahrtkosten, TG03 ...). Stand im Verwendungszweck
   * nur "0724/1279TG" ohne Index, gibt es nichts, woran man die richtige
   * erkennen koennte - dann bleiben alle als Kandidaten stehen und der Nutzer
   * entscheidet. Ein Zugriff auf [0] waere hier geraten.
   */
  private praezisiere(treffer: RechnungsTreffer[], az: Aktenzeichen): RechnungsTreffer[] {
    if (treffer.length <= 1) return treffer;

    const exakt = dateiPraefixMitIndex(az);
    if (!exakt) return treffer;

    const genau = treffer.filter((t) => t.dateiname.includes(exakt));
    return genau.length === 1 ? genau : treffer;
  }
}
