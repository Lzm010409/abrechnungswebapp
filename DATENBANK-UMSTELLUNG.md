# Umstellung auf eine eigene Postgres-Datenbank

Die Abrechnung hielt ihren Bestand bisher in einer SQLite-Datei unter
`$DATA_DIR/abrechnung.sqlite`. Ab dieser Fassung liegt er in einer eigenen
Postgres-Datenbank, die Coolify als Ressource kennt und damit sichern kann.

Diese Anleitung beschreibt das Ausrollen, den Umzug des Altbestandes und den
Rückweg. Sie richtet sich an einen Menschen — es gibt hier nichts, was von
selbst passiert.

---

## Was umzieht und was nicht

**In die Datenbank wandern** die fünf Tabellen der bisherigen SQLite-Datei —
und die Belegdateien dazu:

| Tabelle | Inhalt | Ersetzbar? |
|---|---|---|
| `monate` | Zwischenspeicher aus sevDesk | ja, jederzeit neu abrufbar |
| `overrides` | **die manuellen Korrekturen des Nutzers** | **nein** |
| `kontoauszuege` | Verzeichnis der hochgeladenen Auszüge | nein |
| `extraktionen` | Ergebnisse der KI-Belegextraktion | ja, kostet erneut Modellaufrufe |
| `reviews` | Ergebnisse der KI-Monatsprüfung | ja |
| `dateien` | die Belegdateien selbst, als `bytea` | teilweise |
| `abdruecke` | Fingerabdrücke für den OneDrive-Abgleich | ja, wird bei Bedarf neu berechnet |

Die Belegdateien lagen unter `$DATA_DIR/monate/<YYYY-MM>/<dateiId>`, wo kein
Coolify-Backup sie erfasste. Gemessen im laufenden Container:

```
$ du -sh /data/monate
38M     /data/monate
```

38 MB wiegen leichter als jede Ersparnis. Seit sie in der Tabelle `dateien`
liegen, ist ein `pg_dump` der **vollständige** Sicherungspunkt — es bleibt
nichts außerhalb.

**Auf der Platte bleiben sie trotzdem.** Die Anwendung schreibt weiterhin eine
Zweitschrift dorthin und liest von dort, was in der Datenbank (noch) fehlt.
Das ist der Rückweg: eine zurückgerollte Fassung findet ihren Bestand
unverändert vor. Der Ausbau dieses zweiten Pfades ist ein späterer, eigener
Schritt.

`$DATA_DIR` wird also weiterhin gebraucht — nur hängt jetzt nichts mehr daran.

---

## 1. Datenbank in Coolify anlegen

Projekt → **+ New** → **Database** → **PostgreSQL**.

- Name frei wählbar, etwa `abrechnung-db`.
- Datenbankname, Benutzer und Passwort notieren.
- Die Datenbank muss im **selben Destination-Netz** liegen wie die Anwendung
  (in aller Regel `coolify`), sonst schlägt die Namensauflösung mit `EAI_AGAIN`
  fehl.
- Unter **Backups** einen Zeitplan setzen. Genau dafür wird das hier gemacht.

Der interne Hostname der Datenbank **ist ihre UUID**. Die
Verbindungszeichenkette sieht also so aus:

```
postgres://abrechnung:<passwort>@<uuid-der-datenbank>:5432/abrechnung
```

Sie gehört in die Umgebung der Anwendung und **niemals in das Repository**.

## 2. Umgebungsvariable setzen

An der Anwendung in Coolify:

| Variable | Wert |
|---|---|
| `DATABASE_URL` | die Zeichenkette aus Schritt 1 |

Alle übrigen Variablen bleiben unverändert. `DATA_DIR` wird weiterhin gebraucht
— dort liegt die Zweitschrift der Belegdateien.

Ohne `DATABASE_URL` startet der Server nicht und sagt das beim Start deutlich.

## 3. Ausrollen

Deploy des Branches. Beim Start des Containers läuft
`packages/server/scripts/starten.mjs`:

1. legt die Tabelle `__migrationen` an, falls sie fehlt
2. wendet alle noch nicht angewandten Dateien aus `packages/server/drizzle/` an
3. übernimmt einmalig den Altbestand, falls das noch aussteht (Schritt 4)
4. startet den Server

Der Vorgang ist wiederholbar. Ein zweiter Start überspringt, was schon
angewandt ist, und meldet nur `Schema aktuell (N Migrationen).`. Wurde eine
bereits angewandte Migration nachträglich verändert, gibt es eine Warnung — der
Start heilt so etwas bewusst nicht stillschweigend.

Im Log ist der erfolgreiche Start hieran zu erkennen:

```
[start] Migration 0000_special_paper_doll.sql …
[start] Migration 0001_skinny_micromax.sql …
[start] Schema aktuell (2 Migrationen).
[start] Server wird gestartet.
```

## 4. Altbestand übertragen

Der Umzug erledigt sich beim **ersten** Start gegen die neue Datenbank — der
Container hat keine Konsole, „von Hand" hieße hier: gar nicht.

Buch geführt wird darüber in der Tabelle `__altbestand`: ist die Zeile `import`
gesetzt, läuft nichts mehr an, auch bei keinem Neustart. Schlägt der Übertrag
mittendrin fehl, bleibt die Zeile aus und der nächste Start versucht es erneut
— unbedenklich, weil vorhandene Zeilen unangetastet bleiben.

Im Deployment-Protokoll sieht das so aus:

```
[start] Altbestand aus /data/abrechnung.sqlite wird uebernommen …
[start]   vorher:  monate=0 overrides=0 kontoauszuege=0 extraktionen=0 reviews=0 dateien=0
[start]   gefunden: monate=8 overrides=41 kontoauszuege=6 extraktionen=57 reviews=3 dateien=214
[start]   nachher: monate=8 overrides=41 kontoauszuege=6 extraktionen=57 reviews=3 dateien=214
[start] Altbestand uebernommen (0 Hinweis(e)).
```

**Die drei Zeilen müssen zusammenpassen**: was gefunden wurde, muss nachher
drin sein. Weicht etwas ab, steht der Grund als `Hinweis:` darunter.

Steht dort stattdessen `Kein Altbestand unter …`, ist das Volume nicht
eingebunden — dann **nicht** weitermachen, sondern erst `/data` prüfen.

Von Hand geht es weiterhin auch, etwa für einen Blick vorab oder für einen
zweiten Durchgang nach einem Rückrollen:

```sh
node packages/server/scripts/import-altbestand.mjs --trockenlauf
node packages/server/scripts/import-altbestand.mjs
```

Der Importer:

- liest `$DATA_DIR/abrechnung.sqlite` (oder `--datei <pfad>`) und die Dateien
  unter `$DATA_DIR/monate/<YYYY-MM>/`
- ist **wiederholbar**: bereits vorhandene Zeilen bleiben unangetastet, ein
  zweiter Lauf verdoppelt nichts und überschreibt nichts
- meldet unbrauchbare Zeitstempel und ungültiges JSON, statt sie zu verschlucken
- schreibt nur mit `--ueberschreiben` über vorhandene Zeilen — das ist der
  Ausnahmefall und will begründet sein

Danach die Anwendung im Browser öffnen und stichprobenartig prüfen: ein Monat
mit manuellen Korrekturen, ein Monat mit hochgeladenen Kontoauszügen, und einen
Beleg tatsächlich öffnen.

## 5. Kontrolle

Direkt in der Datenbank (Coolify: *Terminal* an der Datenbank):

```sh
psql -U abrechnung -d abrechnung -c "
  select 'monate' as tabelle, count(*) from monate
  union all select 'overrides', count(*) from overrides
  union all select 'kontoauszuege', count(*) from kontoauszuege
  union all select 'extraktionen', count(*) from extraktionen
  union all select 'reviews', count(*) from reviews
  union all select 'dateien', count(*) from dateien;"
```

Und die Größe der Belegtabelle, zum Vergleich mit den gemessenen 38 MB:

```sh
psql -U abrechnung -d abrechnung -c \
  "select pg_size_pretty(pg_total_relation_size('dateien'));"
```

Die Zahlen müssen zu denen aus Schritt 4 passen.

## 6. Rückweg

Der alte Lesepfad ist absichtlich noch im Code:
`packages/server/src/db/sqlite.ts` beschreibt das SQLite-Schema unverändert,
und `abrechnung.sqlite` wird von niemandem gelöscht.

Geht bei der Umstellung etwas schief:

1. In Coolify auf das vorige Deployment zurückrollen.
2. `DATABASE_URL` kann gesetzt bleiben — die alte Fassung liest sie nicht.
3. Die SQLite-Datei liegt unverändert unter `$DATA_DIR/abrechnung.sqlite`.
4. Die Belegdateien liegen unverändert unter `$DATA_DIR/monate/` — die neue
   Fassung hat sie kopiert, nicht verschoben, und schreibt neue Dateien
   weiterhin auch dorthin.

Es gehen dabei nur die Änderungen verloren, die zwischen Umstellung und
Rückrollen in der Anwendung entstanden sind. Deshalb: den Import zeitnah nach
dem Deploy machen und danach prüfen.

Erst wenn der Betrieb über einige Wochen unauffällig läuft, werden in einem
eigenen Pull Request `packages/server/src/db/sqlite.ts`, `better-sqlite3`, der
Importer und die Zweitschrift auf der Platte entfernt.

---

## Lokal entwickeln

`docker-compose.yml` bringt eine Postgres mit:

```sh
DB_PASSWORD=geheim docker compose up -d --build
```

Ohne Docker genügt eine beliebige lokale Postgres:

```sh
export DATABASE_URL=postgres://abrechnung:abrechnung@localhost:5432/abrechnung
node packages/server/scripts/starten.mjs
```

Schema geändert? Migration erzeugen, nicht von Hand schreiben:

```sh
npm run db:generate -w @abrechnung/server
```

Die Tests brauchen **keine** laufende Datenbank: sie starten eine eingebettete
Postgres im Prozess (`packages/server/src/testhilfen/datenbank.ts`).
