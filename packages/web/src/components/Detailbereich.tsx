import { useRef, useState } from 'react';
import type { Capabilities, Position } from '@abrechnung/shared';
import { api, deutschesDatum, euro } from '../api/client';

interface Props {
  monat: string;
  position?: Position;
  faehigkeiten?: Capabilities;
  onAenderung: () => void;
  onFehler: (meldung: string) => void;
}

/**
 * Rechte Spalte: Belegvorschau und alle Korrekturmoeglichkeiten zur
 * ausgewaehlten Buchung.
 */
export function Detailbereich({
  monat,
  position,
  faehigkeiten,
  onAenderung,
  onFehler,
}: Props) {
  const [azEingabe, setAzEingabe] = useState('');
  const [kiKandidaten, setKiKandidaten] = useState<string[]>([]);
  const [laedt, setLaedt] = useState(false);
  const dateiFeld = useRef<HTMLInputElement>(null);

  if (!position) {
    return (
      <aside className="detail leer">
        <p>Eine Buchung auswählen, um den Beleg zu sehen.</p>
      </aside>
    );
  }

  const aktiveDatei = position.dateien[0];

  const fuehreAus = async (arbeit: () => Promise<unknown>) => {
    setLaedt(true);
    try {
      await arbeit();
      onAenderung();
    } catch (err) {
      onFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setLaedt(false);
    }
  };

  const setzeAktenzeichen = (wert: string) =>
    fuehreAus(async () => {
      await api.patchePosition(monat, position.id, { aktenzeichen: wert });
      setAzEingabe('');
      setKiKandidaten([]);
    });

  return (
    <aside className="detail">
      <header className="detail-kopf">
        <div>
          <strong>{euro(position.betrag)}</strong>
          <span className="grau"> · {deutschesDatum(position.datum)}</span>
        </div>
        <div className="grau klein">{position.verwendungszweck || '—'}</div>
      </header>

      {position.hinweis && <div className="hinweis">{position.hinweis}</div>}

      {/* -- Belegvorschau -- */}
      <div className="vorschau">
        {aktiveDatei ? (
          aktiveDatei.mimeType.includes('pdf') ? (
            <iframe
              title={aktiveDatei.dateiname}
              src={api.dateiUrl(monat, aktiveDatei.id)}
              className="pdf"
            />
          ) : (
            <img src={api.dateiUrl(monat, aktiveDatei.id)} alt={aktiveDatei.dateiname} />
          )
        ) : (
          <div className="kein-beleg">Kein Beleg hinterlegt</div>
        )}
      </div>

      {/* -- Kandidatenauswahl bei mehreren Treffern -- */}
      {(position.kandidaten?.length ?? 0) > 0 && (
        <section>
          <h4>Weitere gefundene Dateien</h4>
          <p className="klein grau">
            Der OneDrive-Abruf hat mehrere passende Dateien geliefert. Die richtige
            auswählen:
          </p>
          <ul className="kandidaten">
            {[...position.dateien, ...(position.kandidaten ?? [])].map((d) => (
              <li key={d.id}>
                <label>
                  <input
                    type="radio"
                    name="beleg"
                    checked={position.dateien.some((x) => x.id === d.id)}
                    onChange={() =>
                      fuehreAus(() =>
                        api.patchePosition(monat, position.id, { dateiIds: [d.id] }),
                      )
                    }
                  />
                  <span>{d.dateiname}</span>
                </label>
                <a href={api.dateiUrl(monat, d.id)} target="_blank" rel="noreferrer">
                  öffnen
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* -- Aktenzeichen -- */}
      <section>
        <h4>Aktenzeichen</h4>
        <div className="az-zeile">
          <input
            value={azEingabe}
            placeholder={position.aktenzeichen?.normalisiert ?? '0126/1800TG01'}
            onChange={(e) => setAzEingabe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && azEingabe.trim()) setzeAktenzeichen(azEingabe.trim());
            }}
          />
          <button
            disabled={!azEingabe.trim() || laedt}
            onClick={() => setzeAktenzeichen(azEingabe.trim())}
          >
            Setzen
          </button>
        </div>

        {faehigkeiten?.ki && (
          <button
            className="ki"
            disabled={laedt}
            onClick={() =>
              fuehreAus(async () => {
                const { kandidaten } = await api.ki.schlageAktenzeichenVor(monat, position.id);
                setKiKandidaten(kandidaten);
                if (kandidaten.length === 0) onFehler('Die KI fand keinen plausiblen Kandidaten.');
              })
            }
          >
            Aktenzeichen von der KI vorschlagen lassen
          </button>
        )}

        {kiKandidaten.length > 0 && (
          <ul className="kandidaten">
            {kiKandidaten.map((k) => (
              <li key={k}>
                <code>{k}</code>
                <button onClick={() => setzeAktenzeichen(k)}>übernehmen</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* -- Beleg nachreichen -- */}
      <section>
        <h4>Beleg nachreichen</h4>
        <input
          ref={dateiFeld}
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => {
            const datei = e.target.files?.[0];
            if (!datei) return;
            void fuehreAus(async () => {
              await api.ladeBelegHoch(monat, position.id, datei);
              if (dateiFeld.current) dateiFeld.current.value = '';
            });
          }}
        />
      </section>

      {/* -- Status -- */}
      <section className="aktionen">
        <button
          disabled={laedt}
          onClick={() =>
            fuehreAus(() =>
              api.patchePosition(monat, position.id, {
                status: position.status === 'ignoriert' ? 'offen' : 'ignoriert',
              }),
            )
          }
        >
          {position.status === 'ignoriert' ? 'Wieder einblenden' : 'Aus Abrechnung ausblenden'}
        </button>

        {position.manuellBestaetigt && (
          <button
            className="sekundaer"
            disabled={laedt}
            onClick={() => fuehreAus(() => api.setzeZurueck(monat, position.id))}
          >
            Manuelle Änderungen verwerfen
          </button>
        )}
      </section>

      {position.extraktion && (
        <section>
          <h4>Aus dem Beleg gelesen</h4>
          <dl className="extraktion">
            {position.extraktion.aussteller && (
              <>
                <dt>Aussteller</dt>
                <dd>{position.extraktion.aussteller}</dd>
              </>
            )}
            {position.extraktion.betrag !== undefined && (
              <>
                <dt>Betrag</dt>
                <dd
                  className={
                    Math.abs(position.extraktion.betrag - Math.abs(position.betrag)) > 0.01
                      ? 'abweichung'
                      : ''
                  }
                >
                  {euro(position.extraktion.betrag)}
                </dd>
              </>
            )}
            {position.extraktion.belegdatum && (
              <>
                <dt>Belegdatum</dt>
                <dd>{deutschesDatum(position.extraktion.belegdatum)}</dd>
              </>
            )}
            {position.extraktion.ustBetrag !== undefined && (
              <>
                <dt>USt</dt>
                <dd>{euro(position.extraktion.ustBetrag)}</dd>
              </>
            )}
            {position.extraktion.kategorie && (
              <>
                <dt>Kategorie</dt>
                <dd>{position.extraktion.kategorie}</dd>
              </>
            )}
          </dl>
        </section>
      )}
    </aside>
  );
}
