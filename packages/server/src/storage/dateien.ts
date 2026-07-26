import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

    if (!existsSync(pfad)) {
      await writeFile(pfad, daten);
    }

    return {
      id,
      dateiname,
      groesse: daten.byteLength,
      mimeType,
      quelle,
      seiten: mimeType === 'application/pdf' ? zaehleSeiten(daten) : undefined,
    };
  }

  async lese(monat: string, dateiId: string): Promise<Buffer> {
    return readFile(await this.pfadFuer(monat, dateiId));
  }

  async existiert(monat: string, dateiId: string): Promise<boolean> {
    return existsSync(await this.pfadFuer(monat, dateiId));
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
 * Zaehlt Seiten eines PDFs anhand der /Type /Page-Eintraege.
 * Bewusst ohne pdf-lib, weil das hier synchron und guenstig sein soll;
 * fuer die Anzeige reicht die Naeherung. Der exakte Wert entsteht beim
 * Zusammenbau in pdf/build.ts.
 */
function zaehleSeiten(daten: Buffer): number | undefined {
  const text = daten.subarray(0, Math.min(daten.length, 5_000_000)).toString('latin1');
  const treffer = text.match(/\/Type\s*\/Page[^s]/g);
  return treffer ? treffer.length : undefined;
}
