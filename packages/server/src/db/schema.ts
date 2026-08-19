import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

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

/**
 * Rohbytes einer Datei.
 *
 * Drizzle kennt `bytea` nicht von sich aus. Die Treiber liefern die Spalte je
 * nach Bauart als `Buffer` oder als `Uint8Array` - der Rest der Anwendung
 * rechnet mit `Buffer`, deshalb wird hier einmal vereinheitlicht.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(wert) {
    return Buffer.isBuffer(wert) ? wert : Buffer.from(wert);
  },
});

/**
 * Die Belegdateien selbst: heruntergeladene Belege und hochgeladene
 * Kontoauszuege.
 *
 * Sie lagen frueher als Dateien unter `$DATA_DIR/monate/<YYYY-MM>/<dateiId>`.
 * Dort waren sie von keinem Backup erfasst, weil Coolify Volumes nicht sichert.
 * Bei gemessenen 38 MB Gesamtbestand wiegt das leichter als jede Ersparnis:
 * seit sie hier liegen, ist ein `pg_dump` der vollstaendige Sicherungspunkt.
 *
 * `dateiId` ist der Inhalts-Hash. Zusammen mit dem Monat ergibt er den
 * Schluessel - derselbe Beleg in zwei Monaten wird zweimal abgelegt, so wie es
 * die Dateiablage auch tat.
 */
export const dateien = pgTable(
  'dateien',
  {
    monat: text().notNull(),
    dateiId: text().notNull(),
    inhalt: bytea().notNull(),
    groesse: integer().notNull(),
    gespeichertAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.monat, t.dateiId] })],
);

/**
 * Fingerabdruecke der Belegdateien, fuer den Abgleich mit OneDrive.
 *
 * Der Abgleich muss jede Datei einmal vollstaendig lesen, um ihren Inhalt zu
 * kennen - eigene Belege wie fremde. Das kostet Zeit und Bandbreite und faellt
 * ohne diesen Zwischenspeicher bei jedem Lauf erneut an.
 *
 * `schluessel` traegt die Herkunft mit ("onedrive:<itemId>" bzw.
 * "beleg:<dateiId>"), damit sich beide Seiten dieselbe Tabelle teilen. `marke`
 * sagt, wann ein Abdruck veraltet: bei OneDrive der `cTag`, der sich mit dem
 * Inhalt aendert, bei den eigenen Belegen die dateiId - sie IST der
 * Inhalts-Hash und aendert sich deshalb nie fuer denselben Inhalt.
 */
export const abdruecke = pgTable('abdruecke', {
  schluessel: text().primaryKey(),
  marke: text().notNull(),
  abdruck: jsonb().notNull(),
  erstelltAm: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
