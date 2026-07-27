import { PDFDocument } from 'pdf-lib';

/**
 * Fasst die Seiten eines Belegs zu einer Datei zusammen.
 *
 * sevDesk liefert zu einem Beleg nicht eine Datei, sondern seine Seiten: eine
 * gescannte Tankquittung kommt als Vorder- und Rueckseite, ein Kreditvertrag
 * schon mal als zweiunddreissig Einzelseiten. Jede davon als eigenen Beleg zu
 * fuehren ist falsch - in der Tabelle stand dann "32 Dateien" an einer Buchung,
 * die Ablage haette 32 Dateien nach OneDrive geschoben und die KI haette den
 * Vertrag zweiunddreissig Mal ausgelesen.
 *
 * Deshalb: ein Beleg, eine Datei, alle Seiten darin - in der Reihenfolge, in
 * der sevDesk sie geliefert hat.
 */

/** Die Form, in der Dateien durch den sevDesk-Client laufen. */
export interface Seitendatei {
  daten: Buffer;
  dateiname: string;
  mimeType: string;
}

/** Bildformate, die pdf-lib einbetten kann. Alles andere bleibt eigenstaendig. */
const EINBETTBAR = /^image\/(png|jpe?g)$/;

const A4: [number, number] = [595.28, 841.89];
const RAND = 24;

export interface BundOptionen {
  /** Name der zusammengefassten Datei. */
  dateiname: string;
  log?: { warn: (o: unknown, m?: string) => void };
}

/**
 * Aus mehreren Seiten wird eine PDF-Datei.
 *
 * Laesst sich auch nur eine Seite nicht einbetten - ein TIFF etwa, oder ein
 * beschaedigtes PDF -, bleibt es beim urspruenglichen Satz. Lieber mehrere
 * Dateien als eine, in der eine Seite fehlt: die Abrechnung muss vollstaendig
 * sein, die Anzahl der Dateien ist nur Kosmetik.
 */
export async function fasseSeitenZusammen(
  seiten: Seitendatei[],
  opts: BundOptionen,
): Promise<Seitendatei[]> {
  if (seiten.length <= 1) return seiten;

  const einbettbar = seiten.every(
    (s) => s.mimeType === 'application/pdf' || EINBETTBAR.test(s.mimeType),
  );
  if (!einbettbar) return seiten;

  try {
    const doc = await PDFDocument.create();

    for (const seite of seiten) {
      if (seite.mimeType === 'application/pdf') {
        const quelle = await PDFDocument.load(seite.daten, { ignoreEncryption: true });
        // Ein PDF ohne Seiten waere eine stillschweigend verlorene Seite.
        if (quelle.getPageCount() === 0) return seiten;
        for (const kopie of await doc.copyPages(quelle, quelle.getPageIndices())) {
          doc.addPage(kopie);
        }
      } else {
        await legeBildAufSeite(doc, seite);
      }
    }

    if (doc.getPageCount() === 0) return seiten;

    return [
      {
        daten: Buffer.from(await doc.save()),
        dateiname: opts.dateiname,
        mimeType: 'application/pdf',
      },
    ];
  } catch (err) {
    opts.log?.warn(
      { anzahl: seiten.length, err: err instanceof Error ? err.message : String(err) },
      'Belegseiten liessen sich nicht zusammenfassen, bleiben einzeln',
    );
    return seiten;
  }
}

/** Ein Scan wird zu einer A4-Seite, eingepasst und mittig. */
async function legeBildAufSeite(doc: PDFDocument, seite: Seitendatei): Promise<void> {
  const bild = seite.mimeType.includes('png')
    ? await doc.embedPng(seite.daten)
    : await doc.embedJpg(seite.daten);

  const blatt = doc.addPage(A4);
  const skala = Math.min(
    (A4[0] - 2 * RAND) / bild.width,
    (A4[1] - 2 * RAND) / bild.height,
    1,
  );

  blatt.drawImage(bild, {
    x: (A4[0] - bild.width * skala) / 2,
    y: (A4[1] - bild.height * skala) / 2,
    width: bild.width * skala,
    height: bild.height * skala,
  });
}
