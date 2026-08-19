import type { AblageEintrag, OneDriveDatei } from '@abrechnung/shared';
import type { Abdruck } from './abdruck.js';

/**
 * Abgleich der sevDesk-Belege mit den Dateien, die im Monatsordner liegen.
 *
 * Vorher entschieden Dateiname und Byte-Groesse. Beides trifft hier praktisch
 * nie: sevDesk nennt jeden Beleg "beleg-<voucherId>.pdf", in OneDrive steht der
 * Name des Lieferanten, und gleiche Groessen wiederholen sich - in einem
 * gepruefen Monatsordner lagen vier verschiedene Rechnungen mit exakt 95370
 * Bytes. Von 67 Dateien wurde deshalb genau eine zugeordnet.
 *
 * Jetzt entscheidet der Inhalt, in mehreren Stufen von hart nach weich. Jede
 * Stufe nimmt nur, was auf BEIDEN Seiten eindeutig ist: ein Beleg, der zu zwei
 * Dateien passt, wird ebensowenig zugeordnet wie eine Datei, die zu zwei
 * Belegen passt. Lieber eine Kopie hochladen als den falschen Beleg
 * verschieben - eine falsch einsortierte Datei faellt niemandem auf.
 */

/** Stufen des Abgleichs, in der Reihenfolge ihrer Anwendung. */
export const STUFEN = [
  'bytes',
  'bilder',
  'bilder-teil',
  'text',
  'name',
  'betrag',
  'groesse',
] as const;

export type Stufe = (typeof STUFEN)[number];

/** Was in der Oberflaeche zu einer Stufe steht. */
export const STUFENTEXT: Record<Stufe, string> = {
  bytes: 'Datei ist Byte für Byte dieselbe',
  bilder: 'dieselben eingebetteten Bilder',
  'bilder-teil': 'Bilder der Datei stecken im Beleg',
  text: 'derselbe Text',
  name: 'gleicher Dateiname',
  betrag: 'Betrag der Buchung steht im Text',
  groesse: 'gleiche Größe, sonst nichts Passendes',
};

export interface BelegMitAbdruck {
  eintrag: AblageEintrag;
  abdruck?: Abdruck;
}

export interface DateiMitAbdruck {
  datei: OneDriveDatei;
  abdruck?: Abdruck;
}

export interface AbgleichErgebnis {
  zugeordnet: AblageEintrag[];
  uebrig: OneDriveDatei[];
  /** Wie viele Zuordnungen je Stufe zustande kamen - fuer Anzeige und Log. */
  stufen: Record<Stufe, number>;
}

/** Gross-/Kleinschreibung und Leerraum sollen den Abgleich nicht verhindern. */
function normalisiere(name: string): string {
  return name.trim().toLowerCase();
}

function gleicheMenge(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((h, i) => h === b[i]);
}

/** true, wenn jedes Element aus `teil` in `ganz` vorkommt und `teil` nicht leer ist. */
function istTeilmenge(teil: string[], ganz: string[]): boolean {
  if (teil.length === 0 || teil.length > ganz.length) return false;
  const menge = new Set(ganz);
  return teil.every((h) => menge.has(h));
}

/**
 * Der Betrag einer Buchung in deutscher Schreibweise, mit und ohne
 * Tausenderpunkt - im Text steht mal "1.234,56", mal "1234,56".
 */
export function betragsMuster(betrag: number): RegExp[] {
  const wert = Math.abs(betrag).toFixed(2).replace('.', ',');
  const mitPunkt = wert.replace(/\B(?=(\d{3})+(?!\d)(?=,))/g, '.');
  const formen = mitPunkt === wert ? [wert] : [wert, mitPunkt];

  // Ziffernraender pruefen, sonst faende "4,38" auch in "14,38" einen Treffer.
  return formen.map(
    (form) => new RegExp(`(?<![\\d.,])${form.replace(/[.]/g, '\\.')}(?![\\d,])`),
  );
}

/**
 * Eine Stufe: liefert zu jedem Beleg die Dateien, die sie fuer passend haelt.
 * Zugeordnet wird daraus nur, was auf beiden Seiten eindeutig ist.
 */
type Pruefung = (beleg: BelegMitAbdruck, datei: DateiMitAbdruck) => boolean;

/**
 * Stufen, bei denen mehrere Kandidaten kein Hindernis sind.
 *
 * Nur bei `bytes`: passen zwei Dateien byteweise auf denselben Beleg, sind sie
 * auch untereinander identisch - im gepruefen Monatsordner lagen tatsaechlich
 * zwei inhaltsgleiche Dateien. Welche davon verschoben wird, macht keinen
 * Unterschied; die andere bleibt liegen und faellt in der Vorschau als Dublette
 * auf. Ueberall sonst waeren mehrere Kandidaten echte Unsicherheit.
 */
const UNTEREINANDER_GLEICH = new Set<Stufe>(['bytes']);

const PRUEFUNGEN: Record<Stufe, Pruefung> = {
  bytes: (b, d) => Boolean(b.abdruck && d.abdruck && b.abdruck.sha256 === d.abdruck.sha256),

  bilder: (b, d) =>
    Boolean(b.abdruck && d.abdruck && gleicheMenge(b.abdruck.bilder, d.abdruck.bilder)),

  // Der Fall "gescannter Beleg": sevDesk gibt ihn seitenweise heraus, diese
  // Anwendung setzt ihn wieder zusammen. Die Bildstroeme ueberstehen das
  // unveraendert, die Datei als Ganzes nicht.
  'bilder-teil': (b, d) =>
    Boolean(b.abdruck && d.abdruck && istTeilmenge(d.abdruck.bilder, b.abdruck.bilder)),

  text: (b, d) =>
    Boolean(b.abdruck?.textHash && d.abdruck?.textHash && b.abdruck.textHash === d.abdruck.textHash),

  name: (b, d) => normalisiere(b.eintrag.dateiname) === normalisiere(d.datei.dateiname),

  // Letzter inhaltlicher Anker: der Betrag der Buchung steht im Text der Datei.
  // Fuer sich genommen schwach - deshalb ganz hinten und nur, wenn er auf
  // beiden Seiten genau einmal vorkommt.
  betrag: (b, d) => {
    const betrag = b.eintrag.betrag;
    if (betrag === undefined || !d.abdruck?.text) return false;
    return betragsMuster(betrag).some((muster) => muster.test(d.abdruck!.text!));
  },

  groesse: (b, d) =>
    b.eintrag.groesse !== undefined && b.eintrag.groesse === d.datei.groesse,
};

export function gleicheAb(
  belege: BelegMitAbdruck[],
  dateien: DateiMitAbdruck[],
): AbgleichErgebnis {
  const zugeordnet = belege.map((b) => ({ ...b, eintrag: { ...b.eintrag } }));
  const frei = new Map(dateien.map((d) => [d.datei.id, d]));
  const stufen = Object.fromEntries(STUFEN.map((s) => [s, 0])) as Record<Stufe, number>;

  for (const stufe of STUFEN) {
    const pruefe = PRUEFUNGEN[stufe];
    const offen = zugeordnet.filter((b) => !b.eintrag.aktion);

    // Erst alle Kandidatenpaare der Stufe sammeln, dann entscheiden. Wuerde
    // schon beim Sammeln zugeordnet, haengte das Ergebnis an der Reihenfolge.
    const kandidaten = new Map<BelegMitAbdruck, DateiMitAbdruck[]>();
    const beansprucht = new Map<string, number>();

    for (const beleg of offen) {
      const passend = [...frei.values()].filter((d) => pruefe(beleg, d));
      if (passend.length > 0) kandidaten.set(beleg, passend);
      for (const d of passend) {
        beansprucht.set(d.datei.id, (beansprucht.get(d.datei.id) ?? 0) + 1);
      }
    }

    for (const [beleg, passend] of kandidaten) {
      // Mehrere Dateien auf einen Beleg: nur hinnehmbar, wenn sie ohnehin
      // dasselbe sind. Sonst wird nicht geraten.
      if (passend.length !== 1 && !UNTEREINANDER_GLEICH.has(stufe)) continue;

      // Der Reihenfolge wegen: dasselbe Ergebnis, egal wie OneDrive sortiert.
      const datei = [...passend].sort((a, b) => a.datei.id.localeCompare(b.datei.id))[0]!;

      // Eine Datei auf mehrere Belege bleibt in jedem Fall unentschieden - zwei
      // Buchungen koennen nicht beide dieselbe Datei bekommen.
      if ((beansprucht.get(datei.datei.id) ?? 0) !== 1) continue;
      if (!frei.has(datei.datei.id)) continue;

      frei.delete(datei.datei.id);
      Object.assign(beleg.eintrag, {
        aktion: 'verschieben' as const,
        quelle: datei.datei,
        abgleich: STUFENTEXT[stufe],
        stufe,
      });
      stufen[stufe]++;
    }
  }

  for (const beleg of zugeordnet) {
    if (!beleg.eintrag.aktion) beleg.eintrag.aktion = 'hochladen';
  }

  return {
    zugeordnet: zugeordnet.map((b) => b.eintrag),
    uebrig: [...frei.values()].map((d) => d.datei),
    stufen,
  };
}
