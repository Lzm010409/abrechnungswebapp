# Umstellung auf eine eigene Postgres-Datenbank

Die Abrechnung hielt ihren Bestand bisher in einer SQLite-Datei unter
`$DATA_DIR/abrechnung.sqlite`. Ab dieser Fassung liegt er in einer eigenen
Postgres-Datenbank, die Coolify als Ressource kennt und damit sichern kann.

Diese Anleitung beschreibt das Ausrollen, den Umzug des Altbestandes und den
Rückweg. Sie richtet sich an einen Menschen — es gibt hier nichts, was von
selbst passiert.

---

## Was umzieht und was nicht

**In die Datenbank wandern** die fünf Tabellen der bisherigen SQLite-Datei:

| Tabelle | Inhalt | Ersetzbar? |
|---|---|---|
| `monate` | Zwischenspeicher aus sevDesk | ja, jederzeit neu abrufbar |
| `overrides` | **die manuellen Korrekturen des Nutzers** | **nein** |
| `kontoauszuege` | Verzeichnis der hochgeladenen Auszüge | nein |
| `extraktionen` | Ergebnisse der KI-Belegextraktion | ja, kostet erneut Modellaufrufe |
| `reviews` | Ergebnisse der KI-Monatsprüfung | ja |

**Nicht in die Datenbank wandern** die Dateien unter `$DATA_DIR/monate/`. Sie
bleiben auf dem Volume, und für sie greift weiterhin **kein Coolify-Backup**.

Der Grund für diese Trennung steht im Code: fehlende Belegdateien holt die
Anwendung beim nächsten Laden eines Monats selbst wieder aus sevDesk
(`stelleDateienSicher` in `packages/server/src/monatsdienst.ts`). Erzeugte
Abrechnungs-PDFs werden gar nicht erst abgelegt, sondern direkt ausgeliefert.
Unwiederbringlich in diesem Verzeichnis sind allein die **vom Nutzer
hochgeladenen Kontoauszüge** — deren Verzeichniseintrag liegt jetzt zwar in der
Datenbank, die PDF-Datei selbst aber weiter auf dem Volume.

> **Offen:** Ob die Dateien mit in die Datenbank gehören (`bytea`), hängt an
> ihrer Größe. Die Messung im laufenden Container steht noch aus:
> ```
> du -sh /data/monate
> ```
> Unter etwa 500 MB wäre der Schritt sinnvoll — dann wäre ein `pg_dump` der
> vollständige Sicherungspunkt. Er gehört in einen eigenen Pull Request, nicht
> in diesen.

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
— dort liegen die Belegdateien.

Ohne `DATABASE_URL` startet der Server nicht und sagt das beim Start deutlich.

## 3. Ausrollen

Deploy des Branches. Beim Start des Containers läuft
`packages/server/scripts/starten.mjs`:

1. legt die Tabelle `__migrationen` an, falls sie fehlt
2. wendet alle noch nicht angewandten Dateien aus `packages/server/drizzle/` an
3. startet den Server

Der Vorgang ist wiederholbar. Ein zweiter Start überspringt, was schon
angewandt ist, und meldet nur `Schema aktuell (N Migrationen).`. Wurde eine
bereits angewandte Migration nachträglich verändert, gibt es eine Warnung — der
Start heilt so etwas bewusst nicht stillschweigend.

Im Log ist der erfolgreiche Start hieran zu erkennen:

```
[start] Migration 0000_special_paper_doll.sql …
[start] Schema aktuell (1 Migration).
[start] Server wird gestartet.
```

Danach ist die Anwendung benutzbar — mit **leerem** Bestand. Die alte
SQLite-Datei ist unangetastet.

## 4. Altbestand übertragen

Der Import läuft **nicht** von selbst. Er wird im laufenden Container von Hand
angestoßen (Coolify: *Terminal* an der Anwendung).

Erst ansehen, ohne zu schreiben:

```sh
node packages/server/scripts/import-altbestand.mjs --trockenlauf
```

Die Ausgabe nennt für jede Tabelle den Bestand vorher, was in der SQLite-Datei
gefunden wurde, und den Bestand nachher. Stimmen die Zahlen, dann echt:

```sh
node packages/server/scripts/import-altbestand.mjs
```

Der Importer:

- liest `$DATA_DIR/abrechnung.sqlite` (oder `--datei <pfad>`)
- ist **wiederholbar**: bereits vorhandene Zeilen bleiben unangetastet, ein
  zweiter Lauf verdoppelt nichts und überschreibt nichts
- meldet unbrauchbare Zeitstempel und ungültiges JSON, statt sie zu verschlucken
- schreibt nur mit `--ueberschreiben` über vorhandene Zeilen — das ist der
  Ausnahmefall und will begründet sein

Danach die Anwendung im Browser öffnen und stichprobenartig prüfen: ein Monat
mit manuellen Korrekturen, ein Monat mit hochgeladenen Kontoauszügen.

## 5. Kontrolle

Direkt in der Datenbank (Coolify: *Terminal* an der Datenbank):

```sh
psql -U abrechnung -d abrechnung -c "
  select 'monate' as tabelle, count(*) from monate
  union all select 'overrides', count(*) from overrides
  union all select 'kontoauszuege', count(*) from kontoauszuege
  union all select 'extraktionen', count(*) from extraktionen
  union all select 'reviews', count(*) from reviews;"
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

Es gehen dabei nur die Änderungen verloren, die zwischen Umstellung und
Rückrollen in der Anwendung entstanden sind. Deshalb: den Import zeitnah nach
dem Deploy machen und danach prüfen.

Erst wenn der Betrieb über einige Wochen unauffällig läuft, werden in einem
eigenen Pull Request `packages/server/src/db/sqlite.ts`, `better-sqlite3` und
der Importer entfernt.

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
