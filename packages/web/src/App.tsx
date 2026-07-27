import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AblageErgebnis,
  Capabilities,
  LadeFortschritt,
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
import { Vorgangsanzeige } from './components/Vorgangsanzeige';

export function App() {
  const [monat, setMonat] = useState(() => verschiebeMonat(aktuellerMonat(), -1));
  const [daten, setDaten] = useState<Monat | null>(null);
  const [faehigkeiten, setFaehigkeiten] = useState<Capabilities>();
  const [ausgewaehlt, setAusgewaehlt] = useState<string>();
  const [review, setReview] = useState<MonatsReview>();
  const [laedt, setLaedt] = useState(false);
  const [phasen, setPhasen] = useState<Map<string, LadeFortschritt>>(new Map());
  const [ablage, setAblage] = useState<AblageErgebnis>();
  /** Angehakte Zeilen fuer Sammelaktionen */
  const [markiert, setMarkiert] = useState<Set<string>>(new Set());
  /** Laufender KI-Vorgang samt Fortschritt - undefined heisst: nichts laeuft */
  const [vorgang, setVorgang] = useState<{
    titel: string;
    hinweis?: string;
    phasen: Map<string, LadeFortschritt>;
  }>();
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
                neu.set(
                  ereignis.fortschritt.schritt ?? ereignis.fortschritt.phase,
                  ereignis.fortschritt,
                );
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

  /**
   * Fuehrt einen laenger laufenden Vorgang aus und zeigt dabei, woran gerade
   * gearbeitet wird. Ohne diese Anzeige sieht die Oberflaeche waehrend eines
   * KI-Laufs aus, als sei sie stehengeblieben.
   */
  const mitVorgang = async <T,>(
    titel: string,
    hinweis: string,
    arbeit: (melde: (f: LadeFortschritt) => void) => Promise<T>,
    danach: (ergebnis: T) => void,
  ) => {
    setVorgang({ titel, hinweis, phasen: new Map() });
    setFehler(undefined);
    setMeldung(undefined);
    try {
      const ergebnis = await arbeit((fortschritt) =>
        setVorgang((alt) => {
          const phasen = new Map(alt?.phasen);
          phasen.set(fortschritt.schritt ?? fortschritt.phase, fortschritt);
          return { titel, hinweis, phasen };
        }),
      );
      danach(ergebnis);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setVorgang(undefined);
    }
  };

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
          onOrdner={(ablageordner) =>
            mitLadeanzeige(async () => {
              setDaten(await api.patcheMehrere(monat, [...markiert], { ablageordner }));
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

      {vorgang && (
        <Vorgangsanzeige
          titel={vorgang.titel}
          phasen={vorgang.phasen}
          hinweis={vorgang.hinweis}
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
                  ? () => {
                      // Das Ergebnis des vorigen Versuchs wegraeumen: sonst
                      // stuende dessen Hinweis noch minutenlang da, waehrend
                      // der neue Lauf schon unterwegs ist.
                      setAblage(undefined);
                      return mitVorgang(
                        'Belege werden abgelegt',
                        'Jede Datei geht einzeln nach OneDrive, mit einer kurzen ' +
                          'Pause dazwischen — das schont den n8n-Server.',
                        (melde) => api.ablageMitFortschritt(monat, true, melde),
                        setAblage,
                      );
                    }
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
              disabled={laedt || Boolean(vorgang) || !daten}
              onClick={() =>
                mitVorgang(
                  'Belege werden ausgelesen',
                  'Jeder Beleg geht einmal an das Modell. Schon gelesene Belege ' +
                    'sind zwischengespeichert und kosten nichts.',
                  (melde) => api.ki.extrahiere(monat, melde),
                  ({ neuAnalysiert, monat: neu }) => {
                    setDaten(neu);
                    setMeldung(
                      neuAnalysiert === 0
                        ? 'Alle Belege waren bereits ausgelesen.'
                        : `${neuAnalysiert} Beleg(e) neu ausgelesen.`,
                    );
                  },
                )
              }
            >
              Belege auslesen
            </button>

            <button
              className="ki"
              disabled={laedt || Boolean(vorgang) || !daten}
              onClick={() =>
                mitVorgang(
                  'Der Monat wird geprüft',
                  'Ein einzelner Durchgang über alle Buchungen – das dauert ' +
                    'meist unter einer Minute.',
                  (melde) => api.ki.pruefe(monat, melde),
                  setReview,
                )
              }
            >
              Monat prüfen
            </button>
          </>
        )}

        <span className="fueller" />

        <button
          className="primaer"
          disabled={laedt || Boolean(vorgang) || !daten}
          onClick={() =>
            mitVorgang(
              'Abrechnung wird zusammengestellt',
              'Deckblatt, Journal, Kontoauszüge und alle Belegseiten werden zu ' +
                'einem PDF verbunden.',
              async (melde) => {
                /*
                 * Der Bau laeuft in einer Anfrage - Fortschritt von innen gibt
                 * es nicht. Gemeldet werden deshalb die beiden Abschnitte, die
                 * der Browser selbst kennt. Besser als ein Knopf, bei dem
                 * scheinbar nichts passiert.
                 */
                melde({
                  phase: 'dateien',
                  schritt: 'pdf',
                  titel: 'PDF wird gebaut',
                  text: 'Belege werden hinter die Auszugsseiten einsortiert',
                });

                const blob = await api.erzeugeBericht(monat);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Abrechnung_${monat}.pdf`;
                a.click();
                URL.revokeObjectURL(url);

                melde({
                  phase: 'dateien',
                  schritt: 'pdf',
                  titel: 'PDF wird gebaut',
                  text: 'heruntergeladen',
                  erledigt: 1,
                  gesamt: 1,
                });
                // Die Einteilung steht erst jetzt fest - sie haengt daran, welche
                // Buchung sich auf einer Kontoauszugsseite wiederfindet. Sie
                // meldet ihren Stand selbst.
                return api.ablageMitFortschritt(monat, false, melde);
              },
              setAblage,
            )
          }
        >
          Abrechnungs-PDF erzeugen
        </button>
      </footer>
    </div>
  );
}
