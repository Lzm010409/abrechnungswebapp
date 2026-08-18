import type { MonatsReview, Position } from '@abrechnung/shared';
import { deutschesDatum, euro } from '../api/client';

/**
 * Befunde der Monatspruefung.
 *
 * Die Verweise auf die betroffenen Buchungen standen frueher als Kette
 * gleichlautender "Buchung anzeigen"-Knoepfe nebeneinander - bei sieben
 * Treffern siebenmal derselbe Text, ohne Trennung und ohne Hinweis, welche
 * Buchung sich dahinter verbirgt. Hier steht stattdessen an jedem Verweis,
 * worum es geht: Datum, Betrag und der Anfang des Verwendungszwecks.
 */

interface Props {
  review: MonatsReview;
  positionen: Position[];
  onWaehle: (positionId: string) => void;
}

const SCHWERE_TEXT = {
  hinweis: 'Hinweis',
  warnung: 'Warnung',
  fehler: 'Fehler',
} as const;

export function Pruefbericht({ review, positionen, onWaehle }: Props) {
  return (
    <section className="review">
      <h4>KI-Prüfung</h4>
      <p>{review.zusammenfassung}</p>

      {review.auffaelligkeiten.length === 0 ? (
        <p className="grau klein">Keine Auffälligkeiten gefunden.</p>
      ) : (
        <ul>
          {review.auffaelligkeiten.map((befund, i) => (
            <li key={i} className={befund.schwere}>
              <div className="befund-kopf">
                <strong>{befund.titel}</strong>
                <span className={`marke schwere ${befund.schwere}`}>
                  {SCHWERE_TEXT[befund.schwere]}
                </span>
              </div>
              <p>{befund.beschreibung}</p>

              {befund.positionIds.length > 0 && (
                <ul className="befund-buchungen">
                  {befund.positionIds.map((id) => (
                    <li key={id}>
                      <button className="verweis" onClick={() => onWaehle(id)}>
                        {beschrifte(positionen, id)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Beschriftung eines Verweises.
 *
 * Kennt die Oberflaeche die Buchung nicht mehr - etwa weil der Monat seit der
 * Pruefung neu geladen wurde -, bleibt die Kennung stehen. Besser eine rohe ID
 * als ein Verweis, der so tut, als wisse er, wohin er fuehrt.
 */
function beschrifte(positionen: Position[], id: string): string {
  const p = positionen.find((x) => x.id === id);
  if (!p) return id;

  const zweck = p.gegenkonto || p.verwendungszweck || '—';
  const gekuerzt = zweck.length > 40 ? `${zweck.slice(0, 40)}…` : zweck;

  return `${deutschesDatum(p.datum)} · ${euro(p.betrag)} · ${gekuerzt}`;
}
