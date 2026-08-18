# Belegabrechnung

Monatliche Belegabrechnung für das Kfz-Sachverständigenbüro Gollenstede.
Löst den Claude-Skill `/Abrechnungsplugin` ab.

Der wesentliche Unterschied: die Buchungen kommen nicht mehr aus einem
OCR-gelesenen Kontoauszug, sondern direkt aus der sevDesk-API. Dort sind
Bankbuchung, Beleg und Rechnung bereits verknüpft — die gesamte
Rate-Heuristik des alten Skills entfällt damit.

---

## Wie es funktioniert

```
sevDesk /CheckAccountTransaction        Buchungen des Monats
        /Voucher/{id}/getCheckAccountTransactions   Buchung → Kostenbeleg
        /Invoice/{id}/getCheckAccountTransactions   Buchung → Ausgangsrechnung
                    ↓
        Aktenzeichen                    primär aus invoiceNumber der
                                        verknüpften Rechnung (exakt),
                                        sonst aus dem Verwendungszweck
                    ↓
        Belegdateien                    AUSGANG → /Voucher/{id}/getDocumentImage
                                                  (alle Seiten, zu einem Beleg
                                                   gebündelt)
                                        EINGANG → n8n → OneDrive-Gutachtenordner
                                                  (Fallback /Invoice/{id}/getPdf)
                    ↓
        Abrechnungs-PDF                 Deckblatt · Kontoauszüge · Journal · Belege
```

**Ein Beleg, eine Datei.** `getDocumentImage` liefert nicht *den* Beleg,
sondern seine *Seiten* — eine gescannte Tankquittung als Vorder- und
Rückseite, ein Kreditvertrag schon mal als zweiunddreißig Einzelseiten. Alle
werden abgerufen, damit im Abrechnungs-PDF nichts fehlt, und anschließend zu
einer PDF-Datei zusammengefasst. Sonst stünde an der Buchung „32 Dateien", die
Ablage schöbe zweiunddreißig Dateien einzeln nach OneDrive und die KI läse
denselben Vertrag zweiunddreißig Mal aus.

Lässt sich auch nur eine Seite nicht einbetten — ein TIFF, ein beschädigtes
PDF —, bleibt es beim ursprünglichen Satz Einzeldateien. Lieber mehrere
Dateien als eine, in der eine Seite fehlt.

### Aktenzeichen und Rechnungsnummer

Das sind zwei verschiedene Dinge, und die Unterscheidung entscheidet über den
Rechnungsabruf:

| Begriff | Beispiel | Was es bezeichnet |
|---|---|---|
| **Aktenzeichen** | `0124/1234TG` | den Vorgang — und damit den OneDrive-Ordner |
| **Rechnungsnummer** | `0124/1234TG01` | *eine* Rechnung darin (`01`, `02`, `03` …) |

Zu einem Aktenzeichen gehören mehrere Rechnungen (Gutachten, Fahrtkosten, …).
Gesucht wird immer über das **Aktenzeichen** — der n8n-Workflow öffnet den
Ordner des Vorgangs und liefert alle Rechnungen darin zurück. Der Index spielt
für die Suche keine Rolle; er dient nur dazu, mehrere Treffer zu sortieren.

Im Verwendungszweck steht deshalb oft nur der Vorgang, etwa
`IMRE 0724/1279TG KR O 68` — solche Zahlungen werden erkannt, der
`rechnungsindex` bleibt schlicht leer.

Die Regeln aus der ursprünglichen `references/aktenzeichen.md` sind vollständig
in `packages/server/src/aktenzeichen/` implementiert und durch Tests abgedeckt:
Leerzeichen an allen Fugen, `AZ`/`RE`-Präfixe, fehlendes `MMYY` aus dem
Buchungsdatum, mehrdeutige Formen wie `Rechnung 1800/26`.

Bleibt ein Abruf leer, wird die Monatsvariante nachgeschoben:

| # | Variante | Begründung |
|---|---|---|
| 1 | `0126/1800TG01` | wie erkannt |
| 2 | `1225/1800TG01` | Vormonat — die Buchung folgt der Rechnung um bis zu 30 Tage |

Über Indizes zu iterieren wäre wirkungslos: der Workflow verwirft sie ohnehin.
Angehängt wird `01` nur, weil dessen Regex Ziffern am Ende erwartet.

Erst danach greift die KI (falls aktiv) mit weiteren Vorschlägen.

---

## Einrichtung

```bash
npm install
cp .env.example .env      # SEVDESK_API_TOKEN und ENTRA_* eintragen
npm run dev               # Backend :3000, Frontend :5173
```

Lokal ohne Entra-Registrierung: `AUTH_MODE=disabled` in der `.env`. Das ist
ausschließlich für die Arbeit auf dem eigenen Rechner gedacht.

### Umgebungsvariablen

| Variable | Pflicht | Wirkung wenn nicht gesetzt |
|---|---|---|
| `SEVDESK_API_TOKEN` | ja | Server startet nicht |
| `ENTRA_TENANT_ID` | ja | Server startet nicht |
| `ENTRA_CLIENT_ID` | ja | Server startet nicht |
| `ENTRA_CLIENT_SECRET` | ja | Server startet nicht |
| `SESSION_SECRET` | ja | Server startet nicht (mind. 32 Zeichen) |
| `ENTRA_REDIRECT_URI` | nein | wird aus der aufgerufenen Adresse gebildet |
| `SEVDESK_CHECK_ACCOUNT_ID` | nein | Bankkonto wird beim Start automatisch ermittelt |
| `N8N_FIND_RECHNUNG_URL` | nein | Ausgangsrechnungen kommen aus sevDesk statt als Original aus OneDrive |
| `N8N_ORDNER_URL` | nein | Belegablage bleibt bei der Vorschau, es wird nichts nach OneDrive geschrieben |
| `N8N_ABLAGE_URL` | nein | dito — beide Adressen müssen gesetzt sein |
| `N8N_ORDNER_DATEIEN_URL` | nein | Belege werden als sevDesk-Kopie hochgeladen statt verschoben |
| `N8N_VERSCHIEBE_URL` | nein | dito — beide Adressen müssen gesetzt sein |
| `N8N_ABLAGE_PAUSE_MS` | nein | 350 ms Pause zwischen zwei Dateien |
| `N8N_ABLAGE_VERSUCHE` | nein | 4 Versuche je Aufruf bei Überlast |
| `ANTHROPIC_API_KEY` | nein | KI-Funktionen inaktiv, Rest läuft vollständig |
| `ENTRA_ERLAUBTE_BENUTZER` | nein | jedes Konto des Tenants darf sich anmelden |
| `ENTRA_ERLAUBTE_GRUPPEN` | nein | keine Gruppenprüfung |

Die App meldet ihren tatsächlichen Funktionsumfang über `GET /api/capabilities`;
das Frontend blendet inaktive Schaltflächen automatisch aus. **Der Anthropic-Key
lässt sich jederzeit nachträglich ergänzen** — es genügt ein Neustart.

### Anmeldung (Microsoft Entra ID)

Die Anwendung legt Kontobewegungen und Belege offen. Ohne konfigurierte
Anmeldung **startet der Server nicht** und nennt die fehlenden Variablen.

Verfahren: OpenID Connect, Authorization Code mit PKCE (S256). Das ID-Token
wird gegen die JWKS des Tenants geprüft (Signatur, `iss`, `aud`, `nonce`,
Ablauf). Daraus entsteht ein eigenes, kurzlebiges Sitzungscookie —
HttpOnly, Secure, SameSite=Lax. Das Microsoft-Token wird nicht gespeichert.

**Einrichtung im Azure-Portal** (Microsoft Entra ID → App-Registrierungen →
Neue Registrierung):

1. Name z. B. `Belegabrechnung`, Kontotypen: *Nur Konten in diesem
   Organisationsverzeichnis*.
2. Redirect-URI, Plattform **Web**:
   `https://abrechnung.example.de/auth/callback`
   Das ist der einzige Ort, an dem sie stehen muss — der Server bildet sie
   selbst aus der Adresse, unter der er aufgerufen wurde. `ENTRA_REDIRECT_URI`
   ist nur nötig, wenn die Anwendung intern anders heißt als nach außen.
3. Übersicht: *Anwendungs-ID* → `ENTRA_CLIENT_ID`,
   *Verzeichnis-ID* → `ENTRA_TENANT_ID`.
4. *Zertifikate & Geheimnisse* → neuer geheimer Clientschlüssel →
   `ENTRA_CLIENT_SECRET` (Ablaufdatum notieren, er muss erneuert werden).
5. API-Berechtigungen: `openid`, `profile`, `email` genügen — es werden keine
   Daten aus Microsoft 365 gelesen.
6. `SESSION_SECRET` erzeugen: `openssl rand -base64 48`.

Zugang einschränken (optional): `ENTRA_ERLAUBTE_BENUTZER` mit E-Mail-Adressen
oder `ENTRA_ERLAUBTE_GRUPPEN` mit Objekt-IDs, jeweils kommagetrennt. Für
Gruppen muss in der App-Registrierung unter *Tokenkonfiguration* der Anspruch
`groups` aktiviert sein.

Endpunkte: `GET /auth/login`, `GET /auth/callback`, `GET /auth/me`,
`POST /auth/logout`. Geschützt ist alles unter `/api/` außer `/api/health`
(Container-Healthcheck) und `/api/capabilities`, das ohne Sitzung mit
`{ "angemeldet": false }` antwortet — daran erkennt das Frontend, dass es die
Anmeldeseite zeigen muss.

### Bankkonto

Ohne `SEVDESK_CHECK_ACCOUNT_ID` wählt der Server beim Start das aktive
Online-Bankkonto. Gibt es mehrere, bricht er mit einer Liste der Kandidaten ab,
statt sich eines auszusuchen:

```
Mehrere aktive Bankkonten gefunden - bitte SEVDESK_CHECK_ACCOUNT_ID setzen:
1234567 (Geschäftskonto, DE89…3000), 1234568 (Rücklagen, DE89…3001)
```

### Die optionalen Funktionen aktivieren

Alle drei sind bewusst abschaltbar: die Anwendung läuft ohne sie vollständig.
Was fehlt, steht unter dem Monatstitel („OneDrive-Abruf inaktiv", „KI inaktiv").
Jede wird über Umgebungsvariablen eingeschaltet, danach **Neustart der
Anwendung** — in Coolify genügt *Redeploy*.

#### 1. OneDrive-Abruf — `N8N_FIND_RECHNUNG_URL`

**Wofür:** die Originalrechnung zu einer Geldeingangs-Buchung. sevDesk kennt
nur die dort erzeugte Rechnung; das unterschriebene Original liegt im
Gutachtenordner in OneDrive. Ist die Variable leer, fällt der Server
stillschweigend auf `GET /Invoice/{id}/getPdf` aus sevDesk zurück — es fehlt
also kein Beleg, es ist nur nicht das Original.

**Wie:** der Workflow **Find Rechnung API** (`9sb35dqgF6q82aJW`) ist bereits
angelegt. Er ist eine reine HTTP-Fassade vor dem bestehenden Workflow
*Find Rechnung* (`9Yilx9TtGrOsdnJm`) — dessen erprobte OneDrive-Logik bleibt
unangetastet.

1. In n8n den Workflow **Find Rechnung API** öffnen und **aktivieren**
   (Schalter oben rechts). Ohne das antwortet nur die Test-URL, und zwar nur
   für einen einzigen Aufruf.
2. Im Webhook-Knoten die *Production URL* kopieren:
   `https://n8n-coolify.gollenstede.app/webhook/abrechnung/find-rechnung`
3. Als `N8N_FIND_RECHNUNG_URL` eintragen, Anwendung neu starten.

```
POST { "Rechnungsnummer": "0126/1800TG01" }
→    [ { "file": "<base64>", "filename": "0126_1800TG01_Rechnung.pdf" } ]
```

Gesucht wird über das Aktenzeichen `0126/1800TG`; der Index wird vom Workflow
verworfen (siehe oben). Soll der Webhook nicht offen erreichbar sein: in n8n
Header-Auth aktivieren und `N8N_WEBHOOK_AUTH_HEADER` /
`N8N_WEBHOOK_AUTH_VALUE` setzen.

#### 2. KI-Funktionen — `ANTHROPIC_API_KEY`

**Wofür:** vier Funktionen, die ausschließlich Zweifelsfälle betreffen — siehe
Abschnitt [KI-Funktionen](#ki-funktionen). Beträge, Verknüpfungen und Summen
kommen immer aus sevDesk, nie aus dem Modell.

**Wie:** Key unter <https://console.anthropic.com> erzeugen (Format `sk-ant-…`),
als `ANTHROPIC_API_KEY` eintragen, Anwendung neu starten. Optional lassen sich
`ANTHROPIC_MODEL` (Standard `claude-sonnet-5`) und `ANTHROPIC_EFFORT`
(`low`…`max`, Standard `high`) setzen.

Danach erscheinen in der Aktionsleiste die Schaltflächen **Belege auslesen** und
**Monat prüfen**, im Detailbereich **Aktenzeichen vorschlagen**. Kosten fallen
nur beim Klick an — es läuft nichts automatisch im Hintergrund. Belege werden
je Datei-Hash zwischengespeichert, dieselbe Datei geht also nie zweimal an das
Modell.

Das Token-Budget je Anfrage deckt **Denken und Antwort zusammen** ab und ist
deshalb großzügig bemessen (32 000 für Monatsprüfung und Zuordnung). Bezahlt
wird, was tatsächlich anfällt, nicht das Budget. Meldet die Oberfläche
trotzdem einmal *„Die KI-Antwort war länger als das eingeräumte Budget"*, ist
ein kleinerer `ANTHROPIC_EFFORT` (z. B. `medium`) das richtige Mittel: das
Modell denkt dann kürzer und hat mehr Platz für die Antwort.

#### 3. Belegablage in OneDrive — `N8N_ORDNER_URL` / `N8N_ABLAGE_URL`

**Wofür:** die Belege eines Monats in die OneDrive-Monatsordner `Konto`, `Bar`
und `Tanken` einsortieren — siehe [Belege nach OneDrive
einsortieren](#belege-nach-onedrive-einsortieren). Fehlt eine der beiden
Adressen, bleibt es bei der Vorschau: die Einteilung wird berechnet und
angezeigt, geschrieben wird nichts.

**Wie:** beide Workflows sind angelegt und müssen in n8n nur **aktiviert**
werden; danach die jeweilige *Production URL* des Webhook-Knotens eintragen.

| Variable | Workflow | ID |
|---|---|---|
| `N8N_ORDNER_URL` | Find Ausgabenordner für Jahr und Monat | `FfLNDgPrXdV6lJe3` |
| `N8N_ABLAGE_URL` | Zuordnung der Dateien in die Ordner | `oaYHe4LgfsYWBK3j` |

Die Ordnersuche bekommt eine **Liste mit einem Eintrag**, Jahr vierstellig,
Monat zweistellig; aus der Antwort wird die erste Zeichenkette genommen, die
nach einer OneDrive-Kennung aussieht (`ordnerId`, `folderId`, `id`, `itemId`,
`driveItemId` — sonst der erste Treffer in der Tiefensuche):

```
POST [ { "jahr": "2026", "monat": "07" } ]
→    [ { "id": "017CTANMEXRS4RMU2ZWRB32HLMDMEXZM5B" } ]
```

> **Der Webhook muss auf das Ergebnis warten.** Steht im Webhook-Knoten
> *Respond* auf `Immediately`, antwortet n8n mit
> `{"message":"Workflow was started"}` und schickt die Ordner-ID nie —
> die Ablage meldet dann „kein Ausgabenordner gefunden". Richtig ist
> `Using Respond to Webhook node` oder `Last node`. Die Fehlermeldung in der
> Oberfläche weist ausdrücklich darauf hin, wenn genau das passiert.

Die Ablage bekommt je Datei einen Aufruf, `inhalt` ist base64:

```
POST { "ordnerId": "01ABCDEF…", "unterordner": "Bar",
       "dateiname": "0726_1800TG01.pdf", "inhalt": "<base64>" }
```

#### Verschieben statt Hochladen (empfohlen)

Die Belege **liegen bereits im Monatsordner** — dort werden sie abgelegt. Lädt
die Anwendung stattdessen eine Kopie aus sevDesk in den Unterordner, hat man
die Datei zweimal: einmal einsortiert, einmal weiter lose daneben. Mit zwei
weiteren Workflows wird die vorhandene Datei einfach verschoben:

| Variable | Workflow soll | Aufruf |
|---|---|---|
| `N8N_ORDNER_DATEIEN_URL` | die Dateien eines Ordners auflisten | `POST [{ "ordnerId": "…" }]` |
| `N8N_VERSCHIEBE_URL` | eine Datei in einen Unterordner verschieben | `POST { "ordnerId", "unterordner", "dateiId" }` |

Die Liste wird gelesen wie überall bei n8n — ohne feste Feldnamen. Erkannt
werden `id`/`itemId`/`driveItemId`, `name`/`filename` und `size`; Einträge mit
einem `folder`-Objekt werden übersprungen, damit kein Ordner in sich selbst
wandert. Die OneDrive-Antwort passt also unverändert:

```
→ [ { "id": "01ABC…", "name": "Scan_20260622.pdf", "size": 8421 },
    { "id": "01DEF…", "name": "Konto", "folder": { "childCount": 3 } } ]
```

**Der Abgleich** läuft in zwei Stufen, die stärkere zuerst:

1. **gleicher Dateiname** — trägt bei allem, was von Hand hochgeladen wurde
   oder dessen Name sevDesk unverändert übernommen hat
2. **gleiche Größe in Bytes, und zwar eindeutig** — sevDesk-Belege heißen bei
   uns `beleg-<voucherId>.pdf`, der Name des Originals ist ein ganz anderer.
   Gibt es mehrere Dateien derselben Größe, wird **nicht geraten**

Was sich nicht zuordnen lässt, wird hochgeladen wie bisher — besser eine Kopie
als ein fehlender Beleg. Was in OneDrive übrig bleibt, steht in der Vorschau
unter *„… ohne passende Buchung — bleiben liegen"*. Genau dort zeigt sich, wo
der Abgleich danebenliegt oder ein Beleg in sevDesk fehlt.

Sind die beiden Variablen nicht gesetzt, wird der Monatsordner gar nicht erst
gelesen und alles läuft wie zuvor.

**Gedrosselt, damit n8n nicht umkippt:** die Dateien gehen einzeln und
nacheinander hinaus, dazwischen liegen 350 ms
(`N8N_ABLAGE_PAUSE_MS`). Antwortet n8n mit 429 oder einem 5xx, wird der Aufruf
bis zu viermal wiederholt (`N8N_ABLAGE_VERSUCHE`) — die Wartezeit verdoppelt
sich dabei von einer Sekunde an, ein mitgeschicktes `Retry-After` hat Vorrang.
Ein 400 oder 404 wird nicht wiederholt; der käme beim zweiten Mal genauso
zurück. Scheitert eine einzelne Datei endgültig, wird der Fehler an ihr
vermerkt und die restlichen werden trotzdem abgelegt.

Auch hier gilt: sollen die Webhooks nicht offen erreichbar sein, in n8n
Header-Auth aktivieren und `N8N_WEBHOOK_AUTH_HEADER` /
`N8N_WEBHOOK_AUTH_VALUE` setzen — sie gelten für alle drei Workflows gemeinsam.

Prüfen, ob alles greift:

```
GET /api/capabilities
→ { "ki": true, "kiModell": "claude-sonnet-5", "n8nRechnungsabruf": true,
    "onedriveAblage": true, … }
```

---

## Bedienung

Alle Buchungen eines Monats sind gleichzeitig sichtbar — kein phasenweises
Bestätigen wie im alten Skill.

### Laden mit sichtbarem Fortschritt

Ein Monat aus sevDesk zu holen dauert je nach Buchungszahl viele Sekunden —
pro Beleg mindestens ein HTTP-Aufruf. Die Oberfläche wartet deshalb nicht auf
eine einzige Antwort, sondern liest einen Ereignisstrom:

```
GET /api/months/2026-06/stream[?refresh=true]     (Server-Sent Events)

data: {"art":"fortschritt","fortschritt":{"phase":"transaktionen","text":"…"}}
data: {"art":"teil","monat":{…}}       ← Buchungen stehen, Belege fehlen noch
data: {"art":"fertig","monat":{…}}
```

Sichtbar wird das als Liste, die sich aufbaut: erst die Phasen mit
Zählerständen, dann — sobald die Buchungen stehen — die vollständige Tabelle,
während im Hintergrund noch die Belegdateien nachlaufen.

Der Zwischenstand wird bewusst **nicht** in den Cache geschrieben; bricht der
Abruf danach ab, wäre sonst ein Monat ohne Belege gespeichert. Kommt kein Strom
zustande (puffernder Reverse-Proxy), fällt das Frontend automatisch auf
`GET /api/months/:monat` zurück. Alle 15 Sekunden geht ein Lebenszeichen über
die Verbindung (`: puls`), damit ein zwischengeschalteter Proxy sie nicht für
tot hält.

### Langläufer laufen im Hintergrund

**Belege auslesen**, **Monat prüfen** und die **Belegablage** dauern Minuten.
Sie in einer offenen HTTP-Anfrage abzuwarten hat zweierlei gekostet:

- Cloudflare kappt eine Verbindung, über die 100 Sekunden lang nichts fließt,
  mit **HTTP 524**. Bei der Monatsprüfung ist genau das der Normalfall — ein
  einzelner Modellaufruf, dazwischen passiert nichts zu melden. Der Nutzer sah
  einen Fehler, während das Modell weiterarbeitete und Geld kostete.
- Wer das Fenster wechselte oder neu lud, verlor den Lauf mitsamt Ergebnis.

Deshalb führt der Server diese Vorgänge selbst zu Ende. Der Start antwortet
sofort mit `202`, die Oberfläche fragt den Stand in kurzen Einzelaufrufen ab —
**es wird nie eine Verbindung offen gehalten, während gearbeitet wird.**

```
POST /api/months/2026-06/ai/extract/job    → 202 { "id": "…", "status": "laeuft" }
POST /api/months/2026-06/ai/review/job     → 202
POST /api/months/2026-06/ablage/job[?ausfuehren=true] → 202

GET    /api/vorgaenge?monat=2026-06   → alle Vorgänge des Monats, neueste zuerst
GET    /api/vorgaenge/:id             → Status, Fortschritt, Ergebnis
DELETE /api/vorgaenge/:id             → abgeschlossenen Vorgang vergessen
```

In der Oberfläche erscheint eine **Leiste** unter der Kopfzeile — bewusst keine
Sperrschicht: daneben lässt sich weiterarbeiten, der Monat wechseln, die Seite
neu laden. Sie zeigt je Vorgang den zuletzt gemeldeten Schritt samt Zähler.
**Erst wenn der Vorgang durch ist**, wird das Ergebnis übernommen und der
Nutzer informiert — die Prüfbefunde erscheinen, die ausgelesenen Belege stehen
in der Tabelle, die Ablagevorschau klappt auf.

Abgeschlossene Vorgänge bleiben eine Stunde abrufbar, damit ein Ergebnis auch
ankommt, wenn gerade niemand hinsieht. Ein Serverneustart verwirft sie: sie
liegen im Arbeitsspeicher, nicht in der Datenbank. Das ist Absicht — ein Lauf,
den niemand mehr zu Ende führt, soll nicht als „läuft" konserviert werden.

| Ampel | Bedeutung |
|---|---|
| grün | Beleg eindeutig zugeordnet — oder als belegfrei markiert |
| gelb | mehrere Treffer, Entscheidung nötig |
| rot | kein Beleg gefunden |
| grau | aus der Abrechnung ausgeblendet |

### Mehrere Treffer: die Auswahl muss bestätigt werden

Liefert der OneDrive-Abruf mehr als eine passende Datei, wird die erste
**vorgeschlagen** — die Buchung bleibt aber gelb, bis jemand entschieden hat.
Auch wenn der Vorschlag der richtige ist, braucht es den Klick: „als richtigen
Beleg bestätigen". Erst damit wird die Buchung grün. Die übrigen Treffer
bleiben sichtbar und lassen sich jederzeit nachträglich wählen.

### Buchungen ohne Belegpflicht

Nicht jede Buchung hat einen Beleg, und nicht jede braucht einen. Zwei
Markierungen im Detailbereich:

| Markierung | Wofür |
|---|---|
| **Privatentnahme** | Entnahme fürs Private — gehört in die Abrechnung, hat keinen Beleg |
| **Dauerbeleg** | Miete, Leasing, Abo — der Beleg liegt einmalig als Vertrag vor |
| **Umbuchung** | Übertrag zwischen eigenen Konten — dazu gibt es keinen Beleg |

Alle drei machen die Buchung grün und erledigt. Der Unterschied zum Ausblenden ist
wichtig: eine markierte Buchung **bleibt** in Journal, Summen und PDF stehen —
in der Beleg-Spalte steht dann `privat` bzw. `Dauerbeleg`. Eine ausgeblendete
Buchung fällt dagegen ganz heraus. Nochmal auf dieselbe Markierung klicken
nimmt sie zurück.

Umbuchungen stecken weiterhin in Einnahmen und Ausgaben: dort stehen die
Bewegungen des Kontos, und eine Umbuchung ist eine davon. Das Deckblatt weist
sie separat aus, damit sich der reine Geschäftserfolg herausrechnen lässt.

### Mehrere Buchungen auf einmal

Über die Kästchen links lassen sich beliebig viele Zeilen anhaken (oder alle
über das Kästchen in der Kopfzeile). Darüber erscheint eine Leiste, die eine
Entscheidung für alle Angehakten übernimmt: markieren, Markierung entfernen
oder ausblenden. Das geht in **einem** Aufruf an den Server, nicht in einem pro
Buchung — bei wiederkehrenden Posten spart das den Großteil der Klickarbeit.

**Manuelle Korrekturen überleben jeden Neuabruf.** „Aus sevDesk laden" holt die
Buchungen frisch, lässt eingetragene Aktenzeichen, Belegzuordnungen und
Ausblendungen aber unangetastet — sie liegen getrennt in der `overrides`-Tabelle.
Im Cache stehen ausschließlich die Rohdaten aus sevDesk, sodass sich jede
Korrektur jederzeit wieder zurücknehmen lässt.

### Noch nicht zugeordnete Buchungen

Ein Monat ist selten beim ersten Laden fertig: Buchungen, die in sevDesk noch
keiner Rechnung und keinem Beleg zugeordnet sind, kann die App nicht auflösen.
Sie werden deshalb ausdrücklich von „Beleg fehlt" unterschieden — sonst sucht
man den Fehler an der falschen Stelle.

* In der Tabelle tragen sie die Marke **sevDesk** und den Text `nicht verbucht`.
* Über der Liste erscheint ein Hinweisbanner mit der Anzahl und einem
  Direktlink zum Neuladen.
* `summen.anzahlNichtZugeordnet` zählt sie getrennt.

Der Ablauf ist damit: in sevDesk verbuchen → hier „Aus sevDesk laden" → die
Zuordnung und die Belege werden übernommen.

### Status eines Monats abfragen

Ohne sevDesk-Abruf, für Übersichten und zum Nachschauen, ob ein Monat fertig ist:

```
GET /api/months/2026-06/status
→ { "monat": "2026-06", "geladen": true,
    "synchronisiertAm": "2026-07-26T20:27:50.683Z",
    "summen": { …, "anzahlNichtZugeordnet": 1 },
    "abgeschlossen": false, "anzahlKontoauszuege": 1 }

GET /api/months?von=2026-01&bis=2026-12     # Jahresübersicht
```

`abgeschlossen` ist genau dann `true`, wenn keine Buchung mehr offen,
mehrdeutig oder in sevDesk unzugeordnet ist.

### Kontoauszüge

Werden pro Monat hochgeladen und dem Abrechnungs-PDF direkt nach dem Deckblatt
vorangestellt, in der in der UI sichtbaren Reihenfolge.

Die Belege werden hinter genau die Auszugs-*Seite* gestellt, auf der die
zugehörige Buchung steht — die Form, die die Steuerberatung erwartet.

Woher die Zuordnung kommt: gelesen wird die **Textebene** des Auszugs-PDF, nicht
dessen Bild. Bank-Auszüge bringen die praktisch immer mit, ein OCR ist nicht
nötig. Gesucht wird der Betrag in deutscher Schreibweise (mit und ohne
Tausenderpunkt, Vorzeichen egal), das Buchungsdatum bestätigt den Treffer, falls
derselbe Betrag mehrfach vorkommt. Ein Teilbetrag wird dabei nicht mit dem
ganzen verwechselt: `5,17` trifft nicht in `595,17`.

Was nicht zugeordnet werden kann, wird nicht geraten. Buchungen ohne Treffer —
Barzahlungen etwa — landen hinter einem Trenner am Ende. Fehlt die Textebene
ganz (eingescannter Auszug), bleibt es bei der einfachen Reihenfolge: erst alle
Auszugsseiten, dann alle Belege.

In jedem Fall trägt jede Belegseite eine Kopfzeile mit der Positionsnummer aus
dem Monatsjournal:

```
Pos. 7  |  03.06.2026  |  892,50 EUR  |  0626/1811TG01  |  0626_1811TG01_Rechnung.pdf
```

### Aufbau des Abrechnungs-PDFs

Mit Kontoauszug:

1. Deckblatt mit Summen, Statuszählern und Warnhinweis bei Unvollständigkeit
2. Monatsjournal (alle Buchungen mit laufender Nummer)
3. je Auszugsseite: die Seite selbst, dahinter die Belege der Buchungen darauf
4. Trenner, dahinter die Belege ohne Seitenzuordnung

Ohne Kontoauszug (oder ohne lesbare Textebene) bleibt es bei Deckblatt →
Journal → Auszugsseiten → alle Belege in Buchungsreihenfolge; innerhalb eines
Tages erst AUSGANG, dann EINGANG.

---

## KI-Funktionen

Optional, Modell `claude-sonnet-5`. Beide Aufgaben — Belegdaten auslesen und
einen Monat auf Plausibilität prüfen — sind für Sonnet unkritisch; Opus kostet
ein Vielfaches, ohne hier erkennbar besser zu sein. Wer es anders will, setzt
`ANTHROPIC_MODEL`. Das Modell entscheidet ausschließlich
Zweifelsfälle — Beträge, Verknüpfungen und Summen kommen aus sevDesk.

Beide länger laufenden Funktionen sind
[Hintergrundvorgänge](#langläufer-laufen-im-hintergrund) — beim Auslesen mit
Zähler („Beleg 7 von 26" samt Dateiname), bei der Prüfung mit der Angabe,
worauf gewartet wird:

```
POST /api/months/2026-06/ai/extract/job   → 202, läuft weiter
POST /api/months/2026-06/ai/review/job    → 202, läuft weiter
```

Die Endpunkte ohne `/job` gibt es weiterhin; sie liefern dasselbe in einer
Antwort — und laufen genau deshalb bei einem vollen Monat in den
Proxy-Zeitablauf. Für die Oberfläche sind sie nicht gedacht.

Das Token-Budget je Anfrage deckt **Denken und Antwort zusammen** ab; die
Werte stehen in `packages/server/src/ai/client.ts` unter `BUDGET`.

| Funktion | Wo | Was |
|---|---|---|
| Belege auslesen | Aktionsleiste | PDF direkt an das Modell, kein OCR. Ergebnis pro Datei-Hash gecacht |
| Aktenzeichen vorschlagen | Detailbereich | wenn die deterministische Retry-Kette leer blieb |
| Monat prüfen | Aktionsleiste | Dubletten, Betragsabweichungen, fehlende Belege, USt-Plausibilität |
| Zuordnung vorschlagen | `POST /api/months/:monat/ai/match` | Betrag → Datum → Name, wie im alten Skill |

---

## Tests

```bash
npm test
```

307 Tests. Der Schwerpunkt liegt auf `e2e.test.ts`: dort läuft die echte
Anwendung (`baueApp`) gegen einen lokalen Nachbau der sevDesk-API und des
n8n-Webhooks, sodass die gesamte Kette geprüft wird —

```
HTTP-Route → MonatsDienst → sevDesk-Client → Mock-sevDesk
                          → RechnungsProvider → Mock-n8n
                          → Dateiablage → SQLite → PDF
```

Abgedeckt sind unter anderem: Bankkonto-Ermittlung samt Mehrdeutigkeit,
Zeitzonen-Randfälle an Monatsgrenzen, Paginierung über 100 Datensätze hinaus,
unzugeordnete Buchungen und ihre Auflösung nach dem Verbuchen in sevDesk,
manuelle Korrekturen samt Zurücknehmen, Kandidatenauswahl, Kontoauszug-Upload,
PDF-Zusammenbau in korrekter Reihenfolge, Betrieb ohne n8n, Betrieb ohne
KI-Key, der Lade-Stream samt Abbruchverhalten, sowie sevDesk-Ausfälle
(404/500).

Die Anmeldung hat eine eigene Datei (`auth/auth.test.ts`): geschlossene API,
PKCE, `state`/`nonce`, Signaturprüfung des ID-Tokens gegen eine lokale JWKS,
abgelaufene und manipulierte Sitzungen, Benutzer- und Gruppenfilter sowie
offene Redirects.

Der KI-Layer wird gegen einen lokalen Nachbau des Claude-Endpunkts geprüft:
verifiziert werden Modell, adaptives Thinking, das Fehlen der entfernten
Sampling-Parameter, `output_config` mit JSON-Schema und der PDF-Dokumentblock.
Ein echter API-Aufruf findet dabei nicht statt.

---

## Deployment

```bash
docker compose up -d --build
```

`/data` **muss** als Volume eingebunden werden — dort liegen SQLite-Datenbank,
Belegcache und erzeugte PDFs. In Coolify geschieht das unter *Persistent
Storage* (Pfad `/data`); mit `docker compose` erledigt es die mitgelieferte
`docker-compose.yml`.

Fehlt die Einbindung, liegen die Daten in der Schreibschicht des Containers und
sind beim nächsten Deploy weg. Sichtbar wird das erst später und an der falschen
Stelle — als Beleg, der sich nicht mehr anzeigen lässt. Der Server warnt
deshalb beim Start, wenn `/data` nicht eingebunden ist, und holt fehlende
Belegdateien beim nächsten Laden des Monats automatisch neu.

**Vor dem nächsten Deploy** müssen die Entra-Variablen gesetzt sein
(`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
`SESSION_SECRET`). Fehlen sie, verweigert der Server den Start — das ist Absicht: die Anwendung war zuvor ohne Anmeldung öffentlich
erreichbar und wurde in den Logs nachweislich nach `.env` und `.git/config`
abgesucht.

Hinter einem Reverse-Proxy: der Lade-Stream braucht ungepufferte Antworten. Der
Server setzt dafür `X-Accel-Buffering: no`; Traefik und Caddy respektieren das
ohne weitere Einstellung.

---

## Belege nach OneDrive einsortieren

Beim Erzeugen des Abrechnungs-PDF werden die **Ausgabenbelege** den
Monatsordnern zugeteilt:

| Ordner | Inhalt |
|---|---|
| `Konto` | alles, was sich einer Kontoauszugsseite zuordnen ließ |
| `Tanken` | von den übrigen die Tankbelege |
| `Bar` | der Rest |

**Nur Ausgaben.** Geldeingänge bleiben außen vor: die zugehörigen
Ausgangsrechnungen liegen in OneDrive im Gutachtenordner des jeweiligen
Vorgangs, eine Kopie im Monatsordner wäre eine zweite, konkurrierende Ablage
derselben Datei. Geprüft wird beides — die Richtung der Buchung und die
Herkunft der Datei: ein Beleg aus dem Gutachtenordner oder aus einer
sevDesk-Ausgangsrechnung bleibt auch dann liegen, wenn er an einer
AUSGANG-Buchung hängt (etwa bei einer Gutschrift).

Die Reihenfolge der Regeln ist nicht beliebig: eine mit Karte bezahlte
Tankfüllung steht auf dem Kontoauszug und gehört nach `Konto`. `Tanken` meint
die bar bezahlten Tankbelege.

Warum erst am Schluss: die Einteilung hängt daran, welche Buchung sich auf
einer Auszugsseite wiederfindet — dieselbe Zuordnung, die auch die Reihenfolge
im PDF bestimmt. Vorher steht sie schlicht nicht fest.

### Ordner von Hand festlegen

Die Regel ist eine Heuristik und liegt gelegentlich daneben — eine Tankstelle,
die nicht in der Markenliste steht, oder eine Barzahlung, die zufällig auf
einer Auszugsseite auftaucht. Deshalb lässt sich der Zielordner **direkt an der
Buchung** einstellen:

- im Detailbereich unter **Ablageordner** — `Konto`, `Bar`, `Tanken`; ein
  erneuter Klick auf den gewählten Ordner (oder *wieder automatisch*) gibt die
  Buchung der Regel zurück
- über die Sammelleiste für alle angehakten Buchungen auf einmal

Ein gesetzter Ordner **sticht die Regel** — die Automatik greift nur, solange
nichts eingestellt ist. In der Tabelle steht der Ordner als blasse Marke (`→
Tanken`) an der Zeile, in der Ablagevorschau als `· von Hand` hinter dem
Dateinamen. Die Einstellung überlebt das Neuladen aus sevDesk, wie jede andere
manuelle Korrektur auch.

```
PATCH /api/months/2026-06/positions/tx-42   { "ablageordner": "Tanken" }
PATCH /api/months/2026-06/positions/tx-42   { "ablageordner": null }      → wieder automatisch
PATCH /api/months/2026-06/positions         { "positionIds": [...], "patch": { "ablageordner": "Bar" } }
```

**Verschoben wird nichts von allein.** Nach dem PDF erscheint eine Vorschau mit
der Einteilung; erst ein Klick legt die Dateien ab. Ohne die beiden Webhooks
bleibt es bei der Vorschau — die ist auch ohne OneDrive nützlich.

```
POST /api/months/2026-06/ablage                     → Vorschau (blockierend)
POST /api/months/2026-06/ablage?ausfuehren=true     → legt ab (blockierend)
POST /api/months/2026-06/ablage/job[?ausfuehren=…]  → als Hintergrundvorgang
```

**Der Lauf ist sichtbar und blockiert nicht.** Fünfzig Belege einzeln und
gedrosselt hochzuladen dauert Minuten. Der Klick auf *Belege jetzt ablegen*
startet deshalb einen [Hintergrundvorgang](#langläufer-laufen-im-hintergrund);
die Leiste zeigt drei Schritte: **Belege werden eingeteilt**, **Monatsordner
wird gesucht**, **Belege werden abgelegt** (mit Zähler und aktuellem
Dateinamen). Das Ergebnis des vorigen Versuchs wird beim Start weggeräumt —
sonst stünde dessen Hinweis noch da, während der neue Lauf schon unterwegs
ist.

Findet der Workflow keinen Monatsordner, nennt die Meldung, **womit er gefragt
wurde und was er geantwortet hat**. Nur „kein Ausgabenordner gefunden" ließ
offen, ob der Workflow nichts fand, gar nicht aktiviert ist oder bloß anders
antwortet als erwartet.

Geschrieben wird über zwei n8n-Workflows: **Find Ausgabenordner für Jahr und
Monat** (`FfLNDgPrXdV6lJe3`) liefert zu `[{ jahr, monat }]` die Ordner-ID,
**Zuordnung der Dateien in die Ordner** (`oaYHe4LgfsYWBK3j`) legt je Aufruf eine
Datei ab. Beide Adressen werden über `N8N_ORDNER_URL` und `N8N_ABLAGE_URL`
gesetzt — Aufrufformat und Einrichtung stehen unter [Belegablage in
OneDrive](#3-belegablage-in-onedrive--n8n_ordner_url--n8n_ablage_url).

---

## Offene Punkte

**Der Live-Lauf gegen die echte sevDesk-API steht noch aus.** Die Session, in
der dieser Code entstanden ist, kam nicht an `my.sevdesk.de` heran (die
Egress-Policy lehnte den Verbindungsaufbau durchgehend mit 403 ab). Getestet
wurde daher gegen einen Nachbau der API, der ihre Eigenheiten abbildet:
`{objects:…}`-Hülle, Beträge als Strings, Paginierung, Zeitstempel mit Offset.

Zwei Annahmen über die echte API konnten damit nicht verifiziert werden. Beide
sind im Code mit `SPIKE:` markiert und jeweils so abgesichert, dass ein Irrtum
die Abrechnung nicht verfälscht:

| Stelle | Annahme | Absicherung falls falsch |
|---|---|---|
| `GET /CheckAccountTransaction` Datumsfilter | Unix-Sekunden in `startDate`/`endDate` | Das Fenster wird serverseitig um zwei Tage geweitet, die exakte Abgrenzung macht ein clientseitiger Filter auf dem Datumsteil. Ergebnis stimmt in jedem Fall; schlimmstenfalls werden zu viele Datensätze geholt. |
| `GET /Invoice/{id}/getCheckAccountTransactions` | existiert analog zu `/Voucher/…` | 404/400 wird abgefangen; die Zuordnung läuft dann über das Aktenzeichen im Verwendungszweck. Ein E2E-Test deckt genau diesen Fall ab. |

Die Verknüpfung `Voucher → Buchungen` ist dokumentiert und damit gesichert.

**Beim ersten echten Lauf zu prüfen:** ob die Positionsanzahl eines Monats zum
Kontoauszug passt (Datumsfilter) und ob `sevdeskStatus` plausible Werte zeigt
(Statuscodes 100/200/300/400).
