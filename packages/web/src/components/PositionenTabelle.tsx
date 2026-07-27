import type { Position, PositionsStatus } from '@abrechnung/shared';
import { deutschesDatum, euro } from '../api/client';

const AMPEL: Record<PositionsStatus, { zeichen: string; klasse: string; titel: string }> = {
  ok: { zeichen: '●', klasse: 'ampel ok', titel: 'Beleg zugeordnet' },
  mehrdeutig: { zeichen: '●', klasse: 'ampel mehrdeutig', titel: 'Mehrere Treffer - bitte prüfen' },
  offen: { zeichen: '●', klasse: 'ampel offen', titel: 'Kein Beleg gefunden' },
  ignoriert: { zeichen: '○', klasse: 'ampel ignoriert', titel: 'Ausgeblendet' },
};

interface Props {
  positionen: Position[];
  ausgewaehlt?: string;
  onAuswahl: (positionId: string) => void;
}

export function PositionenTabelle({ positionen, ausgewaehlt, onAuswahl }: Props) {
  if (positionen.length === 0) {
    return (
      <p className="leer">
        Keine Buchungen in diesem Monat. Falls das nicht stimmt, oben auf
        „Aus sevDesk laden" klicken.
      </p>
    );
  }

  return (
    <table className="positionen">
      <thead>
        <tr>
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
              ]
                .filter(Boolean)
                .join(' ')}
            >
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
                      p.markierung === 'privatentnahme'
                        ? 'Privatentnahme – kein Beleg erforderlich'
                        : 'Dauerbeleg – der Beleg liegt einmalig als Vertrag vor'
                    }
                  >
                    {p.markierung === 'privatentnahme' ? 'privat' : 'Dauer'}
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
  if (p.dateien.length === 0 && p.markierung) {
    return p.markierung === 'privatentnahme' ? 'privat' : 'Dauerbeleg';
  }
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
