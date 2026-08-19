/**
 * Uebertraegt den Altbestand aus der SQLite-Datei nach Postgres.
 *
 * Laeuft ausdruecklich NICHT beim Start des Containers: der Umzug des
 * Bestandes ist ein Vorgang, den ein Mensch anstoesst und dessen Zaehlwerte
 * ein Mensch liest.
 *
 * Wiederholbar: vorhandene Zeilen bleiben unangetastet. Damit kann der
 * Import gefahrlos ein zweites Mal laufen, ohne die Arbeit zu ueberschreiben,
 * die inzwischen in der Anwendung entstanden ist. Wer das ausdruecklich will,
 * setzt `--ueberschreiben`.
 *
 * Aufruf:
 *   node packages/server/scripts/import-altbestand.mjs --trockenlauf
 *   node packages/server/scripts/import-altbestand.mjs
 *   node packages/server/scripts/import-altbestand.mjs --datei /data/abrechnung.sqlite
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import postgres from 'postgres';

const require = createRequire(import.meta.url);

const argumente = process.argv.slice(2);
const trockenlauf = argumente.includes('--trockenlauf');
const ueberschreiben = argumente.includes('--ueberschreiben');

function argument(name) {
  const i = argumente.indexOf(name);
  return i >= 0 ? argumente[i + 1] : undefined;
}

const DATA_DIR = resolve(argument('--data-dir') ?? process.env.DATA_DIR ?? './data');
const SQLITE = resolve(argument('--datei') ?? join(DATA_DIR, 'abrechnung.sqlite'));

/** Die Tabellen in der Reihenfolge, in der sie uebertragen werden. */
const TABELLEN = ['monate', 'overrides', 'kontoauszuege', 'extraktionen', 'reviews', 'dateien'];

/** Belegdateien unterhalb dieses Verzeichnisses, nach Monat sortiert. */
const MONATSORDNER = /^\d{4}-\d{2}$/;

function melde(text) {
  console.log(`[import] ${text}`);
}

/**
 * Deutet einen Zeitstempel aus dem Altbestand.
 *
 * SQLite hat ISO-Zeichenketten gespeichert. Steht dort Unsinn, ist das
 * meldenswert - der Import erfindet dafuer keinen Ersatzwert, sondern nimmt
 * den Zeitpunkt des Imports und sagt es.
 */
function zeitpunkt(wert, was, warnungen) {
  const d = new Date(wert);
  if (Number.isNaN(d.getTime())) {
    warnungen.push(`${was}: "${wert}" ist kein gueltiger Zeitpunkt, ersetzt durch jetzt`);
    return new Date();
  }
  return d;
}

function json(wert, was, warnungen) {
  try {
    return JSON.parse(wert);
  } catch {
    warnungen.push(`${was}: Inhalt ist kein gueltiges JSON, Zeile uebersprungen`);
    return undefined;
  }
}

async function zaehle(sql) {
  const stand = {};
  for (const tabelle of TABELLEN) {
    const [zeile] = await sql.unsafe(`select count(*)::int as anzahl from ${tabelle}`);
    stand[tabelle] = zeile.anzahl;
  }
  return stand;
}

function zeigeStand(titel, stand) {
  melde(titel);
  for (const tabelle of TABELLEN) {
    console.log(`         ${tabelle.padEnd(14)} ${String(stand[tabelle]).padStart(6)}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[import] DATABASE_URL fehlt.');
    process.exit(1);
  }
  if (!existsSync(SQLITE)) {
    console.error(`[import] Keine SQLite-Datei unter ${SQLITE}.`);
    console.error('[import] Gibt es keinen Altbestand, ist nichts zu tun.');
    process.exit(1);
  }

  // Erst hier laden: ohne Altbestand wird das native Modul nicht gebraucht.
  const Database = require('better-sqlite3');
  const alt = new Database(SQLITE, { readonly: true });
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  const warnungen = [];

  try {
    const vorher = await zaehle(sql);
    zeigeStand('Bestand in Postgres vor dem Import:', vorher);

    if (trockenlauf) {
      melde('Trockenlauf — es wird nichts geschrieben.');
    }
    if (ueberschreiben && !trockenlauf) {
      melde('ACHTUNG: --ueberschreiben ist gesetzt, vorhandene Zeilen werden ersetzt.');
    }

    const gelesen = {};

    // -- monate -------------------------------------------------------------
    const monate = alt.prepare('SELECT monat, daten, synchronisiertAm FROM monate').all();
    gelesen.monate = monate.length;
    for (const z of monate) {
      const daten = json(z.daten, `monate/${z.monat}`, warnungen);
      if (daten === undefined) continue;
      const stand = zeitpunkt(z.synchronisiertAm, `monate/${z.monat}`, warnungen);
      if (trockenlauf) continue;
      if (ueberschreiben) {
        await sql`insert into monate (monat, daten, synchronisiert_am)
                  values (${z.monat}, ${sql.json(daten)}, ${stand})
                  on conflict (monat) do update
                     set daten = excluded.daten,
                         synchronisiert_am = excluded.synchronisiert_am`;
      } else {
        await sql`insert into monate (monat, daten, synchronisiert_am)
                  values (${z.monat}, ${sql.json(daten)}, ${stand})
                  on conflict (monat) do nothing`;
      }
    }

    // -- overrides ----------------------------------------------------------
    const overrides = alt
      .prepare('SELECT monat, positionId, patch, geaendertAm FROM overrides')
      .all();
    gelesen.overrides = overrides.length;
    for (const z of overrides) {
      const was = `overrides/${z.monat}/${z.positionId}`;
      const patch = json(z.patch, was, warnungen);
      if (patch === undefined) continue;
      const stand = zeitpunkt(z.geaendertAm, was, warnungen);
      if (trockenlauf) continue;
      if (ueberschreiben) {
        await sql`insert into overrides (monat, position_id, patch, geaendert_am)
                  values (${z.monat}, ${z.positionId}, ${sql.json(patch)}, ${stand})
                  on conflict (monat, position_id) do update
                     set patch = excluded.patch,
                         geaendert_am = excluded.geaendert_am`;
      } else {
        await sql`insert into overrides (monat, position_id, patch, geaendert_am)
                  values (${z.monat}, ${z.positionId}, ${sql.json(patch)}, ${stand})
                  on conflict (monat, position_id) do nothing`;
      }
    }

    // -- kontoauszuege ------------------------------------------------------
    const auszuege = alt
      .prepare(
        'SELECT id, monat, dateiname, groesse, seiten, hochgeladenAm, reihenfolge FROM kontoauszuege',
      )
      .all();
    gelesen.kontoauszuege = auszuege.length;
    for (const z of auszuege) {
      const stand = zeitpunkt(z.hochgeladenAm, `kontoauszuege/${z.id}`, warnungen);
      if (trockenlauf) continue;
      if (ueberschreiben) {
        await sql`insert into kontoauszuege
                    (id, monat, dateiname, groesse, seiten, hochgeladen_am, reihenfolge)
                  values (${z.id}, ${z.monat}, ${z.dateiname}, ${z.groesse},
                          ${z.seiten ?? null}, ${stand}, ${z.reihenfolge ?? 0})
                  on conflict (id) do update
                     set monat = excluded.monat,
                         dateiname = excluded.dateiname,
                         groesse = excluded.groesse,
                         seiten = excluded.seiten,
                         hochgeladen_am = excluded.hochgeladen_am,
                         reihenfolge = excluded.reihenfolge`;
      } else {
        await sql`insert into kontoauszuege
                    (id, monat, dateiname, groesse, seiten, hochgeladen_am, reihenfolge)
                  values (${z.id}, ${z.monat}, ${z.dateiname}, ${z.groesse},
                          ${z.seiten ?? null}, ${stand}, ${z.reihenfolge ?? 0})
                  on conflict (id) do nothing`;
      }
    }

    // -- extraktionen -------------------------------------------------------
    const extraktionen = alt
      .prepare('SELECT dateiId, daten, erstelltAm FROM extraktionen')
      .all();
    gelesen.extraktionen = extraktionen.length;
    for (const z of extraktionen) {
      const daten = json(z.daten, `extraktionen/${z.dateiId}`, warnungen);
      if (daten === undefined) continue;
      const stand = zeitpunkt(z.erstelltAm, `extraktionen/${z.dateiId}`, warnungen);
      if (trockenlauf) continue;
      if (ueberschreiben) {
        await sql`insert into extraktionen (datei_id, daten, erstellt_am)
                  values (${z.dateiId}, ${sql.json(daten)}, ${stand})
                  on conflict (datei_id) do update
                     set daten = excluded.daten,
                         erstellt_am = excluded.erstellt_am`;
      } else {
        await sql`insert into extraktionen (datei_id, daten, erstellt_am)
                  values (${z.dateiId}, ${sql.json(daten)}, ${stand})
                  on conflict (datei_id) do nothing`;
      }
    }

    // -- reviews ------------------------------------------------------------
    const reviews = alt.prepare('SELECT monat, daten, erstelltAm FROM reviews').all();
    gelesen.reviews = reviews.length;
    for (const z of reviews) {
      const daten = json(z.daten, `reviews/${z.monat}`, warnungen);
      if (daten === undefined) continue;
      const stand = zeitpunkt(z.erstelltAm, `reviews/${z.monat}`, warnungen);
      if (trockenlauf) continue;
      if (ueberschreiben) {
        await sql`insert into reviews (monat, daten, erstellt_am)
                  values (${z.monat}, ${sql.json(daten)}, ${stand})
                  on conflict (monat) do update
                     set daten = excluded.daten,
                         erstellt_am = excluded.erstellt_am`;
      } else {
        await sql`insert into reviews (monat, daten, erstellt_am)
                  values (${z.monat}, ${sql.json(daten)}, ${stand})
                  on conflict (monat) do nothing`;
      }
    }

    // -- dateien ------------------------------------------------------------
    /*
     * Die Belegdateien lagen unter $DATA_DIR/monate/<YYYY-MM>/<dateiId>. Sie
     * wandern mit in die Datenbank, damit ein pg_dump der vollstaendige
     * Sicherungspunkt ist. Auf der Platte bleiben sie unangetastet - der
     * Rueckweg soll offen bleiben.
     */
    const monatsWurzel = join(DATA_DIR, 'monate');
    gelesen.dateien = 0;
    if (existsSync(monatsWurzel)) {
      for (const monatsOrdner of readdirSync(monatsWurzel).sort()) {
        if (!MONATSORDNER.test(monatsOrdner)) {
          warnungen.push(`dateien: "${monatsOrdner}" ist kein Monatsordner, uebersprungen`);
          continue;
        }
        const verzeichnis = join(monatsWurzel, monatsOrdner);
        for (const name of readdirSync(verzeichnis).sort()) {
          const pfad = join(verzeichnis, name);
          if (!statSync(pfad).isFile()) continue;
          gelesen.dateien++;
          if (trockenlauf) continue;

          const inhalt = readFileSync(pfad);
          if (ueberschreiben) {
            await sql`insert into dateien (monat, datei_id, inhalt, groesse)
                      values (${monatsOrdner}, ${name}, ${inhalt}, ${inhalt.byteLength})
                      on conflict (monat, datei_id) do update
                         set inhalt = excluded.inhalt,
                             groesse = excluded.groesse,
                             gespeichert_am = now()`;
          } else {
            await sql`insert into dateien (monat, datei_id, inhalt, groesse)
                      values (${monatsOrdner}, ${name}, ${inhalt}, ${inhalt.byteLength})
                      on conflict (monat, datei_id) do nothing`;
          }
        }
      }
    } else {
      melde(`Kein Verzeichnis ${monatsWurzel} - keine Belegdateien zu uebertragen.`);
    }

    zeigeStand(`Gefunden in ${SQLITE} bzw. ${DATA_DIR}/monate:`, gelesen);

    const nachher = await zaehle(sql);
    zeigeStand('Bestand in Postgres nach dem Import:', nachher);

    for (const tabelle of TABELLEN) {
      if (trockenlauf || ueberschreiben) break;
      const dazu = nachher[tabelle] - vorher[tabelle];
      const vorhandenGeblieben = gelesen[tabelle] - dazu;
      if (vorhandenGeblieben > 0) {
        melde(
          `${tabelle}: ${dazu} neu, ${vorhandenGeblieben} waren bereits vorhanden ` +
            'und blieben unveraendert.',
        );
      }
    }

    if (warnungen.length > 0) {
      melde(`${warnungen.length} Hinweis(e):`);
      for (const w of warnungen) console.log(`         ${w}`);
    }

    melde(trockenlauf ? 'Trockenlauf beendet.' : 'Import beendet.');
  } finally {
    alt.close();
    await sql.end({ timeout: 5 });
  }
}

main().catch((fehler) => {
  console.error('[import] Fehlgeschlagen:', fehler);
  process.exit(1);
});
