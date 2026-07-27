import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  istGueltigerMonat,
  type Capabilities,
  type Kontoauszug,
  type LadeEreignis,
} from '@abrechnung/shared';
import type { KiDienst } from '../ai/client.js';
import type { Datenbank } from '../db/index.js';
import type { MonatsDienst } from '../monatsdienst.js';
import { baueAbrechnungsPdf } from '../pdf/build.js';
import type { CheckAccount } from '../sevdesk/types.js';
import { EingabeFehler, NichtGefunden } from '../fehler.js';
import type { Dateiablage } from '../storage/dateien.js';

export interface RoutenKontext {
  monate: MonatsDienst;
  db: Datenbank;
  ablage: Dateiablage;
  checkAccount: CheckAccount;
  ki?: KiDienst;
  n8nAktiv: boolean;
  kiModell?: string;
  authDeaktiviert: boolean;
}

/** Wirft einen 400er, wenn der Monatsparameter nicht YYYY-MM ist. */
function pruefeMonat(monat: string): string {
  if (!istGueltigerMonat(monat)) {
    throw new EingabeFehler(`"${monat}" ist kein gueltiger Monat (erwartet YYYY-MM).`);
  }
  return monat;
}

/** Inhaltstyp anhand der Signatur der ersten Bytes. */
function erkenneInhaltstyp(daten: Buffer): string {
  const kopf = daten.subarray(0, 8).toString('latin1');
  if (kopf.startsWith('%PDF-')) return 'application/pdf';
  if (daten[0] === 0xff && daten[1] === 0xd8) return 'image/jpeg';
  if (kopf.startsWith('\x89PNG')) return 'image/png';
  if (kopf.startsWith('GIF8')) return 'image/gif';
  if (kopf.startsWith('RIFF') && daten.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function naechsterMonat(monat: string): string {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(jahr, mon, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function brauchtKi(ctx: RoutenKontext): KiDienst {
  if (!ctx.ki) {
    const fehler = new Error(
      'KI-Funktionen sind nicht aktiv. Bitte ANTHROPIC_API_KEY setzen und den Server neu starten.',
    ) as Error & { statusCode?: number };
    fehler.statusCode = 503;
    throw fehler;
  }
  return ctx.ki;
}

export async function registriereRouten(
  app: FastifyInstance,
  ctx: RoutenKontext,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Faehigkeiten - das Frontend blendet danach seine Schaltflaechen ein/aus
  // -------------------------------------------------------------------------

  app.get('/api/capabilities', async (req): Promise<Capabilities> => ({
    angemeldet: true,
    anmeldungNoetig: !ctx.authDeaktiviert,
    benutzer: req.benutzer,
    ki: Boolean(ctx.ki),
    kiModell: ctx.ki ? ctx.kiModell : undefined,
    n8nRechnungsabruf: ctx.n8nAktiv,
    sevdesk: true,
    checkAccountId: ctx.checkAccount.id,
    checkAccountName: ctx.checkAccount.name,
  }));

  app.get('/api/health', async () => ({ status: 'ok', zeit: new Date().toISOString() }));

  // -------------------------------------------------------------------------
  // Monat
  // -------------------------------------------------------------------------

  app.get<{ Params: { monat: string }; Querystring: { refresh?: string } }>(
    '/api/months/:monat',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      return ctx.monate.lade(monat, req.query.refresh === 'true');
    },
  );

  app.post<{ Params: { monat: string } }>('/api/months/:monat/sync', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    return ctx.monate.synchronisiere(monat);
  });

  /**
   * Derselbe Ladevorgang wie oben, nur als Server-Sent-Events-Strom.
   *
   * Der Abruf eines Monats dauert je nach Buchungszahl viele Sekunden. Statt
   * die Oberflaeche so lange auf eine einzige Antwort warten zu lassen, kommen
   * hier Zwischenstaende: erst die Phasen, dann die fertige Buchungstabelle,
   * zuletzt der Monat mit allen Belegen.
   */
  app.get<{ Params: { monat: string }; Querystring: { refresh?: string } }>(
    '/api/months/:monat/stream',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);

      // Fastify aus der Antwort nehmen - ab hier schreiben wir selbst.
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Reverse-Proxies (Traefik/nginx) puffern Antworten sonst und der
        // Fortschritt kaeme erst am Ende - also gar nicht.
        'X-Accel-Buffering': 'no',
      });

      let offen = true;
      req.raw.on('close', () => {
        offen = false;
      });

      const sende = (ereignis: LadeEreignis): void => {
        if (!offen) return;
        reply.raw.write(`data: ${JSON.stringify(ereignis)}\n\n`);
      };

      sende({ art: 'fortschritt', fortschritt: { phase: 'start', text: 'Verbunden' } });

      try {
        const ergebnis = await ctx.monate.lade(monat, req.query.refresh === 'true', {
          fortschritt: (fortschritt) => sende({ art: 'fortschritt', fortschritt }),
          zwischenstand: (teil) => sende({ art: 'teil', monat: teil }),
        });
        sende({ art: 'fertig', monat: ergebnis });
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        req.log.error({ err: meldung, monat }, 'Lade-Stream fehlgeschlagen');
        sende({ art: 'fehler', fehler: meldung });
      } finally {
        if (offen) reply.raw.end();
      }
    },
  );

  /**
   * Kompakter Zustand ohne sevDesk-Abruf. Beantwortet die Frage "ist der Monat
   * fertig?" - insbesondere, ob noch Buchungen in sevDesk unzugeordnet sind.
   */
  app.get<{ Params: { monat: string } }>('/api/months/:monat/status', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    return ctx.monate.status(monat);
  });

  /** Zustand mehrerer Monate auf einen Blick, z. B. fuer eine Jahresuebersicht. */
  app.get<{ Querystring: { von?: string; bis?: string } }>(
    '/api/months',
    async (req) => {
      const von = pruefeMonat(req.query.von ?? '');
      const bis = pruefeMonat(req.query.bis ?? von);
      const monate: string[] = [];

      for (let m = von; m <= bis && monate.length < 60; m = naechsterMonat(m)) {
        monate.push(m);
      }
      return monate.map((m) => ctx.monate.status(m));
    },
  );

  app.patch<{
    Params: { monat: string; positionId: string };
    Body: Record<string, unknown>;
  }>('/api/months/:monat/positions/:positionId', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    return ctx.monate.patcheposition(monat, req.params.positionId, req.body);
  });

  app.delete<{ Params: { monat: string; positionId: string } }>(
    '/api/months/:monat/positions/:positionId/override',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      return ctx.monate.setzePositionZurueck(monat, req.params.positionId);
    },
  );

  // -------------------------------------------------------------------------
  // Dateien
  // -------------------------------------------------------------------------

  app.get<{ Params: { monat: string; dateiId: string } }>(
    '/api/months/:monat/files/:dateiId',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);
      const daten = await ctx.ablage.lese(monat, req.params.dateiId);

      // Typ aus dem Inhalt bestimmen, nicht aus der Endung: sevDesk liefert
      // Dateinamen nicht immer mit passender Endung, und ein falsch
      // deklariertes PDF zeigt der Browser gar nicht erst an.
      return reply
        .header('Content-Type', erkenneInhaltstyp(daten))
        // inline, damit der Viewer im Frontend direkt rendern kann
        .header('Content-Disposition', `inline; filename="${req.params.dateiId}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(daten);
    },
  );

  /** Manuell nachgereichter Beleg fuer eine konkrete Buchung. */
  app.post<{ Params: { monat: string; positionId: string } }>(
    '/api/months/:monat/positions/:positionId/upload',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      const datei = await req.file();
      if (!datei) throw new EingabeFehler('Keine Datei im Upload gefunden.');

      const bytes = await datei.toBuffer();
      const abgelegt = await ctx.ablage.speichere(
        monat,
        bytes,
        datei.filename,
        'manuell',
        datei.mimetype,
      );

      // Bewusst die zusammengefuehrte Sicht: haengt an der Position bereits eine
      // manuell getroffene Dateiauswahl, muss der neue Beleg dazukommen und die
      // Auswahl nicht ueberschreiben.
      const aktuell = await ctx.monate.lade(monat);
      const position = aktuell.positionen.find((p) => p.id === req.params.positionId);
      const bestehende = position?.dateien ?? [];

      ctx.db.speichereOverride(monat, req.params.positionId, {
        dateien: [...bestehende, abgelegt],
      });

      return ctx.monate.lade(monat);
    },
  );

  // -------------------------------------------------------------------------
  // Kontoauszuege
  // -------------------------------------------------------------------------

  app.post<{ Params: { monat: string } }>(
    '/api/months/:monat/statements',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      const datei = await req.file();
      if (!datei) throw new EingabeFehler('Keine Datei im Upload gefunden.');

      const bytes = await datei.toBuffer();
      const abgelegt = await ctx.ablage.speichere(
        monat,
        bytes,
        datei.filename,
        'manuell',
        datei.mimetype,
      );

      const auszug: Kontoauszug = {
        id: abgelegt.id,
        dateiname: datei.filename,
        groesse: abgelegt.groesse,
        seiten: abgelegt.seiten,
        hochgeladenAm: new Date().toISOString(),
      };
      ctx.db.speichereKontoauszug(monat, auszug);

      return ctx.monate.lade(monat);
    },
  );

  app.delete<{ Params: { monat: string; id: string } }>(
    '/api/months/:monat/statements/:id',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      ctx.db.loescheKontoauszug(monat, req.params.id);
      await ctx.ablage.loesche(monat, req.params.id).catch(() => undefined);
      return ctx.monate.lade(monat);
    },
  );

  app.put<{ Params: { monat: string }; Body: { ids: string[] } }>(
    '/api/months/:monat/statements/order',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      ctx.db.ordneKontoauszuege(monat, req.body.ids);
      return ctx.monate.lade(monat);
    },
  );

  // -------------------------------------------------------------------------
  // Abrechnungs-PDF
  // -------------------------------------------------------------------------

  app.post<{ Params: { monat: string }; Body?: { buero?: string } }>(
    '/api/months/:monat/report',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);
      const daten = await ctx.monate.lade(monat);

      const pdf = await baueAbrechnungsPdf({
        monat: daten,
        buero: req.body?.buero,
        ladeDatei: (dateiId) => ctx.ablage.lese(monat, dateiId),
      });

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="Abrechnung_${monat}.pdf"`)
        .send(pdf);
    },
  );

  // -------------------------------------------------------------------------
  // KI - nur aktiv, wenn ANTHROPIC_API_KEY gesetzt ist
  // -------------------------------------------------------------------------

  /** Liest die Belegdaten aller Dateien eines Monats, mit Cache je Datei. */
  app.post<{ Params: { monat: string } }>(
    '/api/months/:monat/ai/extract',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      const ki = brauchtKi(ctx);
      const daten = await ctx.monate.lade(monat);

      let neu = 0;
      for (const position of daten.positionen) {
        const datei = position.dateien[0];
        if (!datei || !datei.mimeType.includes('pdf')) continue;

        // Der Cache haengt am Inhalts-Hash: dieselbe Datei wird nie zweimal
        // an das Modell geschickt.
        let extraktion = ctx.db.ladeExtraktion<
          NonNullable<(typeof position)['extraktion']>
        >(datei.id);

        if (!extraktion) {
          const bytes = await ctx.ablage.lese(monat, datei.id);
          extraktion = await ki.extrahiereBeleg(bytes, datei.dateiname);
          ctx.db.speichereExtraktion(datei.id, extraktion);
          neu++;
        }

        ctx.db.speichereOverride(monat, position.id, { extraktion });
      }

      return { neuAnalysiert: neu, monat: await ctx.monate.lade(monat) };
    },
  );

  /** Schlaegt Zuordnungen fuer die noch offenen Buchungen vor. */
  app.post<{ Params: { monat: string } }>('/api/months/:monat/ai/match', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    const ki = brauchtKi(ctx);
    const daten = await ctx.monate.lade(monat);

    const offen = daten.positionen.filter(
      (p) => p.status === 'offen' && p.dateien.length === 0,
    );
    const freieBelege = [
      ...daten.verwaisteBelege,
      ...daten.positionen.flatMap((p) => p.kandidaten ?? []),
    ].map((b) => ({
      id: b.id,
      dateiname: b.dateiname,
      extraktion: ctx.db.ladeExtraktion<never>(b.id) ?? undefined,
    }));

    return { vorschlaege: await ki.schlageZuordnungVor(offen, freieBelege) };
  });

  /** Erzeugt weitere Aktenzeichen-Kandidaten fuer eine Buchung. */
  app.post<{ Params: { monat: string; positionId: string } }>(
    '/api/months/:monat/ai/aktenzeichen/:positionId',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      const ki = brauchtKi(ctx);
      const daten = await ctx.monate.lade(monat);

      const position = daten.positionen.find((p) => p.id === req.params.positionId);
      if (!position) {
        throw new NichtGefunden(`Buchung ${req.params.positionId} nicht gefunden.`);
      }

      const bereitsVersucht = position.aktenzeichenKandidaten ?? [];
      const kandidaten = await ki.schlageAktenzeichenVor(
        position.verwendungszweck,
        position.datum,
        bereitsVersucht,
      );

      return { kandidaten };
    },
  );

  /** Prueft den fertigen Monat vor der Abgabe. */
  app.post<{ Params: { monat: string } }>('/api/months/:monat/ai/review', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    const ki = brauchtKi(ctx);
    const daten = await ctx.monate.lade(monat);

    const review = await ki.pruefeMonat(monat, daten.positionen);
    ctx.db.speichereReview(monat, review);
    return review;
  });

  app.get<{ Params: { monat: string } }>('/api/months/:monat/ai/review', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    return ctx.db.ladeReview(monat) ?? { zusammenfassung: null, auffaelligkeiten: [] };
  });

  // -------------------------------------------------------------------------

  app.setErrorHandler((fehler: Error & { statusCode?: number }, _req, reply) => {
    const status = fehler.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: fehler }, 'Anfrage fehlgeschlagen');
    return reply.status(status).send({
      fehler: fehler.message,
      referenz: randomUUID().slice(0, 8),
    });
  });
}
