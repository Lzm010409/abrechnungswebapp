import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Kontoauszug, Monat, Position } from '@abrechnung/shared';
import { leseSeitentexte, ordneBuchungenSeitenZu } from './seitenzuordnung.js';

/**
 * Baut das Abrechnungs-PDF.
 *
 * Mit Kontoauszug (die Form, die der Steuerberater erwartet):
 *   1. Deckblatt mit Summen und Statuszaehlern
 *   2. Monatsjournal - alle Buchungen als Tabelle mit laufender Nummer
 *   3. je Auszugsseite: die Seite selbst, dahinter die Belege zu genau den
 *      Buchungen, die auf ihr stehen
 *   4. Belege ohne Seitenzuordnung, gesammelt am Ende
 *
 * Ohne Kontoauszug - oder wenn sich die Buchungen keiner Seite zuordnen
 * lassen, etwa bei einem eingescannten Auszug ohne Textebene - bleibt es bei
 * der einfachen Reihenfolge: erst alle Auszugsseiten, dann alle Belege. Eine
 * geratene Zuordnung waere schlimmer als gar keine.
 *
 * Jede Belegseite traegt in beiden Faellen eine Kopfzeile mit der
 * Positionsnummer aus dem Journal, ueber die sich Buchung und Beleg
 * unabhaengig von der Reihenfolge verbinden lassen.
 */

export interface PdfBauOptionen {
  monat: Monat;
  /** Liefert die Bytes einer abgelegten Datei. */
  ladeDatei: (dateiId: string) => Promise<Buffer>;
  /** Kanzlei-/Bueroname fuer das Deckblatt. */
  buero?: string;
}

const RAND = 50;
const A4: [number, number] = [595.28, 841.89];

/** Eine Buchung samt ihrer Nummer im Journal. */
interface NummeriertePosition {
  nummer: number;
  position: Position;
}

export async function baueAbrechnungsPdf(opts: PdfBauOptionen): Promise<Buffer> {
  const { monat, ladeDatei } = opts;
  const doc = await PDFDocument.create();

  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const fett = await doc.embedFont(StandardFonts.HelveticaBold);

  const relevant = monat.positionen
    .filter((p) => p.status !== 'ignoriert')
    .sort(sortiereFuerAusgabe);

  const nummeriert: NummeriertePosition[] = relevant.map((position, i) => ({
    nummer: i + 1,
    position,
  }));

  zeichneDeckblatt(doc, monat, normal, fett, opts.buero);
  zeichneJournal(doc, relevant, normal, fett);

  const verschachtelt = await haengeAuszuegeMitBelegenAn(
    doc,
    monat.kontoauszuege,
    nummeriert,
    ladeDatei,
    normal,
    fett,
  );

  if (!verschachtelt) {
    // Rueckfall: erst die Auszuege, dann alle Belege am Stueck.
    await haengeKontoauszuegeAn(doc, monat.kontoauszuege, ladeDatei, normal);
    await haengeBelegeAn(doc, nummeriert, ladeDatei, normal);
  }

  return Buffer.from(await doc.save());
}

/**
 * Haengt die Auszugsseiten an und stellt hinter jede die Belege der Buchungen,
 * die auf ihr stehen. Gibt false zurueck, wenn das nicht moeglich war - dann
 * uebernimmt der Aufrufer die einfache Reihenfolge.
 */
async function haengeAuszuegeMitBelegenAn(
  doc: PDFDocument,
  auszuege: Kontoauszug[],
  positionen: NummeriertePosition[],
  ladeDatei: (id: string) => Promise<Buffer>,
  normal: PDFFont,
  fett: PDFFont,
): Promise<boolean> {
  if (auszuege.length === 0) return false;

  // Alle Auszuege hintereinander betrachten: die Seitennummern laufen ueber
  // Dateigrenzen hinweg durch, damit die Zuordnung eindeutig bleibt.
  const seiten: Array<{ auszug: Kontoauszug; bytes: Buffer; text: string }> = [];

  for (const auszug of auszuege) {
    let bytes: Buffer;
    try {
      bytes = await ladeDatei(auszug.id);
    } catch {
      continue;
    }

    const texte = await leseSeitentexte(bytes);
    if (texte.length === 0) return false; // keine Textebene - nicht raten

    const quelle = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch(
      () => null,
    );
    if (!quelle) return false;

    for (const [i, text] of texte.entries()) {
      const einzeln = await PDFDocument.create();
      const [kopie] = await einzeln.copyPages(quelle, [i]);
      einzeln.addPage(kopie!);
      seiten.push({ auszug, bytes: Buffer.from(await einzeln.save()), text });
    }
  }

  if (seiten.length === 0) return false;

  const zuordnung = ordneBuchungenSeitenZu(
    seiten.map((s) => s.text),
    positionen.map((n) => n.position),
  );

  // Ordnet die Zuordnung niemandem eine Seite zu, bringt die Verschachtelung
  // nichts - dann ist die einfache Form ehrlicher.
  if (zuordnung.size === 0) return false;

  for (const [i, seite] of seiten.entries()) {
    const kopien = await kopiereSeiten(doc, seite.bytes);
    for (const s of kopien) {
      kopfzeile(s, `Kontoauszug ${i + 1}/${seiten.length} - ${seite.auszug.dateiname}`, normal);
    }

    const dazu = positionen.filter((n) => zuordnung.get(n.position.id) === i);
    await haengeBelegeAn(doc, dazu, ladeDatei, normal);
  }

  const ohneSeite = positionen.filter((n) => !zuordnung.has(n.position.id));
  if (ohneSeite.length > 0) {
    zeichneTrenner(
      doc,
      'Belege ohne Zuordnung zu einer Auszugsseite',
      `${ohneSeite.length} Buchung${ohneSeite.length === 1 ? '' : 'en'} liessen sich auf ` +
        'keiner Seite des Kontoauszugs wiederfinden. Die Nummer in der Kopfzeile ' +
        'verweist auf das Monatsjournal.',
      normal,
      fett,
    );
    await haengeBelegeAn(doc, ohneSeite, ladeDatei, normal);
  }

  return true;
}

/** Einzelne Seite als Abschnittstrenner. */
function zeichneTrenner(
  doc: PDFDocument,
  titel: string,
  text: string,
  normal: PDFFont,
  fett: PDFFont,
): void {
  const seite = doc.addPage(A4);
  const { height } = seite.getSize();

  seite.drawText(titel, { x: RAND, y: height / 2, size: 14, font: fett });

  // Einfacher Umbruch an Wortgrenzen - der Trenner traegt nur zwei, drei Zeilen.
  const maxBreite = A4[0] - 2 * RAND;
  const zeilen: string[] = [];
  let aktuell = '';
  for (const wort of text.split(' ')) {
    const versuch = aktuell ? `${aktuell} ${wort}` : wort;
    if (normal.widthOfTextAtSize(versuch, 10) > maxBreite) {
      zeilen.push(aktuell);
      aktuell = wort;
    } else {
      aktuell = versuch;
    }
  }
  if (aktuell) zeilen.push(aktuell);

  for (const [i, zeile] of zeilen.entries()) {
    seite.drawText(zeile, {
      x: RAND,
      y: height / 2 - 22 - i * 14,
      size: 10,
      font: normal,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
}

/**
 * Buchungsreihenfolge nach Datum; innerhalb eines Tages erst AUSGANG,
 * dann EINGANG - so wie es der Skill fuer die Belegsortierung vorgab.
 */
function sortiereFuerAusgabe(a: Position, b: Position): number {
  if (a.datum !== b.datum) return a.datum.localeCompare(b.datum);
  if (a.typ !== b.typ) return a.typ === 'AUSGANG' ? -1 : 1;
  return a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Deckblatt
// ---------------------------------------------------------------------------

function zeichneDeckblatt(
  doc: PDFDocument,
  monat: Monat,
  normal: PDFFont,
  fett: PDFFont,
  buero?: string,
): void {
  const seite = doc.addPage(A4);
  const { height, width } = seite.getSize();
  let y = height - RAND - 20;

  if (buero) {
    seite.drawText(buero, { x: RAND, y, size: 10, font: normal, color: rgb(0.4, 0.4, 0.4) });
    y -= 40;
  }

  seite.drawText('Belegabrechnung', { x: RAND, y, size: 26, font: fett });
  y -= 30;
  seite.drawText(monatsTitel(monat.monat), { x: RAND, y, size: 16, font: normal });
  y -= 14;

  seite.drawLine({
    start: { x: RAND, y },
    end: { x: width - RAND, y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });
  y -= 40;

  const s = monat.summen;
  const zeilen: Array<[string, string]> = [
    ['Einnahmen', euro(s.einnahmen)],
    ['Ausgaben', euro(s.ausgaben)],
    ['Saldo', euro(s.saldo)],
    ['', ''],
    ['Buchungen gesamt', String(s.anzahlGesamt)],
    ['davon vollstaendig belegt', String(s.anzahlOk)],
    ['davon mehrdeutig', String(s.anzahlMehrdeutig)],
    ['davon ohne Belegpflicht', String(s.anzahlOhneBelegpflicht)],
    ['darunter Umbuchungen', String(s.anzahlUmbuchungen)],
    ['davon ohne Beleg', String(s.anzahlOffen)],
    ['ausgeblendet', String(s.anzahlIgnoriert)],
  ];

  for (const [label, wert] of zeilen) {
    if (label) {
      const istSaldo = label === 'Saldo';
      seite.drawText(label, { x: RAND, y, size: 11, font: istSaldo ? fett : normal });
      seite.drawText(wert, {
        x: width - RAND - normal.widthOfTextAtSize(wert, 11) - 4,
        y,
        size: 11,
        font: istSaldo ? fett : normal,
      });
    }
    y -= 20;
  }

  y -= 20;
  if (monat.kontoauszuege.length > 0) {
    seite.drawText(
      `Kontoauszuege: ${monat.kontoauszuege.map((k) => k.dateiname).join(', ')}`,
      { x: RAND, y, size: 9, font: normal, color: rgb(0.4, 0.4, 0.4) },
    );
    y -= 16;
  }

  // Ein unvollstaendiger Monat muss auf dem Deckblatt sichtbar sein - der
  // Skill verlangte diesen Hinweis ausdruecklich.
  if (s.anzahlOffen > 0 || s.anzahlMehrdeutig > 0) {
    y -= 10;
    seite.drawText(
      `Achtung: ${s.anzahlOffen} Buchung(en) ohne Beleg, ${s.anzahlMehrdeutig} mehrdeutig. ` +
        'Die Abrechnung ist unvollstaendig.',
      { x: RAND, y, size: 10, font: fett, color: rgb(0.7, 0.15, 0.15) },
    );
  }

  seite.drawText(`Erstellt am ${new Date().toLocaleDateString('de-DE')}`, {
    x: RAND,
    y: RAND,
    size: 8,
    font: normal,
    color: rgb(0.55, 0.55, 0.55),
  });
}

// ---------------------------------------------------------------------------
// Kontoauszuege
// ---------------------------------------------------------------------------

async function haengeKontoauszuegeAn(
  doc: PDFDocument,
  auszuege: Kontoauszug[],
  ladeDatei: (id: string) => Promise<Buffer>,
  font: PDFFont,
): Promise<void> {
  for (const auszug of auszuege) {
    let bytes: Buffer;
    try {
      bytes = await ladeDatei(auszug.id);
    } catch {
      continue;
    }

    const seiten = await kopiereSeiten(doc, bytes);
    for (const seite of seiten) {
      kopfzeile(seite, `Kontoauszug - ${auszug.dateiname}`, font);
    }
  }
}

// ---------------------------------------------------------------------------
// Monatsjournal
// ---------------------------------------------------------------------------

function zeichneJournal(
  doc: PDFDocument,
  positionen: Position[],
  normal: PDFFont,
  fett: PDFFont,
): void {
  const spalten = [
    { titel: 'Nr.', x: RAND, breite: 30 },
    { titel: 'Datum', x: RAND + 32, breite: 58 },
    { titel: 'Betrag', x: RAND + 92, breite: 70, rechts: true },
    { titel: 'Verwendungszweck / Empfaenger', x: RAND + 168, breite: 210 },
    { titel: 'Aktenzeichen', x: RAND + 382, breite: 95 },
    { titel: 'Beleg', x: RAND + 480, breite: 45 },
  ];

  let seite = doc.addPage(A4);
  let y = seite.getSize().height - RAND;

  const kopf = () => {
    seite.drawText('Monatsjournal', { x: RAND, y, size: 14, font: fett });
    y -= 22;
    for (const sp of spalten) {
      seite.drawText(sp.titel, { x: sp.x, y, size: 8, font: fett, color: rgb(0.3, 0.3, 0.3) });
    }
    y -= 4;
    seite.drawLine({
      start: { x: RAND, y },
      end: { x: A4[0] - RAND, y },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    y -= 12;
  };

  kopf();

  positionen.forEach((p, i) => {
    if (y < RAND + 40) {
      seite = doc.addPage(A4);
      y = seite.getSize().height - RAND;
      kopf();
    }

    const betrag = euro(p.betrag);
    const werte: Array<[(typeof spalten)[number], string]> = [
      [spalten[0]!, String(i + 1)],
      [spalten[1]!, deutschesDatum(p.datum)],
      [spalten[2]!, betrag],
      [
        spalten[3]!,
        kuerze(p.verwendungszweck || p.gegenkonto || '-', spalten[3]!.breite, normal, 8),
      ],
      [spalten[4]!, p.aktenzeichen?.normalisiert ?? '-'],
      [spalten[5]!, belegKuerzel(p)],
    ];

    for (const [sp, wert] of werte) {
      const x = sp.rechts ? sp.x + sp.breite - normal.widthOfTextAtSize(wert, 8) : sp.x;
      seite.drawText(wert, {
        x,
        y,
        size: 8,
        font: normal,
        color: p.betrag < 0 ? rgb(0.55, 0.1, 0.1) : rgb(0, 0, 0),
      });
    }
    y -= 14;
  });
}

function belegKuerzel(p: Position): string {
  if (p.dateien.length === 0 && p.markierung) {
    return { privatentnahme: 'privat', dauerbeleg: 'Dauerbeleg', umbuchung: 'Umbuchung' }[
      p.markierung
    ];
  }
  if (p.status === 'offen' || p.dateien.length === 0) return 'fehlt';
  if (p.status === 'mehrdeutig') return `${p.dateien.length}x ?`;
  return p.dateien.length > 1 ? `${p.dateien.length}x` : 'ja';
}

// ---------------------------------------------------------------------------
// Belege
// ---------------------------------------------------------------------------

async function haengeBelegeAn(
  doc: PDFDocument,
  positionen: NummeriertePosition[],
  ladeDatei: (id: string) => Promise<Buffer>,
  font: PDFFont,
): Promise<void> {
  for (const { nummer, position } of positionen) {
    for (const datei of position.dateien) {
      let bytes: Buffer;
      try {
        bytes = await ladeDatei(datei.id);
      } catch {
        continue;
      }

      const beschriftung =
        `Pos. ${nummer}  |  ${deutschesDatum(position.datum)}  |  ${euro(position.betrag)}` +
        (position.aktenzeichen ? `  |  ${position.aktenzeichen.normalisiert}` : '') +
        `  |  ${datei.dateiname}`;

      if (datei.mimeType.startsWith('image/')) {
        await haengeBildAn(doc, bytes, datei.mimeType, beschriftung, font);
      } else {
        const seiten = await kopiereSeiten(doc, bytes);
        for (const seite of seiten) kopfzeile(seite, beschriftung, font);
      }
    }
  }
}

/** Kopiert alle Seiten eines PDFs in das Zieldokument. */
async function kopiereSeiten(ziel: PDFDocument, bytes: Buffer): Promise<PDFPage[]> {
  try {
    const quelle = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const kopien = await ziel.copyPages(quelle, quelle.getPageIndices());
    for (const seite of kopien) ziel.addPage(seite);
    return kopien;
  } catch {
    // Beschaedigte oder passwortgeschuetzte Datei: nicht die ganze Abrechnung
    // scheitern lassen, sondern ueberspringen. Der Report weist sie ohnehin aus.
    return [];
  }
}

async function haengeBildAn(
  doc: PDFDocument,
  bytes: Buffer,
  mimeType: string,
  beschriftung: string,
  font: PDFFont,
): Promise<void> {
  try {
    const bild = mimeType.includes('png')
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);

    const seite = doc.addPage(A4);
    const maxBreite = A4[0] - 2 * RAND;
    const maxHoehe = A4[1] - 2 * RAND - 30;
    const skala = Math.min(maxBreite / bild.width, maxHoehe / bild.height, 1);

    seite.drawImage(bild, {
      x: (A4[0] - bild.width * skala) / 2,
      y: (A4[1] - bild.height * skala) / 2 - 10,
      width: bild.width * skala,
      height: bild.height * skala,
    });
    kopfzeile(seite, beschriftung, font);
  } catch {
    // Nicht einbettbares Bildformat - ueberspringen.
  }
}

/** Graue Kopfzeile mit Positionsbezug auf einer uebernommenen Seite. */
function kopfzeile(seite: PDFPage, text: string, font: PDFFont): void {
  const { height, width } = seite.getSize();
  const groesse = 7;

  seite.drawRectangle({
    x: 0,
    y: height - 16,
    width,
    height: 16,
    color: rgb(0.94, 0.94, 0.94),
    opacity: 0.9,
  });
  seite.drawText(kuerze(text, width - 20, font, groesse), {
    x: 10,
    y: height - 11.5,
    size: groesse,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });
}

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

function euro(betrag: number): string {
  const formatiert = new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(betrag));
  // WinAnsi kennt kein "€"-Zeichen in allen Standardfonts zuverlaessig.
  return `${betrag < 0 ? '-' : ''}${formatiert} EUR`;
}

function deutschesDatum(iso: string): string {
  const [j, m, t] = iso.split('-');
  return `${t}.${m}.${j}`;
}

function monatsTitel(monat: string): string {
  const namen = [
    'Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  const [jahr, mon] = monat.split('-');
  return `${namen[Number(mon) - 1] ?? monat} ${jahr}`;
}

/** Kuerzt Text auf die verfuegbare Breite und haengt ein Auslassungszeichen an. */
function kuerze(text: string, maxBreite: number, font: PDFFont, groesse: number): string {
  const sauber = entferneUnbekannteZeichen(text);
  if (font.widthOfTextAtSize(sauber, groesse) <= maxBreite) return sauber;

  let ergebnis = sauber;
  while (ergebnis.length > 1 && font.widthOfTextAtSize(`${ergebnis}...`, groesse) > maxBreite) {
    ergebnis = ergebnis.slice(0, -1);
  }
  return `${ergebnis}...`;
}

/**
 * Die PDF-Standardfonts koennen nur WinAnsi. Zeichen ausserhalb davon
 * (etwa Emojis oder kyrillische Buchstaben in Verwendungszwecken) wuerden
 * pdf-lib beim Zeichnen zum Absturz bringen.
 */
function entferneUnbekannteZeichen(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}
