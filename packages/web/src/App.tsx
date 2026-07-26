import { useCallback, useEffect, useState } from 'react';
import type { Capabilities, Monat, MonatsReview } from '@abrechnung/shared';
import {
  aktuellerMonat,
  api,
  euro,
  monatsTitel,
  verschiebeMonat,
} from './api/client';
import { Detailbereich } from './components/Detailbereich';
import { Kontoauszuege } from './components/Kontoauszuege';
import { PositionenTabelle } from './components/PositionenTabelle';

export function App() {
  const [monat, setMonat] = useState(() => verschiebeMonat(aktuellerMonat(), -1));
  const [daten, setDaten] = useState<Monat | null>(null);
  const [faehigkeiten, setFaehigkeiten] = useState<Capabilities>();
  const [ausgewaehlt, setAusgewaehlt] = useState<string>();
  const [review, setReview] = useState<MonatsReview>();
  const [laedt, setLaedt] = useState(false);
  const [meldung, setMeldung] = useState<string>();
  const [fehler, setFehler] = useState<string>();

  useEffect(() => {
    api.capabilities().then(setFaehigkeiten).catch((err) => setFehler(String(err)));
  }, []);

  const laden = useCallback(
    async (neuLaden = false) => {
      setLaedt(true);
      setFehler(undefined);
      try {
        setDaten(await api.monat(monat, neuLaden));
      } catch (err) {
        setFehler(err instanceof Error ? err.message : String(err));
      } finally {
        setLaedt(false);
      }
    },
    [monat],
  );

  useEffect(() => {
    setAusgewaehlt(undefined);
    setReview(undefined);
    void laden();
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
          <button
            className="inline"
            disabled={laedt}
            onClick={() =>
              mitLadeanzeige(async () => {
                setDaten(await api.synchronisiere(monat));
              })
            }
          >
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

      <main>
        <div className="liste">
          {laedt && !daten && <p className="leer">Lade Monat…</p>}
          {daten && (
            <PositionenTabelle
              positionen={daten.positionen}
              ausgewaehlt={ausgewaehlt}
              onAuswahl={setAusgewaehlt}
            />
          )}

          {daten && (
            <Kontoauszuege
              monat={monat}
              auszuege={daten.kontoauszuege}
              onAenderung={() => void laden()}
              onFehler={setFehler}
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
          onAenderung={() => void laden()}
          onFehler={setFehler}
        />
      </main>

      <footer className="aktionsleiste">
        <button
          disabled={laedt}
          onClick={() =>
            mitLadeanzeige(async () => {
              setDaten(await api.synchronisiere(monat));
              setMeldung('Monat aus sevDesk neu geladen. Manuelle Korrekturen blieben erhalten.');
            })
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
            })
          }
        >
          Abrechnungs-PDF erzeugen
        </button>
      </footer>
    </div>
  );
}
