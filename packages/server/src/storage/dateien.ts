import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { BelegDatei, BelegQuelle } from '@abrechnung/shared';

/**
 * Dateiablage fuer heruntergeladene Belege, hochgeladene Kontoauszuege und
 * erzeugte Abrechnungs-PDFs.
 *
 * Ablage nach Monat, damit ein Monat als Ganzes verworfen und neu geladen
 * werden kann, ohne andere Monate anzufassen.
 */
export class Dateiablage {
  constructor(private readonly wurzel: string) {}

  private monatsPfad(monat: string): string {
    // monat ist immer "YYYY-MM" (durch istGueltigerMonat geprueft), damit ist
    // hier kein Traversal moeglich. Trotzdem defensiv aufloesen.
    const pfad = resolve(join(this.wurzel, 'monate', monat));
    if (!pfad.startsWith(resolve(this.wurzel))) {
      throw new Error(`Ungueltiger Monatspfad: ${monat}`);
    }
    return pfad;
  }

  async pfadFuer(monat: string, dateiId: string): Promise<string> {
    const basis = this.monatsPfad(monat);
    const pfad = resolve(join(basis, dateiId));
    if (!pfad.startsWith(basis)) {
      throw new Error(`Ungueltige Datei-ID: ${dateiId}`);
    }
    return pfad;
  }

  /**
   * Legt eine Datei ab. Die ID ergibt sich aus dem Inhalts-Hash, wodurch
   * identische Dateien nicht doppelt gespeichert werden und ein erneuter
   * Abruf idempotent bleibt.
   */
  async speichere(
    monat: string,
    daten: Buffer,
    dateiname: string,
    quelle: BelegQuelle,
    mimeType = 'application/pdf',
  ): Promise<BelegDatei> {
    const hash = createHash('sha256').update(daten).digest('hex').slice(0, 16);
    const endung = dateiname.includes('.') ? dateiname.slice(dateiname.lastIndexOf('.')) : '.pdf';
    const id = `${hash}${endung}`;

    const basis = this.monatsPfad(monat);
    await mkdir(basis, { recursive: true });
    const pfad = await this.pfadFuer(monat, id);

    // Die ID ist der Inhalts-Hash, eine vorhandene Datei sollte also identisch
    // sein. Weicht die Groesse ab, ist sie es nicht - etwa nach einem
    // abgebrochenen Schreibvorgang oder weil frueher der falsche Inhalt
    // abgelegt wurde. Dann neu schreiben statt der alten Fassung zu vertrauen.
    if (!existsSync(pfad) || (await stat(pfad)).size !== daten.byteLength) {
      await writeFile(pfad, daten);
    }

    return {
      id,
      dateiname,
      groesse: daten.byteLength,
      mimeType,
      quelle,
      seiten: mimeType.includes('pdf') ? await zaehleSeiten(daten) : undefined,
    };
  }

  async lese(monat: string, dateiId: string): Promise<Buffer> {
    return readFile(await this.pfadFuer(monat, dateiId));
  }

  async existiert(monat: string, dateiId: string): Promise<boolean> {
    return existsSync(await this.pfadFuer(monat, dateiId));
  }

  /**
   * Prueft, ob unter der ID tatsaechlich das steht, was der Name verspricht.
   *
   * Anlass: sevDesk hat Belege schon als blanken base64-Text geliefert, der
   * ungeprueft als "…​.pdf" auf der Platte landete. Herunterladen liess er sich,
   * oeffnen nicht. Solche Dateien sollen beim naechsten Laden ersetzt werden,
   * ohne dass jemand von Hand nachhelfen muss.
   *
   * Gelesen werden nur die ersten Bytes - das kostet auch bei vielen Belegen
   * nichts Nennenswertes.
   */
  async istUnversehrt(monat: string, datei: BelegDatei): Promise<boolean> {
    if (!/\.pdf$/i.test(datei.dateiname) && !/\.pdf$/i.test(datei.id)) return true;

    let griff;
    try {
      griff = await open(await this.pfadFuer(monat, datei.id), 'r');
      const puffer = Buffer.alloc(5);
      const { bytesRead } = await griff.read(puffer, 0, 5, 0);
      return bytesRead === 5 && puffer.toString('latin1') === '%PDF-';
    } catch {
      return false;
    } finally {
      await griff?.close();
    }
  }

  async loesche(monat: string, dateiId: string): Promise<void> {
    const pfad = await this.pfadFuer(monat, dateiId);
    if (existsSync(pfad)) await unlink(pfad);
  }

  /** Ablageort fuer erzeugte Abrechnungs-PDFs. */
  async ausgabePfad(monat: string, dateiname: string): Promise<string> {
    const basis = resolve(join(this.wurzel, 'ausgabe'));
    await mkdir(basis, { recursive: true });
    const sicher = dateiname.replace(/[^\w.\-]/g, '_');
    return join(basis, `${monat}_${sicher}`);
  }
}

/**
 * Zaehlt die Seiten eines PDFs.
 *
 * Ueber pdf-lib statt per Regex auf den Rohbytes: moderne PDFs legen den
 * Seitenbaum in komprimierten Objektstroemen ab, wo ein Textmuster wie
 * "/Type /Page" schlicht nicht auftaucht. Die Seitenzahl ist die Grundlage
 * fuer die Vorschau und die Reihenfolge im Abrechnungs-PDF - sie darf nicht
 * an der Kompression scheitern.
 */
async function zaehleSeiten(daten: Buffer): Promise<number | undefined> {
  try {
    const doc = await PDFDocument.load(daten, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    // Beschaedigtes oder passwortgeschuetztes PDF - die Datei wird trotzdem
    // abgelegt, nur ohne Seitenangabe.
    return undefined;
  }
}
