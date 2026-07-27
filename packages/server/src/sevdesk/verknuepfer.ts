import type {
  Aktenzeichen,
  BuchungsTyp,
  MonatsSummen,
  Position,
  SevdeskStatus,
} from '@abrechnung/shared';
import {
  extrahiereAusVerwendungszweck,
  parseAktenzeichen,
} from '../aktenzeichen/index.js';
import type { CheckAccountTransaction, Invoice, Voucher } from './types.js';

/**
 * Baut aus den Rohdaten von sevDesk die Positionsliste eines Monats.
 *
 * Bewusst frei von Netzwerkzugriffen: die Zuordnungsregeln lassen sich damit
 * ohne sevDesk-Zugang testen.
 */

export interface VerknuepfungsEingabe {
  transaktionen: CheckAccountTransaction[];
  vouchers: Voucher[];
  invoices: Invoice[];
  /** Buchungs-ID -> Beleg-ID, aufgebaut aus /Voucher/{id}/getCheckAccountTransactions */
  voucherProTransaktion: Map<string, string>;
  /** Buchungs-ID -> Rechnungs-ID, aus /Invoice/{id}/getCheckAccountTransactions */
  invoiceProTransaktion: Map<string, string>;
}

export function baueBelege(eingabe: VerknuepfungsEingabe): Position[] {
  const invoiceNachId = new Map(eingabe.invoices.map((i) => [i.id, i]));
  const voucherNachId = new Map(eingabe.vouchers.map((v) => [v.id, v]));

  // Fallback-Index: Aktenzeichen -> Rechnung. Greift, wenn sevDesk keine
  // Zahlungsverknuepfung kennt, das Aktenzeichen aber im Verwendungszweck steht.
  const invoiceNachAktenzeichen = new Map<string, Invoice>();
  for (const inv of eingabe.invoices) {
    const az = inv.invoiceNumber ? parseAktenzeichen(inv.invoiceNumber, 'sevdesk-invoice') : null;
    if (az) invoiceNachAktenzeichen.set(az.normalisiert, inv);
  }

  return eingabe.transaktionen
    .map((tx) => baueEinePosition(tx, eingabe, { invoiceNachId, voucherNachId, invoiceNachAktenzeichen }))
    .sort((a, b) => (a.datum === b.datum ? a.id.localeCompare(b.id) : a.datum.localeCompare(b.datum)));
}

interface Indizes {
  invoiceNachId: Map<string, Invoice>;
  voucherNachId: Map<string, Voucher>;
  invoiceNachAktenzeichen: Map<string, Invoice>;
}

function baueEinePosition(
  tx: CheckAccountTransaction,
  eingabe: VerknuepfungsEingabe,
  idx: Indizes,
): Position {
  const betrag = Number.parseFloat(tx.amount);
  const typ: BuchungsTyp = betrag >= 0 ? 'EINGANG' : 'AUSGANG';
  const datum = tx.valueDate.slice(0, 10);
  const verwendungszweck = tx.paymtPurpose ?? '';
  const sevdeskStatus = leseSevdeskStatus(tx.status);

  const voucherId = eingabe.voucherProTransaktion.get(tx.id);
  let invoiceId = eingabe.invoiceProTransaktion.get(tx.id);

  // Schritt 1: Aktenzeichen aus der verknuepften Rechnung - das ist die
  // verlaessliche Quelle, weil sevDesk die Nummer selbst vergeben hat.
  let aktenzeichen: Aktenzeichen | undefined;
  let kandidaten: string[] | undefined;
  let hinweis: string | undefined;

  if (invoiceId) {
    const inv = idx.invoiceNachId.get(invoiceId);
    const az = inv?.invoiceNumber
      ? parseAktenzeichen(inv.invoiceNumber, 'sevdesk-invoice')
      : null;
    if (az) aktenzeichen = az;
  }

  // Schritt 2: Nur wenn keine Verknuepfung greift, den Verwendungszweck parsen.
  if (!aktenzeichen && typ === 'EINGANG') {
    const ergebnis = extrahiereAusVerwendungszweck(verwendungszweck, datum);

    if (ergebnis.treffer.length === 1) {
      aktenzeichen = ergebnis.treffer[0];
    } else if (ergebnis.treffer.length > 1) {
      // Sammelzahlung ueber mehrere Rechnungen: erstes AZ fuehrt, Rest als Kandidaten.
      aktenzeichen = ergebnis.treffer[0];
      kandidaten = ergebnis.treffer.map((t) => t.normalisiert);
      hinweis = `Mehrere Aktenzeichen im Verwendungszweck: ${kandidaten.join(', ')}`;
    } else if (ergebnis.mehrdeutig) {
      hinweis =
        'Aktenzeichen-aehnliche Zeichenfolge gefunden, aber nicht aufloesbar - bitte pruefen';
    } else {
      hinweis = 'Kein Aktenzeichen im Verwendungszweck erkannt';
    }

    // Wenn das geparste AZ auf eine bekannte Rechnung zeigt, die Verknuepfung
    // nachtragen - dann steht spaeter auch die sevDesk-Rechnung zur Verfuegung.
    if (aktenzeichen && !invoiceId) {
      const inv = idx.invoiceNachAktenzeichen.get(aktenzeichen.normalisiert);
      if (inv) {
        invoiceId = inv.id;
        aktenzeichen = { ...aktenzeichen, herkunft: 'sevdesk-invoice' };
        hinweis = undefined;
      }
    }
  }

  // Eine Buchung ohne Beleg hat zwei sehr verschiedene Ursachen. Der Hinweis
  // muss sagen, wo die Korrektur hingehoert - in sevDesk oder hier.
  if (!voucherId && !invoiceId) {
    if (sevdeskStatus === 'offen') {
      hinweis =
        'In sevDesk noch nicht zugeordnet. Dort verbuchen, danach diesen Monat neu laden.';
    } else if (sevdeskStatus === 'privat') {
      hinweis = 'In sevDesk als privat markiert.';
    } else if (typ === 'AUSGANG') {
      hinweis = 'Kein Beleg in sevDesk verknuepft';
    }
  }

  const voucher = voucherId ? idx.voucherNachId.get(voucherId) : undefined;
  const invoice = invoiceId ? idx.invoiceNachId.get(invoiceId) : undefined;

  return {
    id: tx.id,
    datum,
    betrag,
    waehrung: tx.currency ?? 'EUR',
    verwendungszweck,
    gegenkonto: tx.payeePayerName ?? voucher?.supplierName ?? undefined,
    typ,
    sevdeskStatus,
    voucherId,
    invoiceId,
    rechnungsnummer: invoice?.invoiceNumber ?? undefined,
    aktenzeichen,
    aktenzeichenKandidaten: kandidaten,
    // Dateien werden erst im naechsten Schritt (Download) befuellt.
    dateien: [],
    status: 'offen',
    hinweis,
    manuellBestaetigt: false,
  };
}

/**
 * Setzt den Ampelstatus anhand der tatsaechlich vorhandenen Dateien.
 *
 * `statusManuellGesetzt` darf nur true sein, wenn der Nutzer den Status selbst
 * bestimmt hat. Es genuegt ausdruecklich NICHT, dass irgendeine Korrektur an
 * der Position vorliegt: wer einen Beleg nachreicht oder aus den Kandidaten
 * waehlt, erwartet, dass die Ampel danach auf gruen springt.
 */
const MARKIERUNGS_HINWEIS: Record<NonNullable<Position['markierung']>, string> = {
  privatentnahme: 'Privatentnahme - kein Beleg erforderlich',
  dauerbeleg: 'Dauerbeleg - der Beleg liegt einmalig vor (Vertrag, Abo)',
  umbuchung: 'Umbuchung zwischen eigenen Konten - kein Beleg erforderlich',
};

export function aktualisiereStatus(
  position: Position,
  statusManuellGesetzt = false,
): Position {
  if (position.status === 'ignoriert' || statusManuellGesetzt) {
    return position;
  }

  if (position.dateien.length === 0) {
    // Markierte Buchungen brauchen keinen Beleg - sie bleiben aber Teil der
    // Abrechnung, anders als eine ausgeblendete Buchung.
    if (position.markierung) {
      return {
        ...position,
        status: 'ok',
        hinweis: MARKIERUNGS_HINWEIS[position.markierung],
      };
    }
    return { ...position, status: 'offen' };
  }

  // Hat der Nutzer bereits gewaehlt, ist nichts mehr mehrdeutig - auch wenn
  // weitere Kandidaten zur Ansicht stehenbleiben.
  if (position.auswahlBestaetigt) {
    return { ...position, status: 'ok' };
  }

  const offeneAuswahl =
    (position.kandidaten?.length ?? 0) > 0 ||
    (position.aktenzeichenKandidaten?.length ?? 0) > 1;

  return { ...position, status: offeneAuswahl ? 'mehrdeutig' : 'ok' };
}

/** sevDesk-Statuscode der Buchung in eine sprechende Form uebersetzen. */
function leseSevdeskStatus(code: string | null | undefined): SevdeskStatus {
  switch (String(code ?? '')) {
    case '100':
      return 'offen';
    case '200':
      return 'verknuepft';
    case '300':
      return 'privat';
    case '400':
      return 'verbucht';
    default:
      return 'unbekannt';
  }
}

export function berechneSummen(positionen: Position[]): MonatsSummen {
  const relevant = positionen.filter((p) => p.status !== 'ignoriert');

  let einnahmen = 0;
  let ausgaben = 0;
  for (const p of relevant) {
    if (p.betrag >= 0) einnahmen += p.betrag;
    else ausgaben += Math.abs(p.betrag);
  }

  const zaehle = (s: Position['status']) =>
    positionen.filter((p) => p.status === s).length;

  return {
    einnahmen: runde(einnahmen),
    ausgaben: runde(ausgaben),
    saldo: runde(einnahmen - ausgaben),
    anzahlGesamt: positionen.length,
    anzahlOk: zaehle('ok'),
    anzahlMehrdeutig: zaehle('mehrdeutig'),
    anzahlOffen: zaehle('offen'),
    anzahlIgnoriert: zaehle('ignoriert'),
    anzahlNichtZugeordnet: relevant.filter((p) => p.sevdeskStatus === 'offen').length,
    anzahlOhneBelegpflicht: relevant.filter(
      (p) => p.markierung && p.dateien.length === 0,
    ).length,
    anzahlUmbuchungen: relevant.filter((p) => p.markierung === 'umbuchung').length,
  };
}

function runde(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Baut aus den Belegen/Rechnungen die Rueckwaerts-Indizes Buchung -> Beleg auf.
 * `lade` kapselt den jeweiligen sevDesk-Aufruf, damit die Funktion testbar bleibt.
 */
export async function baueTransaktionsIndex(
  ids: string[],
  lade: (id: string) => Promise<CheckAccountTransaction[]>,
  parallel = 6,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const warteschlange = [...ids];

  const arbeiter = Array.from({ length: Math.min(parallel, warteschlange.length) }, async () => {
    for (;;) {
      const id = warteschlange.shift();
      if (id === undefined) return;
      const transaktionen = await lade(id);
      for (const tx of transaktionen) {
        // Erste Zuordnung gewinnt: eine Buchung sollte genau einen Beleg haben.
        if (!index.has(tx.id)) index.set(tx.id, id);
      }
    }
  });

  await Promise.all(arbeiter);
  return index;
}
