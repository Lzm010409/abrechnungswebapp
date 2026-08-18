import type { Vorgang } from '@abrechnung/shared';

/**
 * Zeigt, was gerade im Hintergrund laeuft.
 *
 * Bewusst keine Sperrschicht ueber der Oberflaeche: Belege auslesen und Monat
 * pruefen dauern Minuten, und in dieser Zeit soll weitergearbeitet werden
 * koennen. Der Server fuehrt den Vorgang ohnehin zu Ende, auch wenn niemand
 * zusieht - die Leiste sagt nur, dass es laeuft und woran.
 */

interface Props {
  vorgaenge: Vorgang[];
}

export function Vorgangsleiste({ vorgaenge }: Props) {
  if (vorgaenge.length === 0) return null;

  return (
    <div className="vorgangsleiste" role="status" aria-live="polite">
      {vorgaenge.map((v) => (
        <div key={v.id} className="vorgangszeile">
          <span className="spinner" aria-hidden="true" />
          <strong>{v.titel}</strong>
          <span className="grau klein">{beschreibe(v)}</span>
        </div>
      ))}
      <span className="grau klein hinweis-leiste">
        läuft im Hintergrund weiter – auch wenn Sie den Monat wechseln
      </span>
    </div>
  );
}

/** Der zuletzt gemeldete Schritt, mit Zaehler wenn es einen gibt. */
function beschreibe(vorgang: Vorgang): string {
  const letzter = vorgang.fortschritt.at(-1);
  if (!letzter) return 'wird gestartet …';

  const zaehler =
    letzter.gesamt !== undefined && letzter.erledigt !== undefined
      ? ` (${letzter.erledigt}/${letzter.gesamt})`
      : '';

  return `${letzter.titel ?? letzter.phase}: ${letzter.text}${zaehler}`;
}
