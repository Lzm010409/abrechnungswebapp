import { ABLAGEORDNER, type Ablageordner, type Markierung } from '@abrechnung/shared';

/**
 * Leiste fuer die angehakten Buchungen.
 *
 * Wiederkehrende Posten - Miete, Leasing, Abos, Umbuchungen - einzeln zu
 * markieren waere bei einem vollen Monat viel Klickarbeit. Hier gilt eine
 * Entscheidung fuer alle angehakten Zeilen auf einmal.
 */

const MARKIERUNGEN: Array<[Markierung, string]> = [
  ['privatentnahme', 'Privatentnahme'],
  ['dauerbeleg', 'Dauerbeleg'],
  ['umbuchung', 'Umbuchung'],
];

interface Props {
  anzahl: number;
  laedt: boolean;
  onMarkieren: (markierung: Markierung | null) => void;
  onOrdner: (ordner: Ablageordner | null) => void;
  onAusblenden: () => void;
  onAufheben: () => void;
}

export function Sammelaktionen({
  anzahl,
  laedt,
  onMarkieren,
  onOrdner,
  onAusblenden,
  onAufheben,
}: Props) {
  return (
    <div className="sammelaktionen">
      <strong>
        {anzahl} Buchung{anzahl === 1 ? '' : 'en'} ausgewählt
      </strong>

      <span className="grau klein">als belegfrei markieren:</span>
      {MARKIERUNGEN.map(([wert, text]) => (
        <button key={wert} disabled={laedt} onClick={() => onMarkieren(wert)}>
          {text}
        </button>
      ))}

      <button disabled={laedt} onClick={() => onMarkieren(null)}>
        Markierung entfernen
      </button>

      <span className="trenner" />

      <span className="grau klein">Belege ablegen nach:</span>
      {ABLAGEORDNER.map((ordner) => (
        <button key={ordner} disabled={laedt} onClick={() => onOrdner(ordner)}>
          {ordner}
        </button>
      ))}

      <button disabled={laedt} onClick={() => onOrdner(null)}>
        wieder automatisch
      </button>

      <span className="trenner" />

      <button disabled={laedt} onClick={onAusblenden}>
        Aus Abrechnung ausblenden
      </button>

      <button className="verweis" onClick={onAufheben}>
        Auswahl aufheben
      </button>
    </div>
  );
}
