import type { LadeFortschritt } from '@abrechnung/shared';
import { Ladefortschritt } from './Ladefortschritt';

/**
 * Overlay fuer einen laufenden Vorgang.
 *
 * Bewusst ueber allem statt als Abschnitt in der Liste: die ausloesenden Knoepfe
 * sitzen am unteren Rand, eine Anzeige oberhalb der Tabelle bekommt man beim
 * Klicken gar nicht zu sehen. Das Overlay sperrt zugleich die Bedienung -
 * waehrend die Belege gelesen werden, aendert man besser nichts daran.
 */

interface Props {
  titel: string;
  phasen: Map<string, LadeFortschritt>;
  /** Zusatz unter dem Fortschritt, etwa zur erwarteten Dauer. */
  hinweis?: string;
}

export function Vorgangsanzeige({ titel, phasen, hinweis }: Props) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={titel}>
      <div className="overlay-karte">
        <h3>
          <span className="spinner" aria-hidden="true" />
          {titel}
        </h3>

        <Ladefortschritt phasen={phasen} laeuft />

        {hinweis && <p className="grau klein">{hinweis}</p>}
      </div>
    </div>
  );
}
