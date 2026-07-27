import type { LadeFortschritt, LadePhase } from '@abrechnung/shared';

/**
 * Zeigt den Ladevorgang als Liste, die sich aufbaut.
 *
 * Ein Monat aus sevDesk zu holen dauert bei vielen Buchungen deutlich laenger
 * als eine Sekunde. Ein blosses "wird geladen" laesst offen, ob ueberhaupt
 * etwas passiert - hier sieht man, welcher Schritt gerade laeuft und wie weit
 * er ist.
 */

const REIHENFOLGE: LadePhase[] = [
  'start',
  'transaktionen',
  'belege',
  'verknuepfung',
  'dateien',
  'ki-belege',
  'ki-pruefung',
  'fertig',
];

const TITEL: Record<LadePhase, string> = {
  start: 'Verbindung zu sevDesk',
  transaktionen: 'Bankbuchungen',
  belege: 'Belege und Ausgangsrechnungen',
  verknuepfung: 'Zuordnung Buchung → Beleg',
  dateien: 'Belegdateien',
  'ki-belege': 'Belege werden gelesen',
  'ki-pruefung': 'Monat wird geprüft',
  fertig: 'Fertig',
};

interface Props {
  /** Letzter Stand je Phase, in der Reihenfolge des Eintreffens */
  phasen: Map<LadePhase, LadeFortschritt>;
  /** true, solange der Stream laeuft */
  laeuft: boolean;
}

export function Ladefortschritt({ phasen, laeuft }: Props) {
  const sichtbar = REIHENFOLGE.filter((p) => p !== 'fertig' && phasen.has(p));
  const abgeschlossen = phasen.has('fertig');

  return (
    <ol className="fortschritt" aria-live="polite">
      {sichtbar.map((phase, i) => {
        const stand = phasen.get(phase)!;
        const spaeter = sichtbar[i + 1] !== undefined;
        const erledigt = abgeschlossen || spaeter || istVoll(stand);

        return (
          <li key={phase} className={erledigt ? 'erledigt' : 'aktiv'}>
            <span className="marke" aria-hidden="true">
              {erledigt ? '✓' : '○'}
            </span>
            <span className="titel">{TITEL[phase]}</span>
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

      {laeuft && sichtbar.length === 0 && (
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
