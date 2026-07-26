/**
 * Ausschnitt der sevDesk-Datentypen, den diese Anwendung tatsaechlich nutzt.
 * sevDesk liefert deutlich mehr Felder; hier stehen nur die verwendeten.
 *
 * Konventionen der API:
 *  - Alle Antworten sind in { "objects": ... } gekapselt
 *  - Zahlen kommen als Strings ("892.50")
 *  - Verknuepfungen sind { id, objectName }-Paare
 */

export interface SevDeskAntwort<T> {
  objects: T;
}

export interface SevDeskReferenz {
  id: string;
  objectName: string;
}

export interface CheckAccount {
  id: string;
  objectName: 'CheckAccount';
  name: string;
  /** "online" = per Bankschnittstelle angebunden, "offline" = manuell gepflegt */
  type: string;
  /** "100" = aktiv, "0" = archiviert */
  status: string;
  currency: string;
  iban?: string | null;
  /** "1" bei Kassenkonto */
  bankServer?: string | null;
}

export interface CheckAccountTransaction {
  id: string;
  objectName: 'CheckAccountTransaction';
  /** Wertstellung, ISO 8601 mit Zeitzone */
  valueDate: string;
  /** Buchungstag */
  entryDate?: string | null;
  /** Betrag als String, positiv = Eingang */
  amount: string;
  /** Verwendungszweck */
  paymtPurpose?: string | null;
  /** Name des Zahlenden bzw. Empfaengers */
  payeePayerName?: string | null;
  payeePayerAcctNo?: string | null;
  /**
   * 100 = offen/unbezahlt, 200 = verknuepft (linked), 300 = privat, 400 = verbucht.
   * Ein Wert >= 200 bedeutet, dass eine Verknuepfung existieren sollte.
   */
  status: string;
  checkAccount: SevDeskReferenz;
  currency?: string | null;
}

export interface Voucher {
  id: string;
  objectName: 'Voucher';
  /** Belegdatum */
  voucherDate?: string | null;
  /** Beschreibung/Belegnummer */
  description?: string | null;
  /** Bruttobetrag als String */
  sumGross?: string | null;
  sumNet?: string | null;
  sumTax?: string | null;
  /** 50 = Entwurf, 100 = offen, 1000 = bezahlt */
  status: string;
  /** "VOU" = Beleg (Eingangsrechnung), "RV" = wiederkehrend */
  voucherType?: string | null;
  /** Lieferant */
  supplier?: SevDeskReferenz | null;
  supplierName?: string | null;
  /** Verknuepftes Dokument - nur vorhanden, wenn eine Datei angehaengt ist */
  document?: SevDeskReferenz | null;
}

export interface Invoice {
  id: string;
  objectName: 'Invoice';
  /** Rechnungsnummer - hier steht das Aktenzeichen, z. B. "0126/1800TG01" */
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  /** Bruttobetrag als String */
  sumGross?: string | null;
  sumNet?: string | null;
  /** 100 = Entwurf, 200 = offen, 1000 = bezahlt */
  status: string;
  contact?: SevDeskReferenz | null;
  header?: string | null;
}

/** Antwort von GET /Voucher/{id}/getDocumentImage */
export interface DokumentBild {
  /** Base64-kodierter Dateiinhalt */
  content?: string | null;
  filename?: string | null;
  /** sevDesk liefert hier "true" als String, wenn content Base64 ist */
  base64encoded?: boolean | string | null;
  mimeType?: string | null;
}

/** Antwort von GET /Invoice/{id}/getPdf?download=false */
export interface RechnungsPdf {
  filename?: string | null;
  /** Base64-kodiertes PDF */
  content?: string | null;
  base64encoded?: boolean | string | null;
  mimeType?: string | null;
}
