import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { BelegDatei, BelegQuelle } from '@abrechnung/shared';
import type { Datenbank } from '../db/index.js';
import { erkenneSignatur } from '../sevdesk/client.js';

/**
 * Dateiablage fuer heruntergeladene Belege und hochgeladene Kontoauszuege.
 *
 * Die Dateien liegen in der Datenbank. Vorher lagen sie unter
 * `$DATA_DIR/monate/<YYYY-MM>/<dateiId>`, wo kein Backup sie erfasste; bei
 * gemessenen 38 MB Gesamtbestand ist ein `pg_dump` jetzt der vollstaendige
 * Sicherungspunkt.
 *
 * Der Weg auf die Platte bleibt daneben bestehen, und zwar in beide
 * Richtungen: gelesen wird von dort, was in der Datenbank (noch) fehlt, und
 * geschrieben wird weiterhin auch dorthin. Damit findet eine zurueckgerollte
 * Fassung ihren Bestand unveraendert vor. Der Ausbau ist ein spaeterer,
 * eigener Schritt.
 *
 * Ablage nach Monat, damit ein Monat als Ganzes verworfen und neu geladen
 * werden kann, ohne andere Monate anzufassen.
 */
export class Dateiablage {
  constructor(
    private readonly wurzel: string,
    private readonly db: Datenbank,
  ) {}

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

    await this.db.speichereDatei(monat, id, daten);
    await this.legeAufPlatteAb(monat, id, daten);

    return {
      id,
      dateiname,
      groesse: daten.byteLength,
      mimeType,
      quelle,
      seiten: mimeType.includes('pdf') ? await zaehleSeiten(daten) : undefined,
    };
  }

  /**
   * Zweitschrift auf der Platte.
   *
   * Sie wird nicht mehr gelesen, solange die Datenbank die Datei kennt. Sie
   * bleibt, damit ein Rueckrollen auf die vorige Fassung den Bestand
   * vollstaendig vorfindet. Schlaegt das Schreiben fehl - kein eingebundenes
   * Verzeichnis, volle Platte -, ist das kein Grund, den Abruf scheitern zu
   * lassen: die Datei liegt bereits in der Datenbank.
   */
  private async legeAufPlatteAb(monat: string, id: string, daten: Buffer): Promise<void> {
    try {
      await mkdir(this.monatsPfad(monat), { recursive: true });
      const pfad = await this.pfadFuer(monat, id);
      if (!existsSync(pfad) || (await stat(pfad)).size !== daten.byteLength) {
        await writeFile(pfad, daten);
      }
    } catch {
      // Bewusst still: die Datenbank ist die Wahrheit.
    }
  }

  async lese(monat: string, dateiId: string): Promise<Buffer> {
    const ausDerDatenbank = await this.db.ladeDatei(monat, dateiId);
    if (ausDerDatenbank) return ausDerDatenbank;
    // Noch nicht uebertragen - dann von der Platte.
    return readFile(await this.pfadFuer(monat, dateiId));
  }

  async existiert(monat: string, dateiId: string): Promise<boolean> {
    if (await this.db.dateiVorhanden(monat, dateiId)) return true;
    return existsSync(await this.pfadFuer(monat, dateiId));
  }

  /**
   * Prueft, ob unter der ID tatsaechlich das steht, was der Name verspricht.
   *
   * Anlass: sevDesk hat Belege schon als blanken base64-Text geliefert, der
   * ungeprueft als "…​.pdf" abgelegt wurde. Herunterladen liess er sich,
   * oeffnen nicht. Solche Dateien sollen beim naechsten Laden ersetzt werden,
   * ohne dass jemand von Hand nachhelfen muss.
   *
   * Gelesen werden nur die ersten Bytes - das kostet auch bei vielen Belegen
   * nichts Nennenswertes.
   */
  async istUnversehrt(monat: string, datei: BelegDatei): Promise<boolean> {
    const kopf = (await this.db.dateiKopf(monat, datei.id)) ?? (await this.kopfVonPlatte(monat, datei.id));
    if (!kopf || kopf.byteLength < 4) return false;

    // Irgendein bekanntes Dateiformat genuegt. Die Endung taugt als Massstab
    // nicht: ein Beleg, den sevDesk als Bild liefert, bekommt trotzdem den
    // Namen "beleg-123.pdf" - er waere dauerhaft als kaputt gegolten und bei
    // jedem Laden erneut geholt worden.
    return erkenneSignatur(kopf) !== undefined;
  }

  private async kopfVonPlatte(monat: string, dateiId: string): Promise<Buffer | null> {
    try {
      const inhalt = await readFile(await this.pfadFuer(monat, dateiId));
      return inhalt.subarray(0, 12);
    } catch {
      return null;
    }
  }

  async loesche(monat: string, dateiId: string): Promise<void> {
    await this.db.loescheDatei(monat, dateiId);
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
