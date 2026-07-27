import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AblageErgebnis,
  Capabilities,
  LadeFortschritt,
  LadePhase,
  Markierung,
  Monat,
  MonatsReview,
} from '@abrechnung/shared';
import {
  aktuellerMonat,
  api,
  ApiFehler,
  euro,
  monatsTitel,
  verschiebeMonat,
} from './api/client';
import { Ablagevorschau } from './components/Ablagevorschau';
import { Anmeldung } from './components/Anmeldung';
import { Detailbereich } from './components/Detailbereich';
import { Kontoauszuege } from './components/Kontoauszuege';
import { Ladefortschritt } from './components/Ladefortschritt';
import { PositionenTabelle } from './components/PositionenTabelle';
import { Sammelaktionen } from './components/Sammelaktionen';

export function App() {
  const [monat, setMonat] = useState(() => verschiebeMonat(aktuellerMonat(), -1));
  const [daten, setDaten] = useState<Monat | null>(null);
  const [faehigkeiten, setFaehigkeiten] = useState<Capabilities>();
  const [ausgewaehlt, setAusgewaehlt] = useState<string>();
  const [review, setReview] = useState<MonatsReview>();
  const [laedt, setLaedt] = useState(false);
  const [phasen, setPhasen] = useState<Map<LadePhase, LadeFortschritt>>(new Map());
  const [ablage, setAblage] = useState<AblageErgebnis>();
  /** Angehakte Zeilen fuer Sammelaktionen */
  const [markiert, setMarkiert] = useState<Set<string>>(new Set());
  const [meldung, setMeldung] = useState<string>();
  const [fehler, setFehler] = useState<string>();
  /** Bricht einen noch laufenden Lade-Stream ab, wenn der Monat wechselt. */
  const abbruch = useRef<AbortController | null>(null);

  useEffect(() => {
    api.capabilities().then(setFaehigkeiten).catch((err) => setFehler(String(err)));
  }, []);

  const laden = useCallback(
    async (neuLaden = false) => {
      abbruch.current?.abort();
      const steuerung = new AbortController();
      abbruch.current = steuerung;

      setLaedt(true);
      setFehler(undefined);
      setPhasen(new Map());

      try {
        await api.stream(monat, { neuLaden, signal: steuerung.signal }, (ereignis) => {
          switch (ereignis.art) {
            case 'fortschritt':
              setPhasen((alt) => {
                const neu = new Map(alt);
                neu.set(ereignis.fortschritt.phase, ereignis.fortschritt);
                return neu;
              });
              break;
            // Zwischenstand: die Buchungen stehen schon, die Belege noch nicht.
            // Die Tabelle wird damit sofort sichtbar.
            case 'teil':
            case 'fertig':
              setDaten(ereignis.monat);
              break;
            case 'fehler':
              setFehler(ereignis.fehler);
              break;
          }
        });
      } catch (err) {
        if (steuerung.signal.aborted) return;

        // Sitzung abgelaufen: die Faehigkeiten neu holen, damit die Anwendung
        // die Anmeldeseite zeigt statt einer nichtssagenden Fehlermeldung.
        if (err instanceof ApiFehler && err.status === 401) {
          setFaehigkeiten(await api.capabilities().catch(() => undefined));
          return;
        }

        // Kein Strom moeglich (puffernder Reverse-Proxy)? Dann eben klassisch -
        // die Anwendung darf daran nicht scheitern.
        try {
          setDaten(await api.monat(monat, neuLaden));
        } catch (zweiter) {
          setFehler(zweiter instanceof Error ? zweiter.message : String(zweiter));
        }
      } finally {
        if (!steuerung.signal.aborted) setLaedt(false);
      }
    },
    [monat],
  );

  useEffect(() => {
    setAusgewaehlt(undefined);
    setReview(undefined);
    setAblage(undefined);
    setMarkiert(new Set());
    setDaten(null);
    void laden();
    return () => abbruch.current?.abort();
  }, [laden]);

  const mitLadeanzeige = async (arbeit: () => Promise<void>) => {
    setLaedt(true);
    setFehler(undefined);
    setMeldung(undefined);
    try {
      await arbeit();
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setLaedt(false);
    }
  };

  const position = daten?.positionen.find((p) => p.id === ausgewaehlt);
  const s = daten?.summen;

  // Solange die Faehigkeiten nicht da sind, ist unklar, ob eine Anmeldung
  // noetig ist - dann waere jede Anzeige geraten.
  if (faehigkeiten && faehigkeiten.anmeldungNoetig && !faehigkeiten.angemeldet) {
    return <Anmeldung />;
  }

  return (
    <div className="app">
      <header className="kopf">
        <div className="monatswahl">
          <button onClick={() => setMonat(verschiebeMonat(monat, -1))} title="Vorheriger Monat">
            ◀
          </button>
          <h1>{monatsTitel(monat)}</h1>
          <button onClick={() => setMonat(verschiebeMonat(monat, 1))} title="Nächster Monat">
            ▶
          </button>
        </div>

        {s && (
          <div className="summen">
            <span className="positiv">{euro(s.einnahmen)}</span>
            <span className="negativ">−{euro(s.ausgaben)}</span>
            <span className="saldo">{euro(s.saldo)}</span>
            <span className="zaehler">
              <span className="ampel ok" title="Beleg zugeordnet">●</span> {s.anzahlOk}
              <span className="ampel mehrdeutig" title="Entscheidung nötig">●</span>{' '}
              {s.anzahlMehrdeutig}
              <span className="ampel offen" title="Kein Beleg">●</span> {s.anzahlOffen}
            </span>
          </div>
        )}

        {faehigkeiten && (
          <div className="konto grau klein">
            {faehigkeiten.checkAccountName ?? faehigkeiten.checkAccountId}
            {!faehigkeiten.n8nRechnungsabruf && ' · OneDrive-Abruf inaktiv'}
            {!faehigkeiten.ki && ' · KI inaktiv'}
            {faehigkeiten.benutzer && (
              <>
                {' · '}
                {faehigkeiten.benutzer.name}
                {faehigkeiten.anmeldungNoetig && (
                  <button
                    className="verweis"
                    onClick={() =>
                      void api.abmelden().then(() => window.location.reload())
                    }
                  >
                    abmelden
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </header>

      {/*
        Der wichtigste Hinweis des Monats: sind Buchungen in sevDesk noch nicht
        zugeordnet, gehoert die Korrektur dorthin und nicht hierher. Ohne diesen
        Hinweis sucht man den Fehler an der falschen Stelle.
      */}
      {s && s.anzahlNichtZugeordnet > 0 && (
        <div className="banner warnung">
          {s.anzahlNichtZugeordnet} Buchung
          {s.anzahlNichtZugeordnet === 1 ? '' : 'en'} in sevDesk noch nicht zugeordnet.
          Dort verbuchen, dann hier neu laden.
          <button className="inline" disabled={laedt} onClick={() => void laden(true)}>
            Jetzt neu laden
          </button>
        </div>
      )}

      {fehler && (
        <div className="banner fehler">
          {fehler}
          <button onClick={() => setFehler(undefined)}>×</button>
        </div>
      )}
      {meldung && (
        <div className="banner info">
          {meldung}
          <button onClick={() => setMeldung(undefined)}>×</button>
        </div>
      )}

      {markiert.size > 0 && (
        <Sammelaktionen
          anzahl={markiert.size}
          laedt={laedt}
          onAufheben={() => setMarkiert(new Set())}
          onMarkieren={(markierung) =>
            mitLadeanzeige(async () => {
              setDaten(await api.patcheMehrere(monat, [...markiert], { markierung }));
              setMarkiert(new Set());
            })
          }
          onAusblenden={() =>
            mitLadeanzeige(async () => {
              setDaten(
                await api.patcheMehrere(monat, [...markiert], { status: 'ignoriert' }),
              );
              setMarkiert(new Set());
            })
          }
        />
      )}

      <main>
        <div className="liste">
          {laedt && <Ladefortschritt phasen={phasen} laeuft={laedt} />}
          {daten && (
            <PositionenTabelle
              positionen={daten.positionen}
              ausgewaehlt={ausgewaehlt}
              onAuswahl={setAusgewaehlt}
              markiert={markiert}
              onMarkierungAendern={setMarkiert}
            />
          )}

          {daten && (
            <Kontoauszuege
              monat={monat}
              auszuege={daten.kontoauszuege}
              onAenderung={(neu) => (neu ? setDaten(neu) : void laden())}
              onFehler={setFehler}
            />
          )}

          {ablage && (
            <Ablagevorschau
              ergebnis={ablage}
              laedt={laedt}
              onSchliessen={() => setAblage(undefined)}
              onAusfuehren={
                faehigkeiten?.onedriveAblage
                  ? () =>
                      mitLadeanzeige(async () => {
                        setAblage(await api.ablage(monat, true));
                      })
                  : undefined
              }
            />
          )}

          {review && (
            <section className="review">
              <h4>KI-Prüfung</h4>
              <p>{review.zusammenfassung}</p>
              {review.auffaelligkeiten.length === 0 ? (
                <p className="grau klein">Keine Auffälligkeiten gefunden.</p>
              ) : (
                <ul>
                  {review.auffaelligkeiten.map((b, i) => (
                    <li key={i} className={b.schwere}>
                      <strong>{b.titel}</strong>
                      <p>{b.beschreibung}</p>
                      {b.positionIds.length > 0 && (
                        <p className="klein">
                          {b.positionIds.map((id) => (
                            <button key={id} className="verweis" onClick={() => setAusgewaehlt(id)}>
                              Buchung anzeigen
                            </button>
                          ))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <Detailbereich
          monat={monat}
          position={position}
          faehigkeiten={faehigkeiten}
          onAenderung={(neu) => (neu ? setDaten(neu) : void laden())}
          onFehler={setFehler}
        />
      </main>

      <footer className="aktionsleiste">
        <button
          disabled={laedt}
          onClick={() =>
            void laden(true).then(() =>
              setMeldung(
                'Monat aus sevDesk neu geladen. Manuelle Korrekturen blieben erhalten.',
              ),
            )
          }
        >
          Aus sevDesk laden
        </button>

        {faehigkeiten?.ki && (
          <>
            <button
              className="ki"
              disabled={laedt || !daten}
              onClick={() =>
                mitLadeanzeige(async () => {
                  const { neuAnalysiert, monat: neu } = await api.ki.extrahiere(monat);
                  setDaten(neu);
                  setMeldung(`${neuAnalysiert} Beleg(e) neu ausgelesen.`);
                })
              }
            >
              Belege auslesen
            </button>

            <button
              className="ki"
              disabled={laedt || !daten}
              onClick={() =>
                mitLadeanzeige(async () => {
                  setReview(await api.ki.pruefe(monat));
                })
              }
            >
              Monat prüfen
            </button>
          </>
        )}

        <span className="fueller" />

        <button
          className="primaer"
          disabled={laedt || !daten}
          onClick={() =>
            mitLadeanzeige(async () => {
              const blob = await api.erzeugeBericht(monat);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `Abrechnung_${monat}.pdf`;
              a.click();
              URL.revokeObjectURL(url);

              // Die Einteilung steht erst jetzt fest - sie haengt daran, welche
              // Buchung sich auf einer Kontoauszugsseite wiederfindet.
              setAblage(await api.ablage(monat));
            })
          }
        >
          Abrechnungs-PDF erzeugen
        </button>
      </footer>
    </div>
  );
}
