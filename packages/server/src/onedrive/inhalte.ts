import type { OneDriveDatei } from '@abrechnung/shared';
import { berechneAbdruck, type Abdruck, type Belegleser } from './abdruck.js';

/**
 * Beschafft die Fingerabdruecke der Dateien im Monatsordner.
 *
 * Dafuer muss jede Datei einmal gelesen werden. Geholt wird sie ueber die
 * `@microsoft.graph.downloadUrl`, die Graph jeder Dateiantwort beilegt: sie ist
 * vorab beglaubigt, sodass weder ein Zugangstoken noch ein weiterer Weg ueber
 * n8n noetig ist - und n8n bleibt von dieser Last verschont.
 *
 * Ein Monatsordner hat Groessenordnung siebzig Dateien zu je hundert Kilobyte.
 * Das einmal zu lesen dauert Sekunden, nicht Minuten; wiederholte Laeufe kosten
 * gar nichts mehr, weil die Abdruecke am `cTag` der Datei zwischengespeichert
 * werden. Der `cTag` aendert sich, sobald sich der Inhalt aendert.
 */

/** Gleichzeitige Abrufe. OneDrive vertraegt mehr, aber es eilt nicht. */
const GLEICHZEITIG = 4;
const VERSUCHE = 3;

/**
 * Zwischenspeicher der Fingerabdruecke.
 *
 * `schluessel` traegt die Herkunft mit, `marke` sagt, wann ein Abdruck
 * veraltet - bei OneDrive der `cTag`, bei den eigenen Belegen ihre dateiId,
 * die der Inhalts-Hash ist.
 */
export interface AbdruckSpeicher {
  hole(schluessel: string, marke: string | undefined): Promise<Abdruck | null>;
  lege(schluessel: string, marke: string | undefined, abdruck: Abdruck): Promise<void>;
}

export interface InhalteOptionen {
  fetchImpl?: typeof fetch;
  speicher?: AbdruckSpeicher;
  /** Liest Belege ohne Textebene - siehe abdruck.ts. */
  leser?: Belegleser;
  gleichzeitig?: number;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Meldet den Fortschritt: wie viele Dateien sind gelesen. */
  melde?: (gelesen: number, gesamt: number) => void;
}

export interface AbdruckErgebnis {
  abdruecke: Map<string, Abdruck>;
  /** Wie viele Abdruecke aus dem Zwischenspeicher kamen. */
  ausSpeicher: number;
  /** Dateien, deren Inhalt nicht zu holen war. */
  fehlgeschlagen: Array<{ datei: OneDriveDatei; fehler: string }>;
}

export async function holeAbdruecke(
  dateien: OneDriveDatei[],
  opts: InhalteOptionen = {},
): Promise<AbdruckErgebnis> {
  const doFetch = opts.fetchImpl ?? fetch;
  const gleichzeitig = Math.max(1, opts.gleichzeitig ?? GLEICHZEITIG);
  const abdruecke = new Map<string, Abdruck>();
  const fehlgeschlagen: AbdruckErgebnis['fehlgeschlagen'] = [];
  let ausSpeicher = 0;
  let fertig = 0;

  const warteschlange = [...dateien];

  const arbeite = async (): Promise<void> => {
    for (;;) {
      const datei = warteschlange.shift();
      if (!datei) return;

      try {
        const gemerkt = await opts.speicher?.hole(`onedrive:${datei.id}`, datei.cTag);
        if (gemerkt) {
          abdruecke.set(datei.id, gemerkt);
          ausSpeicher++;
          continue;
        }

        if (!datei.downloadUrl) {
          throw new Error(
            'keine downloadUrl in der Ordnerliste - der Workflow gibt die ' +
              'Graph-Antwort nicht vollstaendig weiter',
          );
        }

        const inhalt = await lade(doFetch, datei.downloadUrl);
        const abdruck = await berechneAbdruck(inhalt, datei.dateiname, opts.leser);
        abdruecke.set(datei.id, abdruck);
        await opts.speicher?.lege(`onedrive:${datei.id}`, datei.cTag, abdruck);
      } catch (err) {
        const fehler = err instanceof Error ? err.message : String(err);
        opts.log?.warn(
          { datei: datei.dateiname, err: fehler },
          'Inhalt einer OneDrive-Datei nicht lesbar - sie bleibt beim Abgleich aussen vor',
        );
        fehlgeschlagen.push({ datei, fehler });
      } finally {
        fertig++;
        opts.melde?.(fertig, dateien.length);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(gleichzeitig, warteschlange.length) }, arbeite),
  );

  return { abdruecke, ausSpeicher, fehlgeschlagen };
}

async function lade(doFetch: typeof fetch, url: string): Promise<Buffer> {
  let letzter: unknown;

  for (let versuch = 0; versuch < VERSUCHE; versuch++) {
    try {
      const res = await doFetch(url);
      if (!res.ok) throw new Error(`OneDrive antwortete ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      letzter = err;
      if (versuch < VERSUCHE - 1) {
        await new Promise<void>((f) => setTimeout(f, 2 ** versuch * 500));
      }
    }
  }

  throw letzter instanceof Error ? letzter : new Error('Abruf fehlgeschlagen');
}
