import { describe, expect, it } from 'vitest';
import {
  aktualisiereStatus,
  baueBelege,
  baueTransaktionsIndex,
  berechneSummen,
  type VerknuepfungsEingabe,
} from './verknuepfer.js';
import type { CheckAccountTransaction, Invoice, Voucher } from './types.js';
import type { Position } from '@abrechnung/shared';

function tx(
  teil: Partial<CheckAccountTransaction> & { id: string; amount: string },
): CheckAccountTransaction {
  return {
    objectName: 'CheckAccountTransaction',
    valueDate: '2026-06-03T00:00:00+02:00',
    status: '200',
    checkAccount: { id: '1234', objectName: 'CheckAccount' },
    ...teil,
  };
}

function invoice(teil: Partial<Invoice> & { id: string }): Invoice {
  return { objectName: 'Invoice', status: '1000', ...teil };
}

function voucher(teil: Partial<Voucher> & { id: string }): Voucher {
  return { objectName: 'Voucher', status: '1000', ...teil };
}

function eingabe(teil: Partial<VerknuepfungsEingabe> = {}): VerknuepfungsEingabe {
  return {
    transaktionen: [],
    vouchers: [],
    invoices: [],
    voucherProTransaktion: new Map(),
    invoiceProTransaktion: new Map(),
    ...teil,
  };
}

describe('baueBelege - Typisierung', () => {
  it('klassifiziert positive Betraege als EINGANG, negative als AUSGANG', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '892.50' }),
          tx({ id: 'b', amount: '-119.00' }),
        ],
      }),
    );
    expect(positionen.find((p) => p.id === 'a')!.typ).toBe('EINGANG');
    expect(positionen.find((p) => p.id === 'b')!.typ).toBe('AUSGANG');
  });

  it('sortiert nach Datum', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'spaet', amount: '10', valueDate: '2026-06-20T00:00:00+02:00' }),
          tx({ id: 'frueh', amount: '10', valueDate: '2026-06-02T00:00:00+02:00' }),
        ],
      }),
    );
    expect(positionen.map((p) => p.id)).toEqual(['frueh', 'spaet']);
  });
});

describe('baueBelege - Aktenzeichen', () => {
  it('nimmt das Aktenzeichen aus der verknuepften Rechnung, nicht aus dem Text', () => {
    // Der Verwendungszweck enthaelt bewusst ein ABWEICHENDES Aktenzeichen.
    // Die sevDesk-Verknuepfung muss gewinnen.
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '892.50', paymtPurpose: 'Zahlung 0526/9999TG01' }),
        ],
        invoices: [invoice({ id: 'inv-1', invoiceNumber: '0626/1811TG01' })],
        invoiceProTransaktion: new Map([['a', 'inv-1']]),
      }),
    );
    const p = positionen[0]!;
    expect(p.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
    expect(p.aktenzeichen!.herkunft).toBe('sevdesk-invoice');
    expect(p.invoiceId).toBe('inv-1');
  });

  it('faellt auf den Verwendungszweck zurueck, wenn keine Verknuepfung existiert', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '892.50', paymtPurpose: 'RE 0626/1811 TG 01' }),
        ],
      }),
    );
    const p = positionen[0]!;
    expect(p.aktenzeichen!.normalisiert).toBe('0626/1811TG01');
    expect(p.aktenzeichen!.herkunft).toBe('verwendungszweck');
  });

  it('traegt die Rechnung nach, wenn das geparste Aktenzeichen sie findet', () => {
    // sevDesk kennt keine Zahlungsverknuepfung, das Aktenzeichen passt aber
    // auf eine Rechnung des Zeitraums.
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '892.50', paymtPurpose: '0626/1811TG01' }),
        ],
        invoices: [invoice({ id: 'inv-1', invoiceNumber: '0626/1811TG01' })],
      }),
    );
    const p = positionen[0]!;
    expect(p.invoiceId).toBe('inv-1');
    expect(p.aktenzeichen!.herkunft).toBe('sevdesk-invoice');
    expect(p.hinweis).toBeUndefined();
  });

  it('meldet eine Sammelzahlung mit mehreren Aktenzeichen als Kandidaten', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({
            id: 'a',
            amount: '1785.00',
            paymtPurpose: 'RE 0626/1811TG01 und 0626/1811TG02',
          }),
        ],
      }),
    );
    const p = positionen[0]!;
    expect(p.aktenzeichenKandidaten).toEqual(['0626/1811TG01', '0626/1811TG02']);
    expect(p.hinweis).toContain('Mehrere Aktenzeichen');
  });

  it('meldet eine Sammelueberweisung ohne Aktenzeichen als offen', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '1240.00', paymtPurpose: 'Sammelueberweisung Allianz' }),
        ],
      }),
    );
    expect(positionen[0]!.aktenzeichen).toBeUndefined();
    expect(positionen[0]!.hinweis).toContain('Kein Aktenzeichen');
  });

  it('parst kein Aktenzeichen fuer AUSGANG-Buchungen', () => {
    // Ausgaben tragen keine eigenen Aktenzeichen - dort zaehlt der Voucher.
    const positionen = baueBelege(
      eingabe({
        transaktionen: [
          tx({ id: 'a', amount: '-119.00', paymtPurpose: 'Gutschrift 0626/1811TG01' }),
        ],
      }),
    );
    expect(positionen[0]!.aktenzeichen).toBeUndefined();
  });
});

describe('baueBelege - Belegverknuepfung', () => {
  it('verknuepft eine Ausgabe mit ihrem Voucher und uebernimmt den Lieferanten', () => {
    const positionen = baueBelege(
      eingabe({
        transaktionen: [tx({ id: 'a', amount: '-119.00' })],
        vouchers: [voucher({ id: 'v-1', supplierName: 'Telekom Deutschland GmbH' })],
        voucherProTransaktion: new Map([['a', 'v-1']]),
      }),
    );
    expect(positionen[0]!.voucherId).toBe('v-1');
    expect(positionen[0]!.gegenkonto).toBe('Telekom Deutschland GmbH');
    expect(positionen[0]!.hinweis).toBeUndefined();
  });

  it('markiert eine Ausgabe ohne Voucher als belegfrei', () => {
    const positionen = baueBelege(
      eingabe({ transaktionen: [tx({ id: 'a', amount: '-84.20' })] }),
    );
    expect(positionen[0]!.hinweis).toContain('Kein Beleg in sevDesk');
  });
});

describe('aktualisiereStatus', () => {
  const basis: Position = {
    id: 'a',
    datum: '2026-06-03',
    betrag: 100,
    waehrung: 'EUR',
    verwendungszweck: '',
    typ: 'EINGANG',
    dateien: [],
    status: 'offen',
    manuellBestaetigt: false,
  };

  const datei = {
    id: 'd1',
    dateiname: 'r.pdf',
    groesse: 10,
    mimeType: 'application/pdf',
    quelle: 'onedrive-n8n' as const,
  };

  it('setzt ok, wenn genau eine Datei zugeordnet ist', () => {
    expect(aktualisiereStatus({ ...basis, dateien: [datei] }).status).toBe('ok');
  });

  it('setzt offen, wenn keine Datei vorliegt', () => {
    expect(aktualisiereStatus(basis).status).toBe('offen');
  });

  it('setzt mehrdeutig, wenn zusaetzliche Kandidaten existieren', () => {
    const p = aktualisiereStatus({
      ...basis,
      dateien: [datei],
      kandidaten: [{ ...datei, id: 'd2' }],
    });
    expect(p.status).toBe('mehrdeutig');
  });

  it('respektiert eine manuelle Entscheidung', () => {
    const p = aktualisiereStatus({ ...basis, manuellBestaetigt: true, status: 'ok' });
    expect(p.status).toBe('ok');
  });

  it('laesst ignorierte Positionen unangetastet', () => {
    const p = aktualisiereStatus({ ...basis, status: 'ignoriert' });
    expect(p.status).toBe('ignoriert');
  });
});

describe('berechneSummen', () => {
  const p = (id: string, betrag: number, status: Position['status'] = 'ok'): Position => ({
    id,
    datum: '2026-06-03',
    betrag,
    waehrung: 'EUR',
    verwendungszweck: '',
    typ: betrag >= 0 ? 'EINGANG' : 'AUSGANG',
    dateien: [],
    status,
    manuellBestaetigt: false,
  });

  it('summiert Einnahmen und Ausgaben getrennt', () => {
    const s = berechneSummen([p('a', 892.5), p('b', -119), p('c', 1240)]);
    expect(s.einnahmen).toBe(2132.5);
    expect(s.ausgaben).toBe(119);
    expect(s.saldo).toBe(2013.5);
  });

  it('laesst ignorierte Positionen aus den Summen heraus, zaehlt sie aber', () => {
    const s = berechneSummen([p('a', 100), p('b', 500, 'ignoriert')]);
    expect(s.einnahmen).toBe(100);
    expect(s.anzahlGesamt).toBe(2);
    expect(s.anzahlIgnoriert).toBe(1);
  });

  it('vermeidet Gleitkomma-Artefakte', () => {
    const s = berechneSummen([p('a', 0.1), p('b', 0.2)]);
    expect(s.einnahmen).toBe(0.3);
  });
});

describe('baueTransaktionsIndex', () => {
  it('bildet Buchung -> Beleg rueckwaerts ab', async () => {
    const index = await baueTransaktionsIndex(['v-1', 'v-2'], async (id) => {
      if (id === 'v-1') return [tx({ id: 'tx-1', amount: '-10' })];
      return [tx({ id: 'tx-2', amount: '-20' }), tx({ id: 'tx-3', amount: '-30' })];
    });

    expect(index.get('tx-1')).toBe('v-1');
    expect(index.get('tx-2')).toBe('v-2');
    expect(index.get('tx-3')).toBe('v-2');
  });

  it('behaelt bei Doppelzuordnung den ersten Treffer', async () => {
    const index = await baueTransaktionsIndex(['v-1'], async () => [
      tx({ id: 'tx-1', amount: '-10' }),
      tx({ id: 'tx-1', amount: '-10' }),
    ]);
    expect(index.get('tx-1')).toBe('v-1');
    expect(index.size).toBe(1);
  });

  it('kommt mit einer leeren Liste zurecht', async () => {
    const index = await baueTransaktionsIndex([], async () => []);
    expect(index.size).toBe(0);
  });
});
