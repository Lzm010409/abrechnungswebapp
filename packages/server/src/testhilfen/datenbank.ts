import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { Datenbank } from '../db/index.js';
import * as schema from '../db/schema.js';

/**
 * Eine leere Datenbank fuer einen Test.
 *
 * PGlite ist dieselbe Postgres, nur in den Prozess eingebettet: die Tests
 * pruefen also echtes Postgres-SQL, ohne dass ein Server laufen muss. Damit
 * laeuft die gesamte bestehende Testsuite unveraendert weiter, statt ohne
 * Datenbank uebersprungen zu werden.
 *
 * Die Instanz wird je Testdatei einmal aufgebaut und vor jedem Test geleert.
 * Ein eigener Aufbau je Test kostete rund zweieinhalb Sekunden - bei ueber
 * hundert Tests waere das der Grossteil der Laufzeit.
 */
const MIGRATIONEN = fileURLToPath(new URL('../../drizzle', import.meta.url));

const TABELLEN = ['monate', 'overrides', 'kontoauszuege', 'extraktionen', 'reviews'];

let gemeinsam: Promise<PGlite> | undefined;

async function baueAuf(): Promise<PGlite> {
  const pglite = new PGlite();

  /*
   * Bewusst ohne die Buchfuehrung aus `scripts/starten.mjs`: eine frische
   * Datenbank hat nichts zu ueberspringen. Angewandt werden dieselben
   * erzeugten Dateien, damit ein Fehler im Schema hier auffaellt und nicht
   * erst beim Start des Containers.
   */
  for (const datei of readdirSync(MIGRATIONEN)
    .filter((d) => d.endsWith('.sql'))
    .sort()) {
    const inhalt = readFileSync(join(MIGRATIONEN, datei), 'utf8');
    for (const anweisung of inhalt.split('--> statement-breakpoint')) {
      const getrimmt = anweisung.trim();
      if (getrimmt) await pglite.exec(getrimmt);
    }
  }

  return pglite;
}

/**
 * Baut die eingebettete Datenbank auf, ohne schon eine zu vergeben.
 *
 * Gehoert in ein `beforeAll`: der Aufbau dauert einige Sekunden und wuerde
 * sonst dem ersten Test der Datei von seiner Zeitvorgabe abgehen.
 */
export function bereiteTestDatenbankVor(): Promise<unknown> {
  gemeinsam ??= baueAuf();
  return gemeinsam;
}

export async function legeTestDatenbankAn(): Promise<Datenbank> {
  gemeinsam ??= baueAuf();
  const pglite = await gemeinsam;
  await pglite.exec(`truncate ${TABELLEN.join(', ')}`);

  // `schliesse` leert hier nur den Verweis: die eingebettete Datenbank bleibt
  // fuer den naechsten Test stehen. Ein zweites Schliessen liefe sonst in
  // "PGlite is closed".
  return new Datenbank(drizzle(pglite, { schema, casing: 'snake_case' }), async () => {});
}
