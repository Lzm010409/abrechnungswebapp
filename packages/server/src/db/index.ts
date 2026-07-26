import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { Kontoauszug, Monat, Position } from '@abrechnung/shared';

/**
 * SQLite als Cache und als Ablage fuer manuelle Entscheidungen.
 *
 * Wichtig fuer die Bedienung: `monate` ist reiner Cache und darf jederzeit
 * verworfen werden. `overrides` enthaelt die Arbeit des Nutzers und wird beim
 * erneuten Laden aus sevDesk NICHT ueberschrieben.
 */
export class Datenbank {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, 'abrechnung.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.migriere();
  }

  private migriere(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monate (
        monat            TEXT PRIMARY KEY,
        daten            TEXT NOT NULL,
        synchronisiertAm TEXT NOT NULL
      );

      -- Manuelle Korrekturen. Ueberleben jeden Neuabruf aus sevDesk.
      CREATE TABLE IF NOT EXISTS overrides (
        monat       TEXT NOT NULL,
        positionId  TEXT NOT NULL,
        patch       TEXT NOT NULL,
        geaendertAm TEXT NOT NULL,
        PRIMARY KEY (monat, positionId)
      );

      -- Vom Nutzer hochgeladene Kontoauszuege je Monat.
      CREATE TABLE IF NOT EXISTS kontoauszuege (
        id             TEXT PRIMARY KEY,
        monat          TEXT NOT NULL,
        dateiname      TEXT NOT NULL,
        groesse        INTEGER NOT NULL,
        seiten         INTEGER,
        hochgeladenAm  TEXT NOT NULL,
        reihenfolge    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_kontoauszuege_monat ON kontoauszuege (monat);

      -- Ergebnisse der KI-Belegextraktion, damit ein Beleg nur einmal
      -- analysiert wird. Schluessel ist der Inhalts-Hash der Datei.
      CREATE TABLE IF NOT EXISTS extraktionen (
        dateiId     TEXT PRIMARY KEY,
        daten       TEXT NOT NULL,
        erstelltAm  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reviews (
        monat      TEXT PRIMARY KEY,
        daten      TEXT NOT NULL,
        erstelltAm TEXT NOT NULL
      );
    `);
  }

  // -- Monatscache ----------------------------------------------------------

  ladeMonat(monat: string): Monat | null {
    const zeile = this.db
      .prepare('SELECT daten FROM monate WHERE monat = ?')
      .get(monat) as { daten: string } | undefined;
    return zeile ? (JSON.parse(zeile.daten) as Monat) : null;
  }

  speichereMonat(monat: Monat): void {
    this.db
      .prepare(
        `INSERT INTO monate (monat, daten, synchronisiertAm) VALUES (?, ?, ?)
         ON CONFLICT(monat) DO UPDATE SET daten = excluded.daten,
                                          synchronisiertAm = excluded.synchronisiertAm`,
      )
      .run(monat.monat, JSON.stringify(monat), new Date().toISOString());
  }

  loescheMonat(monat: string): void {
    this.db.prepare('DELETE FROM monate WHERE monat = ?').run(monat);
  }

  // -- Manuelle Korrekturen -------------------------------------------------

  ladeOverrides(monat: string): Map<string, Partial<Position>> {
    const zeilen = this.db
      .prepare('SELECT positionId, patch FROM overrides WHERE monat = ?')
      .all(monat) as Array<{ positionId: string; patch: string }>;
    return new Map(zeilen.map((z) => [z.positionId, JSON.parse(z.patch) as Partial<Position>]));
  }

  speichereOverride(monat: string, positionId: string, patch: Partial<Position>): void {
    const vorhanden = this.db
      .prepare('SELECT patch FROM overrides WHERE monat = ? AND positionId = ?')
      .get(monat, positionId) as { patch: string } | undefined;

    // Patches werden zusammengefuehrt, damit zwei getrennte Korrekturen
    // (erst Aktenzeichen, dann Status) sich nicht gegenseitig loeschen.
    const zusammengefuehrt = {
      ...(vorhanden ? (JSON.parse(vorhanden.patch) as Partial<Position>) : {}),
      ...patch,
    };

    this.db
      .prepare(
        `INSERT INTO overrides (monat, positionId, patch, geaendertAm) VALUES (?, ?, ?, ?)
         ON CONFLICT(monat, positionId) DO UPDATE SET patch = excluded.patch,
                                                      geaendertAm = excluded.geaendertAm`,
      )
      .run(monat, positionId, JSON.stringify(zusammengefuehrt), new Date().toISOString());
  }

  loescheOverride(monat: string, positionId: string): void {
    this.db
      .prepare('DELETE FROM overrides WHERE monat = ? AND positionId = ?')
      .run(monat, positionId);
  }

  // -- Kontoauszuege --------------------------------------------------------

  ladeKontoauszuege(monat: string): Kontoauszug[] {
    return this.db
      .prepare(
        `SELECT id, dateiname, groesse, seiten, hochgeladenAm
           FROM kontoauszuege WHERE monat = ?
          ORDER BY reihenfolge ASC, hochgeladenAm ASC`,
      )
      .all(monat) as Kontoauszug[];
  }

  speichereKontoauszug(monat: string, auszug: Kontoauszug): void {
    const maxZeile = this.db
      .prepare('SELECT COALESCE(MAX(reihenfolge), -1) AS m FROM kontoauszuege WHERE monat = ?')
      .get(monat) as { m: number };

    this.db
      .prepare(
        `INSERT INTO kontoauszuege (id, monat, dateiname, groesse, seiten, hochgeladenAm, reihenfolge)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET dateiname = excluded.dateiname,
                                       groesse   = excluded.groesse,
                                       seiten    = excluded.seiten`,
      )
      .run(
        auszug.id,
        monat,
        auszug.dateiname,
        auszug.groesse,
        auszug.seiten ?? null,
        auszug.hochgeladenAm,
        maxZeile.m + 1,
      );
  }

  loescheKontoauszug(monat: string, id: string): void {
    this.db.prepare('DELETE FROM kontoauszuege WHERE monat = ? AND id = ?').run(monat, id);
  }

  /** Setzt die Reihenfolge der Kontoauszuege neu (Drag & Drop in der UI). */
  ordneKontoauszuege(monat: string, ids: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE kontoauszuege SET reihenfolge = ? WHERE monat = ? AND id = ?',
    );
    const tx = this.db.transaction((liste: string[]) => {
      liste.forEach((id, i) => stmt.run(i, monat, id));
    });
    tx(ids);
  }

  // -- KI-Ergebnisse --------------------------------------------------------

  ladeExtraktion<T>(dateiId: string): T | null {
    const zeile = this.db
      .prepare('SELECT daten FROM extraktionen WHERE dateiId = ?')
      .get(dateiId) as { daten: string } | undefined;
    return zeile ? (JSON.parse(zeile.daten) as T) : null;
  }

  speichereExtraktion(dateiId: string, daten: unknown): void {
    this.db
      .prepare(
        `INSERT INTO extraktionen (dateiId, daten, erstelltAm) VALUES (?, ?, ?)
         ON CONFLICT(dateiId) DO UPDATE SET daten = excluded.daten,
                                            erstelltAm = excluded.erstelltAm`,
      )
      .run(dateiId, JSON.stringify(daten), new Date().toISOString());
  }

  ladeReview<T>(monat: string): T | null {
    const zeile = this.db
      .prepare('SELECT daten FROM reviews WHERE monat = ?')
      .get(monat) as { daten: string } | undefined;
    return zeile ? (JSON.parse(zeile.daten) as T) : null;
  }

  speichereReview(monat: string, daten: unknown): void {
    this.db
      .prepare(
        `INSERT INTO reviews (monat, daten, erstelltAm) VALUES (?, ?, ?)
         ON CONFLICT(monat) DO UPDATE SET daten = excluded.daten,
                                          erstelltAm = excluded.erstelltAm`,
      )
      .run(monat, JSON.stringify(daten), new Date().toISOString());
  }

  schliesse(): void {
    this.db.close();
  }
}
