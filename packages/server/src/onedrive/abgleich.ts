import type { AblageEintrag, OneDriveDatei } from '@abrechnung/shared';
import type { Abdruck } from './abdruck.js';
import { bereiteAuf, bewerte, type Bewertung } from './bewertung.js';

/**
 * Abgleich der sevDesk-Belege mit den Dateien, die im Monatsordner liegen.
 *
 * Zwei Teile, in dieser Reihenfolge:
 *
 *   1. **Beweise.** Ist die Datei byteweise dieselbe, enthaelt sie dieselben
 *      Bildstroeme oder denselben Text, ist die Sache entschieden.
 *
 *   2. **Indizien.** Fuer alles Uebrige wird bewertet statt verglichen - siehe
 *      bewertung.ts. Zugeordnet wird das global beste Paar, aber nur wenn es
 *      eine Schwelle ueberschreitet UND deutlich vor dem zweitbesten liegt.
 *
 * Warum der zweite Teil das Entscheidende ist: in einem echten Monatsordner
 * griff von den Beweisen kein einziger. Die Datei in OneDrive ist die
 * Original-Rechnung des Lieferanten, die aus sevDesk eine eigene Fassung
 * desselben Belegs - gemeinsam haben sie nur, was drauf steht.
 *
 * Der frueher entscheidende Punkt "bei Mehrdeutigkeit gar nichts" war zu
 * streng: zwei Dateien mit demselben Betrag liessen die Zuordnung scheitern,
 * obwohl nur eine davon auch den Lieferanten und das Datum traf. Jetzt
 * entscheidet der Abstand.
 */

/** Beweisstufen, in der Reihenfolge ihrer Anwendung. */
export const BEWEISE = ['bytes', 'bilder', 'bilder-teil', 'text', 'name'] as const;
export type Beweis = (typeof BEWEISE)[number];

export type Stufe = Beweis | 'bewertung';

export const STUFENTEXT: Record<Stufe, string> = {
  bytes: 'Datei ist Byte für Byte dieselbe',
  bilder: 'dieselben eingebetteten Bilder',
  'bilder-teil': 'Bilder der Datei stecken im Beleg',
  text: 'derselbe Text',
  name: 'gleicher Dateiname',
  bewertung: 'inhaltlich zugeordnet',
};

/**
 * Ab hier gilt eine Zuordnung als belastbar, und so weit muss sie vor der
 * zweitbesten liegen.
 *
 * Die Schwelle liegt bewusst ueber dem, was ein einzelnes Verfahren liefern
 * kann - ausser der Kennung aus dem Verwendungszweck, die fuer sich genommen
 * schon ein starker Anker ist. Alles andere braucht eine zweite Bestaetigung.
 */
export const SCHWELLE = 45;
export const ABSTAND = 12;

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

type Pruefung = (beleg: BelegMitAbdruck, datei: DateiMitAbdruck) => boolean;

/**
 * Beweisstufen, bei denen mehrere Kandidaten kein Hindernis sind.
 *
 * Nur bei `bytes`: passen zwei Dateien byteweise auf denselben Beleg, sind sie
 * auch untereinander identisch - im gepruefen Monatsordner lagen tatsaechlich
 * zwei inhaltsgleiche Dateien. Welche davon verschoben wird, macht keinen
 * Unterschied; die andere bleibt liegen und faellt als Dublette auf.
 */
const UNTEREINANDER_GLEICH = new Set<Beweis>(['bytes']);

const PRUEFUNGEN: Record<Beweis, Pruefung> = {
  bytes: (b, d) => Boolean(b.abdruck && d.abdruck && b.abdruck.sha256 === d.abdruck.sha256),

  bilder: (b, d) =>
    Boolean(b.abdruck && d.abdruck && gleicheMenge(b.abdruck.bilder, d.abdruck.bilder)),

  // Der Fall "gescannter Beleg": sevDesk gibt ihn seitenweise heraus, diese
  // Anwendung setzt ihn wieder zusammen. Die Bildstroeme ueberstehen das
  // unveraendert, die Datei als Ganzes nicht.
  'bilder-teil': (b, d) =>
    Boolean(b.abdruck && d.abdruck && istTeilmenge(d.abdruck.bilder, b.abdruck.bilder)),

  text: (b, d) =>
    Boolean(
      b.abdruck?.textHash && d.abdruck?.textHash && b.abdruck.textHash === d.abdruck.textHash,
    ),

  name: (b, d) => normalisiere(b.eintrag.dateiname) === normalisiere(d.datei.dateiname),
};

export function gleicheAb(
  belege: BelegMitAbdruck[],
  dateien: DateiMitAbdruck[],
): AbgleichErgebnis {
  const zugeordnet = belege.map((b) => ({ ...b, eintrag: { ...b.eintrag } }));
  const frei = new Map(dateien.map((d) => [d.datei.id, d]));
  const stufen = Object.fromEntries(
    [...BEWEISE, 'bewertung'].map((s) => [s, 0]),
  ) as Record<Stufe, number>;

  // -- Teil 1: Beweise ------------------------------------------------------

  for (const stufe of BEWEISE) {
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

  // -- Teil 2: Bewertung ----------------------------------------------------

  const offen = zugeordnet.filter((b) => !b.eintrag.aktion);
  const paare: Array<{ beleg: BelegMitAbdruck; datei: DateiMitAbdruck; bewertung: Bewertung }> = [];

  // Einmal je Datei aufbereiten, nicht je Paar - sonst laeuft derselbe
  // Rechnungstext bei sechzig Buchungen sechzigmal durch.
  const aufbereitet = new Map(
    [...frei.values()].map((d) => [d.datei.id, bereiteAuf(d.datei, d.abdruck)]),
  );

  for (const beleg of offen) {
    for (const datei of frei.values()) {
      const bewertung = bewerte(beleg.eintrag, aufbereitet.get(datei.datei.id)!);
      if (bewertung.punkte > 0) paare.push({ beleg, datei, bewertung });
    }
  }

  /*
   * Absteigend nach Punkten vergeben, und zwar global: das beste Paar im
   * ganzen Monat zuerst. Sonst schnappt die erste Buchung in der Liste eine
   * Datei weg, die zu einer spaeteren viel besser passt.
   */
  paare.sort(
    (a, b) =>
      b.bewertung.punkte - a.bewertung.punkte ||
      a.datei.datei.id.localeCompare(b.datei.datei.id),
  );

  const besterAndererKandidat = (
    beleg: BelegMitAbdruck,
    ausser: string,
  ): { bewertung: Bewertung; dateiname: string } | undefined => {
    for (const p of paare) {
      if (p.beleg !== beleg) continue;
      if (p.datei.datei.id === ausser) continue;
      if (!frei.has(p.datei.datei.id)) continue;
      return { bewertung: p.bewertung, dateiname: p.datei.datei.dateiname };
    }
    return undefined;
  };

  for (const { beleg, datei, bewertung } of paare) {
    if (beleg.eintrag.aktion) continue;
    if (!frei.has(datei.datei.id)) continue;
    if (bewertung.punkte < SCHWELLE) continue;

    // Der zweitbeste noch freie Kandidat derselben Buchung muss deutlich
    // zurueckliegen - sonst ist es Raten mit Punkten.
    const zweiter = besterAndererKandidat(beleg, datei.datei.id);
    if (zweiter && bewertung.punkte - zweiter.bewertung.punkte < ABSTAND) {
      beleg.eintrag.knappVerfehlt = {
        dateiname: datei.datei.dateiname,
        punkte: bewertung.punkte,
        grund: `nicht eindeutig, "${zweiter.dateiname}" passt fast genauso gut`,
      };
      continue;
    }

    frei.delete(datei.datei.id);
    Object.assign(beleg.eintrag, {
      aktion: 'verschieben' as const,
      quelle: datei.datei,
      abgleich: bewertung.grund,
      stufe: 'bewertung',
      punkte: bewertung.punkte,
    });
    delete beleg.eintrag.knappVerfehlt;
    stufen.bewertung++;
  }

  // -- Rest -----------------------------------------------------------------

  for (const beleg of zugeordnet) {
    if (beleg.eintrag.aktion) continue;
    beleg.eintrag.aktion = 'offen';

    // Was der Abgleich beinahe genommen haette, gehoert in die Anzeige. Nur
    // daran laesst sich erkennen, ob er knapp danebenlag oder weit weg war.
    if (!beleg.eintrag.knappVerfehlt) {
      const bester = paare.find((p) => p.beleg === beleg);
      if (bester) {
        beleg.eintrag.knappVerfehlt = {
          dateiname: bester.datei.datei.dateiname,
          punkte: bester.bewertung.punkte,
          grund: bester.bewertung.grund,
        };
      }
    }
  }

  return {
    zugeordnet: zugeordnet.map((b) => b.eintrag),
    uebrig: [...frei.values()].map((d) => d.datei),
    stufen,
  };
}
