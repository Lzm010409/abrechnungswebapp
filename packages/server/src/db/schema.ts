import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Das Schema der Abrechnung in Postgres.
 *
 * Uebernommen aus der frueheren SQLite-Datei, mit zwei bewussten Aenderungen:
 * die JSON-Spalten sind jetzt `jsonb` statt Text, und Zeitstempel sind
 * `timestamptz` statt ISO-Zeichenketten. Beides macht den Bestand fuer
 * Abfragen und fuer einen `pg_dump` lesbar, ohne dass sich die Bedeutung
 * eines Feldes aendert.
 *
 * Bewusst OHNE Fremdschluessel: `monate` ist reiner Zwischenspeicher und wird
 * beim Neuabruf aus sevDesk geloescht und neu geschrieben. Ein Fremdschluessel
 * von `overrides` oder `reviews` darauf wuerde genau die Arbeit des Nutzers
 * mitreissen, die diese Tabellen bewahren sollen.
 */

/** Reiner Zwischenspeicher aus sevDesk. Darf jederzeit verworfen werden. */
export const monate = pgTable('monate', {
  /** Monat im Format "YYYY-MM". */
  monat: text().primaryKey(),
  daten: jsonb().notNull(),
  synchronisiertAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Manuelle Korrekturen des Nutzers.
 *
 * Der einzige unwiederbringliche Bestand dieser Anwendung: alles andere laesst
 * sich aus sevDesk neu holen, diese Tabelle nicht. Sie wird beim Neuabruf
 * ausdruecklich nicht ueberschrieben.
 */
export const overrides = pgTable(
  'overrides',
  {
    monat: text().notNull(),
    positionId: text().notNull(),
    patch: jsonb().notNull(),
    geaendertAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.monat, t.positionId] })],
);

/** Vom Nutzer hochgeladene Kontoauszuege je Monat. */
export const kontoauszuege = pgTable(
  'kontoauszuege',
  {
    /** Inhalts-Hash der Datei, zugleich ihr Name in der Dateiablage. */
    id: text().primaryKey(),
    monat: text().notNull(),
    dateiname: text().notNull(),
    groesse: integer().notNull(),
    seiten: integer(),
    hochgeladenAm: timestamp({ withTimezone: true }).notNull(),
    /** Reihenfolge im erzeugten PDF, per Ziehen in der Oberflaeche gesetzt. */
    reihenfolge: integer().notNull().default(0),
  },
  (t) => [index('kontoauszuege_monat_idx').on(t.monat)],
);

/**
 * Ergebnisse der KI-Belegextraktion.
 *
 * Schluessel ist der Inhalts-Hash der Datei, damit derselbe Beleg auch nach
 * einem erneuten Abruf aus sevDesk nicht ein zweites Mal analysiert wird.
 */
export const extraktionen = pgTable('extraktionen', {
  dateiId: text().primaryKey(),
  daten: jsonb().notNull(),
  erstelltAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Ergebnis der KI-Monatspruefung, je Monat eines. */
export const reviews = pgTable('reviews', {
  monat: text().primaryKey(),
  daten: jsonb().notNull(),
  erstelltAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
