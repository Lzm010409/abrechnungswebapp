import type { Position, PositionsStatus } from '@abrechnung/shared';
import { deutschesDatum, euro } from '../api/client';

const AMPEL: Record<PositionsStatus, { zeichen: string; klasse: string; titel: string }> = {
  ok: { zeichen: '●', klasse: 'ampel ok', titel: 'Beleg zugeordnet' },
  mehrdeutig: { zeichen: '●', klasse: 'ampel mehrdeutig', titel: 'Mehrere Treffer - bitte prüfen' },
  offen: { zeichen: '●', klasse: 'ampel offen', titel: 'Kein Beleg gefunden' },
  ignoriert: { zeichen: '○', klasse: 'ampel ignoriert', titel: 'Ausgeblendet' },
};

const MARKEN_TEXT: Record<NonNullable<Position['markierung']>, string> = {
  privatentnahme: 'privat',
  dauerbeleg: 'Dauer',
  umbuchung: 'Umbuchung',
};

const MARKEN_TITEL: Record<NonNullable<Position['markierung']>, string> = {
  privatentnahme: 'Privatentnahme – kein Beleg erforderlich',
  dauerbeleg: 'Dauerbeleg – der Beleg liegt einmalig als Vertrag vor',
  umbuchung: 'Umbuchung zwischen eigenen Konten – kein Beleg erforderlich',
};

interface Props {
  positionen: Position[];
  ausgewaehlt?: string;
  onAuswahl: (positionId: string) => void;
  /** Mehrfachauswahl fuer Sammelaktionen */
  markiert: Set<string>;
  onMarkierungAendern: (ids: Set<string>) => void;
}

export function PositionenTabelle({
  positionen,
  ausgewaehlt,
  onAuswahl,
  markiert,
  onMarkierungAendern,
}: Props) {
  if (positionen.length === 0) {
    return (
      <p className="leer">
        Keine Buchungen in diesem Monat. Falls das nicht stimmt, oben auf
        „Aus sevDesk laden" klicken.
      </p>
    );
  }

  const alleMarkiert = positionen.length > 0 && positionen.every((p) => markiert.has(p.id));

  const schalte = (id: string) => {
    const neu = new Set(markiert);
    if (neu.has(id)) neu.delete(id);
    else neu.add(id);
    onMarkierungAendern(neu);
  };

  return (
    <table className="positionen">
      <thead>
        <tr>
          <th className="sp-haken">
            <input
              type="checkbox"
              checked={alleMarkiert}
              title={alleMarkiert ? 'Auswahl aufheben' : 'Alle auswählen'}
              onChange={() =>
                onMarkierungAendern(
                  alleMarkiert ? new Set() : new Set(positionen.map((p) => p.id)),
                )
              }
            />
          </th>
          <th className="sp-status" />
          <th className="sp-datum">Datum</th>
          <th className="sp-betrag">Betrag</th>
          <th>Verwendungszweck</th>
          <th className="sp-typ">Typ</th>
          <th className="sp-az">Aktenzeichen</th>
          <th className="sp-beleg">Beleg</th>
        </tr>
      </thead>
      <tbody>
        {positionen.map((p) => {
          const ampel = AMPEL[p.status];
          return (
            <tr
              key={p.id}
              onClick={() => onAuswahl(p.id)}
              className={[
                ausgewaehlt === p.id ? 'aktiv' : '',
                p.status === 'ignoriert' ? 'ausgeblendet' : '',
                markiert.has(p.id) ? 'markiert' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <td className="sp-haken">
                <input
                  type="checkbox"
                  checked={markiert.has(p.id)}
                  // Der Haken darf die Zeilenauswahl nicht mitausloesen - sonst
                  // springt der Detailbereich bei jedem Anhaken um.
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => schalte(p.id)}
                />
              </td>
              <td>
                <span className={ampel.klasse} title={p.hinweis ?? ampel.titel}>
                  {ampel.zeichen}
                </span>
              </td>
              <td className="sp-datum">{deutschesDatum(p.datum)}</td>
              <td className={`sp-betrag ${p.betrag < 0 ? 'negativ' : 'positiv'}`}>
                {euro(p.betrag)}
              </td>
              <td className="sp-zweck" title={p.verwendungszweck}>
                <span className="zweck">{p.verwendungszweck || '—'}</span>
                {p.gegenkonto && <span className="gegenkonto">{p.gegenkonto}</span>}
              </td>
              <td className="sp-typ">
                <span className={`typ ${p.typ.toLowerCase()}`}>
                  {p.typ === 'EINGANG' ? 'EIN' : 'AUS'}
                </span>
                {p.markierung && (
                  <span
                    className={`marke ${p.markierung}`}
                    title={
                      MARKEN_TITEL[p.markierung]
                    }
                  >
                    {MARKEN_TEXT[p.markierung]}
                  </span>
                )}
                {p.ablageordner && p.typ === 'AUSGANG' && p.dateien.length > 0 && (
                  <span
                    className="marke ablageordner"
                    title={`Beleg wird nach ${p.ablageordner} abgelegt – von Hand gesetzt`}
                  >
                    → {p.ablageordner}
                  </span>
                )}
                {p.sevdeskStatus === 'offen' && !p.markierung && (
                  <span
                    className="marke sevdesk-offen"
                    title="In sevDesk noch nicht zugeordnet – dort verbuchen, dann neu laden"
                  >
                    sevDesk
                  </span>
                )}
              </td>
              <td className="sp-az">
                {p.aktenzeichen ? (
                  <code
                    title={`Quelle: ${herkunftText(p.aktenzeichen.herkunft)}`}
                    className={p.aktenzeichen.herkunft === 'sevdesk-invoice' ? 'sicher' : ''}
                  >
                    {p.aktenzeichen.normalisiert}
                  </code>
                ) : (
                  <span className="fehlt">—</span>
                )}
              </td>
              <td className="sp-beleg">{belegKuerzel(p)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function belegKuerzel(p: Position): string {
  if (p.dateien.length === 0 && p.markierung) return MARKEN_TEXT[p.markierung];
  if (p.dateien.length === 0) {
    // Liegt es an sevDesk, hilft ein Beleg-Upload hier nicht weiter.
    return p.sevdeskStatus === 'offen' ? 'nicht verbucht' : '—';
  }
  const kandidaten = p.kandidaten?.length ?? 0;
  if (kandidaten > 0) return `${p.dateien.length} von ${p.dateien.length + kandidaten}`;
  return p.dateien.length > 1 ? `${p.dateien.length} Dateien` : '1 Datei';
}

function herkunftText(herkunft: string): string {
  switch (herkunft) {
    case 'sevdesk-invoice':
      return 'aus der verknüpften sevDesk-Rechnung (sicher)';
    case 'verwendungszweck':
      return 'aus dem Verwendungszweck geparst';
    case 'manuell':
      return 'manuell eingetragen';
    case 'ki':
      return 'von der KI vorgeschlagen';
    default:
      return herkunft;
  }
}
