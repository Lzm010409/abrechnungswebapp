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
                                        EINGANG → n8n → OneDrive-Gutachtenordner
                                                  (Fallback /Invoice/{id}/getPdf)
                    ↓
        Abrechnungs-PDF                 Deckblatt · Kontoauszüge · Journal · Belege
```

### Aktenzeichen

Format `MMYY/<Schadennummer>TG<Index>`, z. B. `0126/1800TG01`.

Die Regeln aus der ursprünglichen `references/aktenzeichen.md` sind vollständig
in `packages/server/src/aktenzeichen/` implementiert und durch Tests abgedeckt:
Leerzeichen an allen Fugen, `AZ`/`RE`-Präfixe, fehlendes `MMYY` aus dem
Buchungsdatum, mehrdeutige Formen wie `Rechnung 1800/26`.

Bleibt ein Abruf leer, wird eine feste Retry-Kette durchprobiert:

| # | Variante | Begründung |
|---|---|---|
| 1 | `0126/1800TG01` | wie erkannt |
| 2 | `1225/1800TG01` | Vormonat — die Buchung folgt der Rechnung um bis zu 30 Tage |
| 3 | `0126/1800TG02` | anderer Rechnungsindex (Gutachten ↔ Fahrtkosten) |
| 4 | `1225/1800TG02` | beides kombiniert |

Erst danach greift die KI (falls aktiv) mit weiteren Vorschlägen.

---

## Einrichtung

```bash
npm install
cp .env.example .env      # SEVDESK_API_TOKEN eintragen
npm run dev               # Backend :3000, Frontend :5173
```

### Umgebungsvariablen

| Variable | Pflicht | Wirkung wenn nicht gesetzt |
|---|---|---|
| `SEVDESK_API_TOKEN` | ja | Server startet nicht |
| `SEVDESK_CHECK_ACCOUNT_ID` | nein | Bankkonto wird beim Start automatisch ermittelt |
| `N8N_FIND_RECHNUNG_URL` | nein | Ausgangsrechnungen kommen aus sevDesk statt als Original aus OneDrive |
| `ANTHROPIC_API_KEY` | nein | KI-Funktionen inaktiv, Rest läuft vollständig |

Die App meldet ihren tatsächlichen Funktionsumfang über `GET /api/capabilities`;
das Frontend blendet inaktive Schaltflächen automatisch aus. **Der Anthropic-Key
lässt sich jederzeit nachträglich ergänzen** — es genügt ein Neustart.

### Bankkonto

Ohne `SEVDESK_CHECK_ACCOUNT_ID` wählt der Server beim Start das aktive
Online-Bankkonto. Gibt es mehrere, bricht er mit einer Liste der Kandidaten ab,
statt sich eines auszusuchen:

```
Mehrere aktive Bankkonten gefunden - bitte SEVDESK_CHECK_ACCOUNT_ID setzen:
1234567 (Geschäftskonto, DE89…3000), 1234568 (Rücklagen, DE89…3001)
```

### n8n-Anbindung

Der Workflow **Find Rechnung API** (`9sb35dqgF6q82aJW`) ist bereits angelegt.
Er ist eine reine HTTP-Fassade vor dem bestehenden Workflow *Find Rechnung*
(`9Yilx9TtGrOsdnJm`) — dessen erprobte OneDrive-Logik bleibt unangetastet.

Vor der ersten Nutzung: **Workflow in n8n aktivieren**, dann die Production-URL
als `N8N_FIND_RECHNUNG_URL` eintragen:

```
https://n8n-coolify.gollenstede.app/webhook/abrechnung/find-rechnung
```

```
POST { "Rechnungsnummer": "0126/1800TG01" }
→    [ { "file": "<base64>", "filename": "0126_1800TG01_Rechnung.pdf" } ]
```

Soll der Webhook nicht offen erreichbar sein: in n8n Header-Auth aktivieren und
`N8N_WEBHOOK_AUTH_HEADER` / `N8N_WEBHOOK_AUTH_VALUE` setzen.

---

## Bedienung

Alle Buchungen eines Monats sind gleichzeitig sichtbar — kein phasenweises
Bestätigen wie im alten Skill.

| Ampel | Bedeutung |
|---|---|
| grün | Beleg eindeutig zugeordnet |
| gelb | mehrere Treffer, Entscheidung nötig |
| rot | kein Beleg gefunden |
| grau | aus der Abrechnung ausgeblendet |

**Manuelle Korrekturen überleben jeden Neuabruf.** „Aus sevDesk laden" holt die
Buchungen frisch, lässt eingetragene Aktenzeichen, Belegzuordnungen und
Ausblendungen aber unangetastet — sie liegen getrennt in der `overrides`-Tabelle.

### Kontoauszüge

Werden pro Monat hochgeladen und dem Abrechnungs-PDF direkt nach dem Deckblatt
vorangestellt, in der in der UI sichtbaren Reihenfolge.

Anders als im alten Skill werden die Belege **nicht** hinter die jeweilige
Kontoauszugs-*Seite* einsortiert. Diese Zuordnung setzte voraus zu wissen,
welche Buchung auf welcher Seite steht — eine Information, die nur aus dem OCR
des Auszugs stammte und genau dort unzuverlässig war. Stattdessen trägt jede
Belegseite eine Kopfzeile mit der Positionsnummer aus dem Monatsjournal:

```
Pos. 7  |  03.06.2026  |  892,50 EUR  |  0626/1811TG01  |  0626_1811TG01_Rechnung.pdf
```

### Aufbau des Abrechnungs-PDFs

1. Deckblatt mit Summen, Statuszählern und Warnhinweis bei Unvollständigkeit
2. Kontoauszüge
3. Monatsjournal (alle Buchungen mit laufender Nummer)
4. Belege in Buchungsreihenfolge; innerhalb eines Tages erst AUSGANG, dann EINGANG

---

## KI-Funktionen

Optional, Modell `claude-opus-5`. Das Modell entscheidet ausschließlich
Zweifelsfälle — Beträge, Verknüpfungen und Summen kommen aus sevDesk.

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

63 Tests decken die risikoreichen Stellen ab: Aktenzeichen-Normalisierung und
Retry-Kette, die Verknüpfungslogik, den Rechnungsabruf inklusive
Mehrfachtreffer-Auflösung, und den PDF-Zusammenbau gegen echte PDF-Dateien
(inklusive beschädigter Dateien und Sonderzeichen).

---

## Deployment

```bash
docker compose up -d --build
```

`/data` als Volume mounten — dort liegen SQLite-Datenbank, Belegcache und
erzeugte PDFs.

---

## Offene Punkte

**Der Live-Spike gegen die sevDesk-API steht noch aus.** Die Session, in der
dieser Code entstanden ist, hatte keinen Netzwerkzugriff auf `my.sevdesk.de`
(Egress-Policy der Session). Zwei Stellen sind daher gegen die Dokumentation
gebaut und beim ersten Lauf gegen den echten Account zu prüfen — beide sind im
Code mit `SPIKE:` markiert:

| Stelle | Annahme | Absicherung falls falsch |
|---|---|---|
| `GET /CheckAccountTransaction` Datumsfilter | Unix-Sekunden in `startDate`/`endDate` | zusätzlicher clientseitiger Filter — das Ergebnis stimmt in jedem Fall, es werden nur zu viele Datensätze geholt |
| `GET /Invoice/{id}/getCheckAccountTransactions` | existiert analog zu `/Voucher/...` | 404/400 wird abgefangen; die Zuordnung läuft dann über das Aktenzeichen im Verwendungszweck |

Die Verknüpfung `Voucher → Buchungen` ist dokumentiert und damit gesichert.
