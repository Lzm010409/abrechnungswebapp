import type { LadeFortschritt, LadePhase } from '@abrechnung/shared';

/**
 * Zeigt einen laufenden Vorgang als Liste, die sich Schritt fuer Schritt
 * aufbaut.
 *
 * Ein Monat aus sevDesk zu holen oder alle Belege auszulesen dauert deutlich
 * laenger als eine Sekunde. Ein blosses "wird geladen" laesst offen, ob
 * ueberhaupt etwas passiert - hier steht, welcher Schritt gerade laeuft, was
 * er tut und wie weit er ist.
 *
 * Die Reihenfolge ergibt sich aus dem Eintreffen: der Server bestimmt, welche
 * Schritte es gibt. Ein erneuter Stand zum selben Schritt ersetzt den alten,
 * statt eine Zeile anzuhaengen.
 */

/** Ueberschrift, wenn der Schritt keine eigene mitbringt. */
const TITEL: Record<LadePhase, string> = {
  start: 'Verbindung',
  transaktionen: 'Bankbuchungen',
  belege: 'Belege und Ausgangsrechnungen',
  verknuepfung: 'Zuordnung Buchung → Beleg',
  dateien: 'Belegdateien',
  'ki-belege': 'Belege werden gelesen',
  'ki-pruefung': 'Monat wird geprüft',
  fertig: 'Fertig',
};

interface Props {
  /** Letzter Stand je Schritt, in der Reihenfolge des Eintreffens */
  phasen: Map<string, LadeFortschritt>;
  /** true, solange der Vorgang laeuft */
  laeuft: boolean;
}

export function Ladefortschritt({ phasen, laeuft }: Props) {
  const schritte = [...phasen.values()].filter((s) => s.phase !== 'fertig');
  const abgeschlossen = [...phasen.values()].some((s) => s.phase === 'fertig');

  return (
    <ol className="fortschritt" aria-live="polite">
      {schritte.map((stand, i) => {
        // Ein Schritt gilt als erledigt, sobald ein spaeterer gemeldet wurde -
        // der Server arbeitet sie der Reihe nach ab.
        const erledigt = abgeschlossen || i < schritte.length - 1 || istVoll(stand);

        return (
          <li key={stand.schritt ?? stand.phase} className={erledigt ? 'erledigt' : 'aktiv'}>
            <span className="marke" aria-hidden="true">
              {erledigt ? '✓' : '○'}
            </span>
            <span className="titel">{stand.titel ?? TITEL[stand.phase]}</span>
            <span className="text">{stand.text}</span>
            {stand.gesamt !== undefined && stand.gesamt > 0 && (
              <span className="balken">
                <span
                  className="spur"
                  role="progressbar"
                  aria-valuenow={stand.erledigt ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={stand.gesamt}
                >
                  <span className="fuellung" style={{ width: `${anteil(stand)}%` }} />
                </span>
                <em>
                  {stand.erledigt ?? 0}/{stand.gesamt}
                </em>
              </span>
            )}
          </li>
        );
      })}

      {laeuft && schritte.length === 0 && (
        <li className="aktiv">
          <span className="marke" aria-hidden="true">
            ○
          </span>
          <span className="titel">Verbindung wird aufgebaut</span>
        </li>
      )}
    </ol>
  );
}

function anteil(stand: LadeFortschritt): number {
  if (!stand.gesamt) return 0;
  return Math.min(100, Math.round(((stand.erledigt ?? 0) / stand.gesamt) * 100));
}

function istVoll(stand: LadeFortschritt): boolean {
  return stand.gesamt !== undefined && (stand.erledigt ?? 0) >= stand.gesamt;
}
