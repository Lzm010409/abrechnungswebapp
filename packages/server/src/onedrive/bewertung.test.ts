import { describe, expect, it } from 'vitest';
import type { AblageEintrag, OneDriveDatei } from '@abrechnung/shared';
import type { Abdruck } from './abdruck.js';
import {
  bereiteAuf,
  betragsMuster,
  bewerte,
  datumsangaben,
  kennungen,
  namensteile,
} from './bewertung.js';

/**
 * Die fuenf Verfahren, mit denen eine Buchung und eine Datei zusammenfinden.
 * Die Beispiele sind echt: Dateinamen und Rechnungstexte stammen aus dem
 * Monatsordner 2026/07.
 */

const beleg = (buchung: Partial<NonNullable<AblageEintrag['buchung']>>): AblageEintrag => ({
  positionId: 'p1',
  dateiId: 'd1',
  dateiname: 'beleg-4711.pdf',
  ordner: 'Konto',
  begruendung: 'Test',
  buchung: { datum: '2026-07-15', betrag: -49.99, ...buchung },
});

const datei = (dateiname: string): OneDriveDatei => ({ id: 'od-1', dateiname });

const mitText = (text: string): Abdruck => ({
  groesse: 1000,
  sha256: 'x',
  bilder: [],
  textHash: 't',
  text,
});

describe('kennungen', () => {
  it('findet Rechnungs- und Kundennummern', () => {
    expect(kennungen('VODAFONE KUNDENNR 476077502 RG 00302751112')).toEqual(
      expect.arrayContaining(['476077502', '00302751112']),
    );
  });

  it('laesst Betraege und Datumsangaben liegen', () => {
    const gefunden = kennungen('Zahlung 49,99 am 15.07.2026');
    expect(gefunden).not.toContain('49,99');
    expect(gefunden).not.toContain('15.07.2026');
  });

  it('laesst kurze Zahlen liegen - die stehen in jedem zweiten Beleg', () => {
    expect(kennungen('Nr 1234')).toEqual([]);
  });
});

describe('namensteile', () => {
  it('laesst Rechtsform und Fuellwerk weg', () => {
    expect(namensteile('Vodafone West GmbH')).toEqual(['vodafone', 'west']);
    expect(namensteile('Telekom Deutschland GmbH')).toEqual(['telekom']);
  });

  it('kommt mit Umlauten zurecht', () => {
    expect(namensteile('Müller Getränke KG')).toEqual(['mueller', 'getraenke']);
  });
});

describe('datumsangaben', () => {
  it('liest die drei Schreibweisen, die vorkommen', () => {
    expect(datumsangaben('bewirtung-25.07.2026.pdf')).toContain('2026-07-25');
    expect(datumsangaben('Hetzner_2026-07-04_082000995771.pdf')).toContain('2026-07-04');
    expect(datumsangaben('Beitragsrechnung_20260724_0419.pdf')).toContain('2026-07-24');
  });

  it('nimmt keine Unsinnsdaten', () => {
    expect(datumsangaben('20261399')).toEqual([]);
  });
});

describe('betragsMuster', () => {
  it('findet den Betrag mit und ohne Tausenderpunkt', () => {
    const muster = betragsMuster(-1234.5);
    expect(muster.some((m) => m.test('summe 1234,50 eur'))).toBe(true);
    expect(muster.some((m) => m.test('summe 1.234,50 eur'))).toBe(true);
  });

  it('greift nicht in eine laengere Zahl hinein', () => {
    const muster = betragsMuster(-4.38);
    expect(muster.some((m) => m.test('14,38'))).toBe(false);
    expect(muster.some((m) => m.test('endbetrag 4,38 eur'))).toBe(true);
  });
});

describe('bewerte', () => {
  it('erkennt die Rechnungsnummer aus dem Verwendungszweck wieder', () => {
    const b = bewerte(
      beleg({ verwendungszweck: 'VODAFONE KUNDENNR 476077502' }),
      bereiteAuf(datei('023a69a3-a8a5-4603-91ab-946266ecb8e1.pdf'), mitText('vodafone west gmbh kundennummer: 476077502 rechnungsbetrag 49,99')),
    );

    expect(b.punkte).toBeGreaterThanOrEqual(45);
    expect(b.grund).toContain('476077502');
  });

  it('wertet einen Betrag im Summenfeld hoeher als irgendwo im Text', () => {
    const imFeld = bewerte(
      beleg({}),
      bereiteAuf(datei('a.pdf'), mitText('positionen ... rechnungsbetrag 49,99 eur')),
    );
    const irgendwo = bewerte(beleg({}), bereiteAuf(datei('a.pdf'), mitText('artikel zu 49,99 eur je stueck')));

    expect(imFeld.punkte).toBeGreaterThan(irgendwo.punkte);
  });

  it('findet den Lieferanten aus dem Zahlungsempfaenger', () => {
    const b = bewerte(
      beleg({ gegenkonto: 'Telekom Deutschland GmbH' }),
      bereiteAuf(datei('0391617514.pdf'), mitText('telekom deutschland gmbh rechnung telekomcloud')),
    );

    expect(b.befunde.map((x) => x.verfahren)).toContain('lieferant');
  });

  it('liest das Datum aus dem Dateinamen, wenn es keine Textebene gibt', () => {
    // Genau der Fall der eingescannten Tankbelege: kein Text, aber das Datum
    // steht im Namen.
    const b = bewerte(
      beleg({ datum: '2026-07-15', betrag: -87.5 }),
      bereiteAuf(datei('tanken-13.07.2026.pdf'), undefined),
    );

    expect(b.befunde.map((x) => x.verfahren)).toContain('datum');
    expect(b.grund).toContain('2026-07-13');
  });

  it('gibt einem Datum kurz vor der Zahlung mehr als einem weit davor', () => {
    const nah = bewerte(beleg({ datum: '2026-07-15' }), bereiteAuf(datei('tanken-13.07.2026.pdf'), undefined));
    const fern = bewerte(beleg({ datum: '2026-07-15' }), bereiteAuf(datei('tanken-01.05.2026.pdf'), undefined));

    expect(nah.punkte).toBeGreaterThan(fern.punkte);
  });

  it('nimmt ein Datum nach der Zahlung nicht mehr an', () => {
    const b = bewerte(beleg({ datum: '2026-07-01' }), bereiteAuf(datei('tanken-25.07.2026.pdf'), undefined));
    expect(b.punkte).toBe(0);
  });

  it('belohnt das Zusammentreffen zweier Verfahren', () => {
    const nurBetrag = bewerte(beleg({}), bereiteAuf(datei('a.pdf'), mitText('irgendwas 49,99')));
    const betragUndDatum = bewerte(
      beleg({}),
      bereiteAuf(datei('bewirtung-12.07.2026.pdf'), mitText('irgendwas 49,99')),
    );

    expect(betragUndDatum.punkte).toBeGreaterThan(nurBetrag.punkte + 15);
  });

  it('gibt null, wenn nichts zusammenpasst', () => {
    const b = bewerte(
      beleg({ gegenkonto: 'Telekom', verwendungszweck: 'RG 391617514' }),
      bereiteAuf(datei('geschenke-kunden-fortuna-1.pdf'), mitText('trinkgut fachmarkt bon 12,34')),
    );

    expect(b.punkte).toBe(0);
  });
});

describe('Gelesene Belege', () => {
  const gelesen = (text: string): Abdruck => ({
    groesse: 1_400_000,
    sha256: 'x',
    bilder: ['b1'],
    gelesen: { text, konfidenz: 0.9 },
  });

  it('nutzt, was das Modell auf dem Scan gelesen hat', () => {
    // Ohne das haette die Tankquittung nur ihr Datum im Namen - mit dem Betrag
    // wird daraus eine belastbare Zuordnung.
    const b = bewerte(
      beleg({ datum: '2026-07-15', betrag: -87.5, gegenkonto: 'Shell Deutschland' }),
      bereiteAuf(datei('tanken-13.07.2026.pdf'), gelesen('shell tankstelle 87,50 2026-07-13')),
    );

    expect(b.punkte).toBeGreaterThanOrEqual(45);
    expect(b.befunde.map((x) => x.verfahren)).toEqual(
      expect.arrayContaining(['betrag', 'lieferant', 'datum']),
    );
  });

  it('bleibt beim Dateinamen, wenn nichts gelesen wurde', () => {
    const b = bewerte(
      beleg({ datum: '2026-07-15', betrag: -87.5 }),
      bereiteAuf(datei('tanken-13.07.2026.pdf'), undefined),
    );

    expect(b.befunde.map((x) => x.verfahren)).toEqual(['datum']);
  });
});
