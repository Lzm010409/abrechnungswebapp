import type { Position } from '@abrechnung/shared';

/**
 * Einteilung der Belege auf die Monatsordner in OneDrive.
 *
 * Die Regel stammt aus der bisherigen Handablage:
 *   Konto   - alles, was sich einer Kontoauszugsseite zuordnen liess
 *   Tanken  - von den uebrigen die Tankbelege
 *   Bar     - der ganze Rest
 *
 * Die Reihenfolge ist Absicht und nicht beliebig: eine mit Karte bezahlte
 * Tankfuellung steht auf dem Kontoauszug und gehoert damit nach Konto, nicht
 * nach Tanken. Tanken meint die bar bezahlten Tankbelege.
 */

export type Ablageordner = 'Konto' | 'Bar' | 'Tanken';

/**
 * Bekannte Tankstellenmarken und Ladeanbieter.
 *
 * Bewusst eine Liste statt einer Heuristik auf dem Betrag: eine Zahlung ueber
 * 60 Euro ist kein Beleg dafuer, dass getankt wurde. Was hier fehlt, landet in
 * Bar - das ist die harmlosere Richtung, weil Bar ohnehin der Sammelordner ist.
 */
const MARKEN = [
  'aral', 'shell', 'esso', 'total', 'totalenergies', 'agip', 'eni', 'omv',
  'jet ', 'star tank', 'avia', 'hem ', 'sprint tank', 'westfalen', 'orlen',
  'q1 tank', 'bft', 'raiffeisen tank', 'supol', 'elan tank', 'pinoil',
  'classic tank', 'team tank', 'roth energie',
  // Strom zaehlt hier genauso - fuer die Ablage macht es keinen Unterschied.
  'ionity', 'enbw mobility', 'ewe go', 'allego', 'shell recharge',
];

/** Woerter, die den Zweck unabhaengig von der Marke eindeutig machen. */
const BEGRIFFE = [
  'tankstelle', 'tankquittung', 'kraftstoff', 'treibstoff', 'diesel',
  'super e10', 'super e5', 'benzin', 'autohof', 'ladesaeule', 'ladesäule',
  'ladevorgang',
];

/**
 * Erkennt einen Tankbeleg an Verwendungszweck, Gegenkonto und - sofern die KI
 * aktiv war - am ausgelesenen Aussteller.
 */
export function istTankbeleg(position: Position): boolean {
  const felder = [
    position.verwendungszweck,
    position.gegenkonto,
    position.extraktion?.aussteller,
    position.extraktion?.kategorie,
    ...position.dateien.map((d) => d.dateiname),
  ];

  const text = felder.filter(Boolean).join(' ').toLowerCase();
  if (text.length === 0) return false;

  return (
    MARKEN.some((marke) => text.includes(marke)) ||
    BEGRIFFE.some((begriff) => text.includes(begriff))
  );
}

/**
 * Bestimmt den Zielordner.
 *
 * `aufAuszug` sagt, ob die Buchung auf einer Seite des Kontoauszugs gefunden
 * wurde - dieselbe Zuordnung, aus der auch die Reihenfolge im Abrechnungs-PDF
 * entsteht.
 */
export function bestimmeOrdner(position: Position, aufAuszug: boolean): Ablageordner {
  if (aufAuszug) return 'Konto';
  return istTankbeleg(position) ? 'Tanken' : 'Bar';
}
