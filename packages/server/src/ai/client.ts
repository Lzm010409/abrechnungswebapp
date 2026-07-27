import Anthropic from '@anthropic-ai/sdk';
import type {
  BelegExtraktion,
  MonatsReview,
  Position,
  ZuordnungsVorschlag,
} from '@abrechnung/shared';
import type { Config } from '../config.js';

/**
 * Obergrenze fuer Denken UND Antwort zusammen.
 *
 * Das ist der Punkt, an dem die Monatspruefung frueher scheiterte: mit
 * adaptivem Denken auf Stufe "high" ging das Budget im Denken auf, bevor das
 * JSON geschrieben war - die Antwort kam mit stop_reason "max_tokens" zurueck
 * und war unbrauchbar. Die Werte sind deshalb grosszuegig; bezahlt wird, was
 * tatsaechlich anfaellt, nicht das Budget.
 */
const BUDGET = {
  /** Ein Beleg, wenige Felder - aber das Lesen des PDF kostet Denkzeit. */
  beleg: 16_000,
  /** Kurze Liste von Kandidaten. */
  aktenzeichen: 8_000,
  /** Ganzer Monat als Eingabe, Liste von Vorschlaegen als Ausgabe. */
  zuordnung: 32_000,
  /** Ganzer Monat, dazu eine Begruendung je Auffaelligkeit. */
  pruefung: 32_000,
} as const;

/**
 * KI-Funktionen der Abrechnung.
 *
 * Der gesamte Dienst ist optional: ist ANTHROPIC_API_KEY nicht gesetzt, wird
 * diese Klasse nie instanziiert und /api/capabilities meldet ki:false. Das
 * Frontend blendet die entsprechenden Schaltflaechen dann aus. Die Anwendung
 * bleibt ohne KI vollstaendig bedienbar.
 *
 * Aufgabenteilung: das Modell entscheidet ausschliesslich Zweifelsfaelle.
 * Betraege, Verknuepfungen und Summen kommen aus sevDesk, nicht aus dem Modell.
 */
export class KiDienst {
  private readonly client: Anthropic;
  private readonly modell: string;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(config: NonNullable<Config['anthropic']>) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.modell = config.modell;
    this.effort = config.effort;
  }

  /**
   * Ein Aufruf ans Modell.
   *
   * Als Strom, weil das SDK gewoehnliche Anfragen ab den hier noetigen
   * Budgets rundheraus ablehnt ("Streaming is required for operations that may
   * take longer than 10 minutes"). Ausgewertet wird nur die fertige Nachricht -
   * die Teilstuecke braucht hier niemand.
   */
  private async frage(
    params: Omit<Anthropic.MessageStreamParams, 'model'>,
  ): Promise<Anthropic.Message> {
    return this.client.messages.stream({ model: this.modell, ...params }).finalMessage();
  }

  /**
   * Liest Belegdaten aus einem PDF.
   *
   * Das PDF geht als document-Block direkt an das Modell - kein separates OCR.
   * Ergebnis dient dem Abgleich gegen die Buchung, nicht als Buchungsgrundlage.
   */
  async extrahiereBeleg(pdf: Buffer, dateiname: string): Promise<BelegExtraktion> {
    const antwort = await this.frage({
      max_tokens: BUDGET.beleg,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              betrag: {
                type: ['number', 'null'],
                description: 'Bruttobetrag des Belegs in Euro, ohne Waehrungszeichen',
              },
              belegdatum: {
                type: ['string', 'null'],
                description: 'Belegdatum im Format YYYY-MM-DD',
              },
              aussteller: {
                type: ['string', 'null'],
                description: 'Name des ausstellenden Unternehmens',
              },
              ustBetrag: { type: ['number', 'null'], description: 'Ausgewiesene Umsatzsteuer in Euro' },
              ustSatz: { type: ['number', 'null'], description: 'Steuersatz in Prozent, z. B. 19' },
              kategorie: {
                type: ['string', 'null'],
                description:
                  'Kurze Kostenart, z. B. "Telekommunikation", "Buerobedarf", "Kfz-Kosten", "Software"',
              },
              aktenzeichen: {
                type: ['string', 'null'],
                description:
                  'Aktenzeichen im Format MMYY/NummerTGXX, falls auf dem Beleg genannt, sonst null',
              },
              konfidenz: {
                type: 'number',
                description: 'Selbsteinschaetzung 0..1, wie sicher die Werte gelesen wurden',
              },
            },
            required: ['betrag', 'belegdatum', 'aussteller', 'ustBetrag', 'ustSatz', 'kategorie', 'aktenzeichen', 'konfidenz'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
            {
              type: 'text',
              text:
                `Lies die Kerndaten aus diesem Beleg (Dateiname: ${dateiname}).\n\n` +
                'Gib nur zurueck, was tatsaechlich auf dem Beleg steht. Rate nichts. ' +
                'Ist ein Wert nicht lesbar oder nicht vorhanden, setze ihn auf null und ' +
                'senke die Konfidenz entsprechend. Der Betrag ist immer der Bruttobetrag ' +
                'als positive Zahl.',
            },
          ],
        },
      ],
    });

    const daten = leseJson<Omit<BelegExtraktion, 'extrahiertAm'>>(antwort);
    return { ...bereinigeNulls(daten), extrahiertAm: new Date().toISOString() };
  }

  /**
   * Schlaegt Zuordnungen zwischen offenen Buchungen und nicht zugeordneten
   * Belegen vor. Kriterien nach dem urspruenglichen Skill: Betrag zuerst,
   * dann Datum, dann Name.
   */
  async schlageZuordnungVor(
    offeneBuchungen: Position[],
    freieBelege: Array<{ id: string; dateiname: string; extraktion?: BelegExtraktion }>,
  ): Promise<ZuordnungsVorschlag[]> {
    if (offeneBuchungen.length === 0 || freieBelege.length === 0) return [];

    const antwort = await this.frage({
      max_tokens: BUDGET.zuordnung,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              vorschlaege: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    positionId: { type: 'string' },
                    belegId: { type: 'string' },
                    konfidenz: { type: 'number' },
                    begruendung: {
                      type: 'string',
                      description: 'Ein Satz, welche Kriterien zutreffen',
                    },
                  },
                  required: ['positionId', 'belegId', 'konfidenz', 'begruendung'],
                  additionalProperties: false,
                },
              },
            },
            required: ['vorschlaege'],
            additionalProperties: false,
          },
        },
      },
      system:
        'Du ordnest Ausgabenbelege den Bankbuchungen eines Kfz-Sachverstaendigenbueros zu.\n\n' +
        'Kriterien in dieser Rangfolge:\n' +
        '1. Betrag - exakte Uebereinstimmung ist das Hauptkriterium\n' +
        '2. Datum - das Belegdatum liegt hoechstens 14 Tage vor dem Buchungsdatum\n' +
        '3. Name - Aussteller des Belegs passt zum Empfaenger der Buchung\n\n' +
        'Schlage eine Zuordnung nur vor, wenn mindestens der Betrag passt. ' +
        'Jeder Beleg darf hoechstens einmal vorkommen, jede Buchung hoechstens einmal. ' +
        'Bist du unsicher, lass die Zuordnung weg statt zu raten - eine fehlende ' +
        'Zuordnung ist harmlos, eine falsche nicht.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify(
            {
              buchungen: offeneBuchungen.map((p) => ({
                id: p.id,
                datum: p.datum,
                betrag: p.betrag,
                verwendungszweck: p.verwendungszweck,
                empfaenger: p.gegenkonto,
              })),
              belege: freieBelege.map((b) => ({
                id: b.id,
                dateiname: b.dateiname,
                betrag: b.extraktion?.betrag,
                belegdatum: b.extraktion?.belegdatum,
                aussteller: b.extraktion?.aussteller,
              })),
            },
            null,
            2,
          ),
        },
      ],
    });

    return leseJson<{ vorschlaege: ZuordnungsVorschlag[] }>(antwort).vorschlaege;
  }

  /**
   * Erzeugt weitere Aktenzeichen-Kandidaten, wenn die deterministische
   * Retry-Kette leer geblieben ist.
   */
  async schlageAktenzeichenVor(
    verwendungszweck: string,
    buchungsdatum: string,
    bereitsVersucht: string[],
  ): Promise<string[]> {
    const antwort = await this.frage({
      max_tokens: BUDGET.aktenzeichen,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              kandidaten: {
                type: 'array',
                items: { type: 'string' },
                description: 'Aktenzeichen im Format MMYY/NummerTGXX, beste Vermutung zuerst',
              },
            },
            required: ['kandidaten'],
            additionalProperties: false,
          },
        },
      },
      system:
        'Aktenzeichen-Format des Bueros: MMYY/<Schadennummer>TG<Index>\n' +
        '  MM = Monat, YY = Jahr zweistellig, Schadennummer 3-4 Stellen,\n' +
        '  TG = Kuerzel Gollenstede, Index meist 01 oder 02.\n' +
        'Beispiel: 0126/1800TG01\n\n' +
        'Das Buchungsdatum kann bis zu 30 Tage nach dem Rechnungsdatum liegen, ' +
        'MMYY gehoert also oft zum Vormonat. TG01 ist das Gutachten, TG02 die ' +
        'separat abgerechneten Fahrtkosten.\n\n' +
        'Nenne nur Kandidaten, die sich aus dem Text begruenden lassen. Findest ' +
        'du keinen plausiblen, gib eine leere Liste zurueck.',
      messages: [
        {
          role: 'user',
          content:
            `Verwendungszweck: ${verwendungszweck}\n` +
            `Buchungsdatum: ${buchungsdatum}\n` +
            `Erfolglos versucht: ${bereitsVersucht.join(', ') || '(nichts)'}`,
        },
      ],
    });

    const { kandidaten } = leseJson<{ kandidaten: string[] }>(antwort);
    return kandidaten.filter((k) => !bereitsVersucht.includes(k));
  }

  /** Prueft den fertigen Monat auf Auffaelligkeiten. */
  async pruefeMonat(monat: string, positionen: Position[]): Promise<MonatsReview> {
    const antwort = await this.frage({
      max_tokens: BUDGET.pruefung,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              zusammenfassung: { type: 'string' },
              auffaelligkeiten: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    schwere: { type: 'string', enum: ['hinweis', 'warnung', 'fehler'] },
                    titel: { type: 'string' },
                    beschreibung: { type: 'string' },
                    positionIds: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['schwere', 'titel', 'beschreibung', 'positionIds'],
                  additionalProperties: false,
                },
              },
            },
            required: ['zusammenfassung', 'auffaelligkeiten'],
            additionalProperties: false,
          },
        },
      },
      system:
        'Du pruefst die Monatsabrechnung eines Kfz-Sachverstaendigenbueros vor der Abgabe.\n\n' +
        'Achte auf:\n' +
        '- Buchungen ohne Beleg\n' +
        '- moegliche Doppelerfassungen (gleicher Betrag, gleicher Empfaenger, nahe Daten)\n' +
        '- Abweichungen zwischen Buchungsbetrag und Belegbetrag\n' +
        '- unplausible Umsatzsteuer\n' +
        '- Eingaenge ohne Aktenzeichen\n\n' +
        'Melde nur, was wirklich einer Klaerung bedarf. Ein sauberer Monat darf ' +
        'eine leere Liste haben - erfinde keine Befunde, um etwas zu liefern.',
      messages: [
        {
          role: 'user',
          content:
            `Abrechnungsmonat ${monat}\n\n` +
            JSON.stringify(
              positionen.map((p) => ({
                id: p.id,
                datum: p.datum,
                betrag: p.betrag,
                typ: p.typ,
                verwendungszweck: p.verwendungszweck,
                empfaenger: p.gegenkonto,
                aktenzeichen: p.aktenzeichen?.normalisiert,
                status: p.status,
                anzahlDateien: p.dateien.length,
                belegBetrag: p.extraktion?.betrag,
                belegUst: p.extraktion?.ustBetrag,
              })),
              null,
              2,
            ),
        },
      ],
    });

    const daten = leseJson<Omit<MonatsReview, 'erstelltAm'>>(antwort);
    return { ...daten, erstelltAm: new Date().toISOString() };
  }
}

/**
 * Holt den JSON-Text aus der Antwort.
 *
 * Bei gesetztem output_config.format ist der erste text-Block garantiert
 * schema-konformes JSON. stop_reason wird trotzdem geprueft: bei "refusal"
 * oder "max_tokens" gibt es kein verwertbares Ergebnis.
 */
function leseJson<T>(antwort: Anthropic.Message): T {
  if (antwort.stop_reason === 'refusal') {
    throw new Error('Die KI hat die Verarbeitung dieses Belegs abgelehnt.');
  }
  if (antwort.stop_reason === 'max_tokens') {
    throw new Error(
      'Die KI-Antwort war laenger als das eingeraeumte Budget und wurde ' +
        'abgeschnitten. Ein kleinerer ANTHROPIC_EFFORT (z. B. "medium") laesst ' +
        'dem Modell weniger Denkzeit und mehr Platz fuer die Antwort.',
    );
  }

  const text = antwort.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('KI-Antwort enthielt keinen Textblock.');
  }
  return JSON.parse(text.text) as T;
}

/** Das Schema erlaubt null; intern arbeiten wir mit undefined. */
function bereinigeNulls<T extends Record<string, unknown>>(obj: T): T {
  const ergebnis: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) ergebnis[k] = v;
  }
  return ergebnis as T;
}
