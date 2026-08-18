import type { AblageErgebnis, Ablageordner } from '@abrechnung/shared';

/**
 * Zeigt, welcher Beleg in welchen OneDrive-Ordner gehoert.
 *
 * Erscheint nach dem Erzeugen des Abrechnungs-PDF, weil die Einteilung erst
 * dann feststeht: sie haengt daran, welche Buchung sich auf einer Seite des
 * Kontoauszugs wiederfindet.
 *
 * Verschoben wird nichts ohne ausdruecklichen Klick. Dateien in fremde Ordner
 * zu legen ist nichts, was nebenbei passieren sollte.
 */

const REIHENFOLGE: Ablageordner[] = ['Konto', 'Bar', 'Tanken'];

const ERKLAERUNG: Record<Ablageordner, string> = {
  Konto: 'auf einer Seite des Kontoauszugs gefunden',
  Bar: 'nicht auf dem Kontoauszug – bar bezahlt',
  Tanken: 'Tankbeleg ohne Kontobezug',
};

interface Props {
  ergebnis: AblageErgebnis;
  /** Fehlt, wenn die Ablage-Webhooks nicht konfiguriert sind. */
  onAusfuehren?: () => void;
  onSchliessen: () => void;
  laedt: boolean;
}

export function Ablagevorschau({ ergebnis, onAusfuehren, onSchliessen, laedt }: Props) {
  const fehlgeschlagen = ergebnis.eintraege.filter((e) => e.fehler);

  return (
    <section className="ablage">
      <header>
        <h4>
          Belegablage {ergebnis.ausgefuehrt ? '– abgelegt' : '– Vorschau'}
        </h4>
        <button className="verweis" onClick={onSchliessen}>
          schließen
        </button>
      </header>

      {ergebnis.hinweis && <p className="hinweis">{ergebnis.hinweis}</p>}

      <div className="ordner">
        {REIHENFOLGE.map((ordner) => {
          const eintraege = ergebnis.eintraege.filter((e) => e.ordner === ordner);
          return (
            <div key={ordner} className="ordner-block">
              <h5>
                {ordner} <span className="grau klein">({eintraege.length})</span>
              </h5>
              <p className="grau klein">{ERKLAERUNG[ordner]}</p>
              <ul>
                {eintraege.map((e) => (
                  <li key={e.dateiId} className={e.fehler ? 'fehler' : ''}>
                    {e.aktion && (
                      <span
                        className={`marke aktion ${e.aktion}`}
                        title={
                          e.aktion === 'verschieben'
                            ? `Die Datei liegt schon in OneDrive (${e.abgleich}) und wird nur einsortiert`
                            : 'In OneDrive nicht gefunden – wird aus sevDesk hochgeladen'
                        }
                      >
                        {e.aktion === 'verschieben' ? 'verschieben' : 'hochladen'}
                      </span>
                    )}
                    <span title={e.begruendung}>{e.quelle?.dateiname ?? e.dateiname}</span>
                    {e.vonHand && <span className="grau klein"> · von Hand</span>}
                    {e.fehler && <span className="klein"> — {e.fehler}</span>}
                  </li>
                ))}
                {eintraege.length === 0 && <li className="grau klein">nichts</li>}
              </ul>
            </div>
          );
        })}
      </div>

      {ergebnis.ohneBeleg > 0 && (
        <p className="grau klein">
          {ergebnis.ohneBeleg} Buchung{ergebnis.ohneBeleg === 1 ? '' : 'en'} ohne Beleg —
          davon landet nichts in OneDrive.
        </p>
      )}

      {ergebnis.uebrig && ergebnis.uebrig.length > 0 && (
        <details className="uebrig">
          <summary className="grau klein">
            {ergebnis.uebrig.length} Datei(en) im Monatsordner ohne passende Buchung —
            bleiben liegen
          </summary>
          <ul>
            {ergebnis.uebrig.map((d) => (
              <li key={d.id}>{d.dateiname}</li>
            ))}
          </ul>
        </details>
      )}

      {fehlgeschlagen.length > 0 && (
        <p className="hinweis">
          {fehlgeschlagen.length} Datei{fehlgeschlagen.length === 1 ? '' : 'en'} konnten
          nicht abgelegt werden.
        </p>
      )}

      {!ergebnis.ausgefuehrt && onAusfuehren && (
        <button className="primaer" disabled={laedt} onClick={onAusfuehren}>
          {ergebnis.eintraege.length} Belege jetzt in OneDrive ablegen
        </button>
      )}
    </section>
  );
}
