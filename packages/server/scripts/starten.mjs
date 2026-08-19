/**
 * Startvorgang des Containers.
 *
 *   1. Datenbankschema anlegen bzw. fortschreiben
 *   2. Den Fastify-Server starten
 *
 * Bewusst reines JavaScript ohne Werkzeugkette: im Laufzeit-Abbild liegt nur
 * die uebersetzte Ausgabe. Verwendet wird ausschliesslich `postgres`, das die
 * Anwendung ohnehin mitbringt.
 *
 * Der Ablauf ist wiederholbar: bereits angewandte Migrationen werden
 * uebersprungen. Ein zweiter Start aendert also nichts.
 *
 * Anders als in der Werkbank werden die Pfade relativ zu diesem Modul
 * aufgeloest und nicht ueber das Arbeitsverzeichnis: die Anwendung liegt im
 * Abbild unter `packages/server`, gestartet wird aber aus `/app`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const MIGRATIONEN = fileURLToPath(new URL('../drizzle', import.meta.url));
const SERVER = new URL('../dist/index.js', import.meta.url);

function melde(text) {
  console.log(`[start] ${text}`);
}

async function wendeMigrationenAn(sql) {
  if (!existsSync(MIGRATIONEN)) {
    melde('Kein Migrationsverzeichnis gefunden — übersprungen.');
    return;
  }

  await sql`
    create table if not exists __migrationen (
      name text primary key,
      pruefsumme text not null,
      angewandt_am timestamptz not null default now()
    )
  `;

  const angewandt = new Map(
    (await sql`select name, pruefsumme from __migrationen`).map((z) => [z.name, z.pruefsumme]),
  );

  const dateien = readdirSync(MIGRATIONEN)
    .filter((d) => d.endsWith('.sql'))
    .sort();

  for (const datei of dateien) {
    const inhalt = readFileSync(`${MIGRATIONEN}/${datei}`, 'utf8');
    const pruefsumme = createHash('sha256').update(inhalt).digest('hex').slice(0, 16);
    const bekannt = angewandt.get(datei);

    if (bekannt) {
      if (bekannt !== pruefsumme) {
        // Eine nachträglich geänderte Migration ist ein Fehler in der
        // Entwicklung, kein Zustand, den der Start stillschweigend heilt.
        melde(`WARNUNG: ${datei} wurde nach dem Anwenden verändert.`);
      }
      continue;
    }

    melde(`Migration ${datei} …`);
    // Drizzle trennt Anweisungen mit diesem Marker.
    const anweisungen = inhalt
      .split('--> statement-breakpoint')
      .map((a) => a.trim())
      .filter(Boolean);

    await sql.begin(async (tx) => {
      for (const anweisung of anweisungen) {
        await tx.unsafe(anweisung);
      }
      await tx`insert into __migrationen (name, pruefsumme) values (${datei}, ${pruefsumme})`;
    });
  }

  melde(`Schema aktuell (${dateien.length} Migration${dateien.length === 1 ? '' : 'en'}).`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[start] DATABASE_URL fehlt. Der Server wird nicht gestartet.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 2, onnotice: () => {} });
  try {
    await wendeMigrationenAn(sql);
  } catch (fehler) {
    console.error('[start] Einrichtung fehlgeschlagen:', fehler);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (!existsSync(fileURLToPath(SERVER))) {
    console.error(`[start] Server nicht gefunden unter ${fileURLToPath(SERVER)}.`);
    process.exit(1);
  }

  melde('Server wird gestartet.');
  await import(SERVER.href);
}

main();
