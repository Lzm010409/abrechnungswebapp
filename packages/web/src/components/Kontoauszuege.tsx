import { useRef, useState } from 'react';
import type { Kontoauszug } from '@abrechnung/shared';
import { api } from '../api/client';

interface Props {
  monat: string;
  auszuege: Kontoauszug[];
  onAenderung: () => void;
  onFehler: (meldung: string) => void;
}

/**
 * Kontoauszuege werden dem Abrechnungs-PDF direkt nach dem Deckblatt
 * vorangestellt - in genau der hier sichtbaren Reihenfolge.
 */
export function Kontoauszuege({ monat, auszuege, onAenderung, onFehler }: Props) {
  const [laedt, setLaedt] = useState(false);
  const feld = useRef<HTMLInputElement>(null);

  const hochladen = async (dateien: FileList) => {
    setLaedt(true);
    try {
      // Nacheinander, damit die Reihenfolge der Auswahl erhalten bleibt.
      for (const datei of Array.from(dateien)) {
        await api.ladeKontoauszugHoch(monat, datei);
      }
      if (feld.current) feld.current.value = '';
      onAenderung();
    } catch (err) {
      onFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setLaedt(false);
    }
  };

  return (
    <section className="kontoauszuege">
      <h4>
        Kontoauszüge <span className="grau klein">({auszuege.length})</span>
      </h4>

      {auszuege.length > 0 && (
        <ul>
          {auszuege.map((a, i) => (
            <li key={a.id}>
              <span className="nummer">{i + 1}.</span>
              <a href={api.dateiUrl(monat, a.id)} target="_blank" rel="noreferrer">
                {a.dateiname}
              </a>
              <span className="grau klein">
                {a.seiten ? `${a.seiten} S.` : ''}
              </span>
              <button
                className="loeschen"
                title="Entfernen"
                disabled={laedt}
                onClick={async () => {
                  setLaedt(true);
                  try {
                    await api.loescheKontoauszug(monat, a.id);
                    onAenderung();
                  } catch (err) {
                    onFehler(err instanceof Error ? err.message : String(err));
                  } finally {
                    setLaedt(false);
                  }
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={feld}
        type="file"
        accept="application/pdf,image/*"
        multiple
        disabled={laedt}
        onChange={(e) => {
          if (e.target.files?.length) void hochladen(e.target.files);
        }}
      />
      <p className="klein grau">
        Werden dem Abrechnungs-PDF nach dem Deckblatt in dieser Reihenfolge
        vorangestellt.
      </p>
    </section>
  );
}
