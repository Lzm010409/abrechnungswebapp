import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Kontoauszug, Monat, Position } from '@abrechnung/shared';
import * as schema from './schema.js';

/**
 * Postgres als Cache und als Ablage fuer manuelle Entscheidungen.
 *
 * Wichtig fuer die Bedienung: `monate` ist reiner Cache und darf jederzeit
 * verworfen werden. `overrides` enthaelt die Arbeit des Nutzers und wird beim
 * erneuten Laden aus sevDesk NICHT ueberschrieben.
 *
 * Die Methodennamen und ihre Bedeutung sind unveraendert aus der frueheren
 * SQLite-Fassung uebernommen. Neu ist allein, dass jeder Aufruf ein Promise
 * liefert - eine Netzwerkdatenbank laesst sich nicht synchron befragen.
 */

/**
 * Eine Drizzle-Instanz fuer Postgres, unabhaengig vom Treiber.
 *
 * Im Betrieb ist das `postgres-js`, in den Tests eine eingebettete Postgres.
 * Beide sprechen dasselbe SQL, deshalb kennt diese Schicht den Unterschied
 * nicht.
 */
export type PostgresInstanz = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Wandelt eine ISO-Zeichenkette in einen Zeitpunkt und meldet Unsinn deutlich. */
function alsZeitpunkt(wert: string, feld: string): Date {
  const zeitpunkt = new Date(wert);
  if (Number.isNaN(zeitpunkt.getTime())) {
    throw new Error(`${feld}="${wert}" ist kein gueltiger Zeitpunkt.`);
  }
  return zeitpunkt;
}

export class Datenbank {
  constructor(
    private readonly db: PostgresInstanz,
    /** Schliesst den Verbindungspool. Fehlt, wenn die Verbindung fremdverwaltet ist. */
    private readonly beende?: () => Promise<unknown>,
  ) {}

  // -- Monatscache ----------------------------------------------------------

  async ladeMonat(monat: string): Promise<Monat | null> {
    const [zeile] = await this.db
      .select({ daten: schema.monate.daten })
      .from(schema.monate)
      .where(eq(schema.monate.monat, monat))
      .limit(1);
    return zeile ? (zeile.daten as Monat) : null;
  }

  async speichereMonat(monat: Monat): Promise<void> {
    await this.db
      .insert(schema.monate)
      .values({ monat: monat.monat, daten: monat, synchronisiertAm: new Date() })
      .onConflictDoUpdate({
        target: schema.monate.monat,
        set: { daten: monat, synchronisiertAm: new Date() },
      });
  }

  async loescheMonat(monat: string): Promise<void> {
    await this.db.delete(schema.monate).where(eq(schema.monate.monat, monat));
  }

  // -- Manuelle Korrekturen -------------------------------------------------

  async ladeOverrides(monat: string): Promise<Map<string, Partial<Position>>> {
    const zeilen = await this.db
      .select({ positionId: schema.overrides.positionId, patch: schema.overrides.patch })
      .from(schema.overrides)
      .where(eq(schema.overrides.monat, monat));
    return new Map(zeilen.map((z) => [z.positionId, z.patch as Partial<Position>]));
  }

  async speichereOverride(
    monat: string,
    positionId: string,
    patch: Partial<Position>,
  ): Promise<void> {
    const [vorhanden] = await this.db
      .select({ patch: schema.overrides.patch })
      .from(schema.overrides)
      .where(
        and(eq(schema.overrides.monat, monat), eq(schema.overrides.positionId, positionId)),
      )
      .limit(1);

    /*
     * Patches werden zusammengefuehrt, damit zwei getrennte Korrekturen
     * (erst Aktenzeichen, dann Status) sich nicht gegenseitig loeschen.
     *
     * Das Zusammenfuehren geschieht bewusst hier und nicht in SQL: ein Feld
     * mit dem Wert `undefined` bedeutet "zuruecknehmen" und faellt beim
     * Serialisieren weg, sodass wieder der sevDesk-Stand durchscheint. Ein
     * `jsonb`-Verbund in der Datenbank saehe dieses Feld nie und wuerde die
     * alte Korrektur stehen lassen.
     */
    const zusammengefuehrt = {
      ...((vorhanden?.patch as Partial<Position> | undefined) ?? {}),
      ...patch,
    };

    await this.db
      .insert(schema.overrides)
      .values({ monat, positionId, patch: zusammengefuehrt, geaendertAm: new Date() })
      .onConflictDoUpdate({
        target: [schema.overrides.monat, schema.overrides.positionId],
        set: { patch: zusammengefuehrt, geaendertAm: new Date() },
      });
  }

  async loescheOverride(monat: string, positionId: string): Promise<void> {
    await this.db
      .delete(schema.overrides)
      .where(
        and(eq(schema.overrides.monat, monat), eq(schema.overrides.positionId, positionId)),
      );
  }

  // -- Kontoauszuege --------------------------------------------------------

  async ladeKontoauszuege(monat: string): Promise<Kontoauszug[]> {
    const zeilen = await this.db
      .select({
        id: schema.kontoauszuege.id,
        dateiname: schema.kontoauszuege.dateiname,
        groesse: schema.kontoauszuege.groesse,
        seiten: schema.kontoauszuege.seiten,
        hochgeladenAm: schema.kontoauszuege.hochgeladenAm,
      })
      .from(schema.kontoauszuege)
      .where(eq(schema.kontoauszuege.monat, monat))
      .orderBy(asc(schema.kontoauszuege.reihenfolge), asc(schema.kontoauszuege.hochgeladenAm));

    return zeilen.map((z) => ({
      id: z.id,
      dateiname: z.dateiname,
      groesse: z.groesse,
      ...(z.seiten === null ? {} : { seiten: z.seiten }),
      hochgeladenAm: z.hochgeladenAm.toISOString(),
    }));
  }

  async speichereKontoauszug(monat: string, auszug: Kontoauszug): Promise<void> {
    const [max] = await this.db
      .select({ m: sql<number>`coalesce(max(${schema.kontoauszuege.reihenfolge}), -1)` })
      .from(schema.kontoauszuege)
      .where(eq(schema.kontoauszuege.monat, monat));

    await this.db
      .insert(schema.kontoauszuege)
      .values({
        id: auszug.id,
        monat,
        dateiname: auszug.dateiname,
        groesse: auszug.groesse,
        seiten: auszug.seiten ?? null,
        hochgeladenAm: alsZeitpunkt(auszug.hochgeladenAm, 'hochgeladenAm'),
        reihenfolge: Number(max?.m ?? -1) + 1,
      })
      // Die Reihenfolge bleibt beim erneuten Hochladen absichtlich stehen: die
      // Datei ist dieselbe (der Schluessel ist ihr Inhalts-Hash), und ihr Platz
      // im PDF wurde womoeglich von Hand gesetzt.
      .onConflictDoUpdate({
        target: schema.kontoauszuege.id,
        set: {
          dateiname: auszug.dateiname,
          groesse: auszug.groesse,
          seiten: auszug.seiten ?? null,
        },
      });
  }

  async loescheKontoauszug(monat: string, id: string): Promise<void> {
    await this.db
      .delete(schema.kontoauszuege)
      .where(and(eq(schema.kontoauszuege.monat, monat), eq(schema.kontoauszuege.id, id)));
  }

  /** Setzt die Reihenfolge der Kontoauszuege neu (Drag & Drop in der UI). */
  async ordneKontoauszuege(monat: string, ids: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx
          .update(schema.kontoauszuege)
          .set({ reihenfolge: i })
          .where(and(eq(schema.kontoauszuege.monat, monat), eq(schema.kontoauszuege.id, id)));
      }
    });
  }

  // -- KI-Ergebnisse --------------------------------------------------------

  async ladeExtraktion<T>(dateiId: string): Promise<T | null> {
    const [zeile] = await this.db
      .select({ daten: schema.extraktionen.daten })
      .from(schema.extraktionen)
      .where(eq(schema.extraktionen.dateiId, dateiId))
      .limit(1);
    return zeile ? (zeile.daten as T) : null;
  }

  async speichereExtraktion(dateiId: string, daten: unknown): Promise<void> {
    await this.db
      .insert(schema.extraktionen)
      .values({ dateiId, daten, erstelltAm: new Date() })
      .onConflictDoUpdate({
        target: schema.extraktionen.dateiId,
        set: { daten, erstelltAm: new Date() },
      });
  }

  async ladeReview<T>(monat: string): Promise<T | null> {
    const [zeile] = await this.db
      .select({ daten: schema.reviews.daten })
      .from(schema.reviews)
      .where(eq(schema.reviews.monat, monat))
      .limit(1);
    return zeile ? (zeile.daten as T) : null;
  }

  async speichereReview(monat: string, daten: unknown): Promise<void> {
    await this.db
      .insert(schema.reviews)
      .values({ monat, daten, erstelltAm: new Date() })
      .onConflictDoUpdate({
        target: schema.reviews.monat,
        set: { daten, erstelltAm: new Date() },
      });
  }

  // -- Belegdateien ---------------------------------------------------------

  async ladeDatei(monat: string, dateiId: string): Promise<Buffer | null> {
    const [zeile] = await this.db
      .select({ inhalt: schema.dateien.inhalt })
      .from(schema.dateien)
      .where(and(eq(schema.dateien.monat, monat), eq(schema.dateien.dateiId, dateiId)))
      .limit(1);
    return zeile ? zeile.inhalt : null;
  }

  /**
   * Die ersten Bytes einer Datei.
   *
   * Fuer die Unversehrtheitspruefung genuegt die Signatur am Anfang. Ein Beleg
   * kann mehrere Megabyte gross sein - ihn dafuer vollstaendig zu holen waere
   * beim Laden eines Monats mit vielen Belegen spuerbar.
   */
  async dateiKopf(monat: string, dateiId: string, bytes = 12): Promise<Buffer | null> {
    const [zeile] = await this.db
      .select({
        kopf: sql<Buffer>`substring(${schema.dateien.inhalt} from 1 for ${bytes})`,
      })
      .from(schema.dateien)
      .where(and(eq(schema.dateien.monat, monat), eq(schema.dateien.dateiId, dateiId)))
      .limit(1);
    if (!zeile?.kopf) return null;
    return Buffer.isBuffer(zeile.kopf) ? zeile.kopf : Buffer.from(zeile.kopf);
  }

  async dateiVorhanden(monat: string, dateiId: string): Promise<boolean> {
    const [zeile] = await this.db
      .select({ eins: sql<number>`1` })
      .from(schema.dateien)
      .where(and(eq(schema.dateien.monat, monat), eq(schema.dateien.dateiId, dateiId)))
      .limit(1);
    return zeile !== undefined;
  }

  async speichereDatei(monat: string, dateiId: string, inhalt: Buffer): Promise<void> {
    await this.db
      .insert(schema.dateien)
      .values({ monat, dateiId, inhalt, groesse: inhalt.byteLength, gespeichertAm: new Date() })
      /*
       * Die ID ist der Inhalts-Hash, eine vorhandene Zeile sollte also
       * denselben Inhalt tragen. Weicht die Groesse ab, tut sie es nicht - etwa
       * weil frueher einmal base64-Text statt eines PDF abgelegt wurde. Nur
       * dann wird geschrieben; sonst bliebe bei jedem Abruf eine tote Zeile in
       * der Tabelle zurueck.
       */
      .onConflictDoUpdate({
        target: [schema.dateien.monat, schema.dateien.dateiId],
        set: { inhalt, groesse: inhalt.byteLength, gespeichertAm: new Date() },
        setWhere: ne(schema.dateien.groesse, inhalt.byteLength),
      });
  }

  async loescheDatei(monat: string, dateiId: string): Promise<void> {
    await this.db
      .delete(schema.dateien)
      .where(and(eq(schema.dateien.monat, monat), eq(schema.dateien.dateiId, dateiId)));
  }

  // -- Fingerabdruecke der Belegdateien -------------------------------------

  /**
   * Der gemerkte Abdruck einer Datei, sofern er noch gilt.
   *
   * Stimmt die Marke nicht mehr, hat sich der Inhalt geaendert - dann gilt der
   * Abdruck nicht mehr und die Datei wird neu gelesen. Ohne Marke wird nichts
   * herausgegeben: dann laesst sich nicht feststellen, ob er noch stimmt.
   */
  async ladeAbdruck<T>(schluessel: string, marke: string | undefined): Promise<T | null> {
    if (!marke) return null;
    const [zeile] = await this.db
      .select({ abdruck: schema.abdruecke.abdruck })
      .from(schema.abdruecke)
      .where(and(eq(schema.abdruecke.schluessel, schluessel), eq(schema.abdruecke.marke, marke)))
      .limit(1);
    return zeile ? (zeile.abdruck as T) : null;
  }

  async speichereAbdruck(
    schluessel: string,
    marke: string | undefined,
    abdruck: unknown,
  ): Promise<void> {
    if (!marke) return;
    await this.db
      .insert(schema.abdruecke)
      .values({ schluessel, marke, abdruck, erstelltAm: new Date() })
      .onConflictDoUpdate({
        target: schema.abdruecke.schluessel,
        set: { marke, abdruck, erstelltAm: new Date() },
      });
  }

  async schliesse(): Promise<void> {
    await this.beende?.();
  }
}
