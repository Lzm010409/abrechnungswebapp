import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  istGueltigerMonat,
  type Capabilities,
  type Kontoauszug,
  type LadeEreignis,
  type LadeFortschritt,
  type Monat,
  type SammelPatch,
  type VorgangsEreignis,
} from '@abrechnung/shared';
import type { KiDienst } from '../ai/client.js';
import type { Datenbank } from '../db/index.js';
import type { MonatsDienst } from '../monatsdienst.js';
import { baueAbrechnungsPdf } from '../pdf/build.js';
import type { CheckAccount } from '../sevdesk/types.js';
import { EingabeFehler, NichtGefunden } from '../fehler.js';
import { OneDriveAblage, type AblageOptionen } from '../onedrive/ablage.js';
import type { Dateiablage } from '../storage/dateien.js';
import type { Vorgaenge } from '../vorgaenge.js';

export interface RoutenKontext {
  monate: MonatsDienst;
  db: Datenbank;
  ablage: Dateiablage;
  checkAccount: CheckAccount;
  ki?: KiDienst;
  n8nAktiv: boolean;
  kiModell?: string;
  authDeaktiviert: boolean;
  /** Webhooks fuer die Ablage in OneDrive - ohne sie gibt es nur Vorschau. */
  ablageOptionen?: AblageOptionen;
  /** Laenger laufende Vorgaenge, die der Server im Hintergrund zu Ende fuehrt. */
  vorgaenge: Vorgaenge;
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
    onedriveAblage: Boolean(ctx.ablageOptionen?.ordnerUrl && ctx.ablageOptionen?.ablageUrl),
    sevdesk: true,
    checkAccountId: ctx.checkAccount.id,
    checkAccountName: ctx.checkAccount.name,
  }));

  app.get('/api/health', async () => ({ status: 'ok', zeit: new Date().toISOString() }));

  // -------------------------------------------------------------------------
  // Hintergrundvorgaenge
  //
  // Gestartet wird ueber die jeweilige .../job-Route, abgefragt hier. Jeder
  // Aufruf antwortet sofort - es wird nie eine Verbindung offen gehalten,
  // waehrend das Modell arbeitet.
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { monat?: string } }>('/api/vorgaenge', async (req) => {
    const monat = req.query.monat ? pruefeMonat(req.query.monat) : undefined;
    return ctx.vorgaenge.alle(monat);
  });

  app.get<{ Params: { id: string } }>('/api/vorgaenge/:id', async (req) => {
    const vorgang = ctx.vorgaenge.hole(req.params.id);
    if (!vorgang) {
      throw new NichtGefunden(
        `Vorgang ${req.params.id} ist nicht bekannt. Moeglicherweise wurde er nach ` +
          'einem Neustart des Servers verworfen.',
      );
    }
    return vorgang;
  });

  /** Nimmt einen abgeschlossenen Vorgang aus der Liste - die UI hat ihn gesehen. */
  app.delete<{ Params: { id: string } }>('/api/vorgaenge/:id', async (req, reply) => {
    const vorgang = ctx.vorgaenge.hole(req.params.id);
    if (!vorgang) throw new NichtGefunden(`Vorgang ${req.params.id} ist nicht bekannt.`);

    if (!ctx.vorgaenge.entferne(req.params.id)) {
      throw new EingabeFehler(
        'Der Vorgang laeuft noch. Ihn jetzt zu entfernen wuerde ihn nicht anhalten, ' +
          'nur unsichtbar machen.',
      );
    }
    return reply.code(204).send();
  });

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

      /*
       * Lebenszeichen alle 15 Sekunden.
       *
       * Cloudflare kappt eine Verbindung, ueber die 100 Sekunden lang nichts
       * fliesst, mit einem 524 - und der Browser sieht einen Abbruch, obwohl
       * der Server weiterarbeitet. Ein Kommentar (Zeile mit ":") gilt in SSE
       * als Nutzlast, wird vom Client aber ignoriert.
       */
      const puls = setInterval(() => {
        if (offen) reply.raw.write(': puls\n\n');
      }, 15_000);
      puls.unref?.();

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
        clearInterval(puls);
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
      return Promise.all(monate.map((m) => ctx.monate.status(m)));
    },
  );

  /** Dieselbe Aenderung an mehreren Buchungen - eine Runde statt vieler. */
  app.patch<{ Params: { monat: string }; Body: SammelPatch }>(
    '/api/months/:monat/positions',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      const { positionIds, patch } = req.body ?? {};

      if (!Array.isArray(positionIds) || positionIds.length === 0) {
        throw new EingabeFehler('Es wurde keine Buchung ausgewaehlt.');
      }
      return ctx.monate.patcheMehrere(monat, positionIds, patch ?? {});
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

      // Fehlt die Datei, ist das kein Serverfehler, sondern ein bekannter
      // Zustand: der Zwischenspeicher kennt sie noch, das Datenverzeichnis
      // nicht mehr. Ein roher ENOENT-Text half beim Verstehen nicht weiter.
      if (!(await ctx.ablage.existiert(monat, req.params.dateiId))) {
        throw new NichtGefunden(
          'Diese Belegdatei liegt nicht mehr im Datenverzeichnis. ' +
            'Den Monat neu aus sevDesk laden, dann wird sie erneut geholt.',
        );
      }

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

      await ctx.db.speichereOverride(monat, req.params.positionId, {
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
      await ctx.db.speichereKontoauszug(monat, auszug);

      return ctx.monate.lade(monat);
    },
  );

  app.delete<{ Params: { monat: string; id: string } }>(
    '/api/months/:monat/statements/:id',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      await ctx.db.loescheKontoauszug(monat, req.params.id);
      await ctx.ablage.loesche(monat, req.params.id).catch(() => undefined);
      return ctx.monate.lade(monat);
    },
  );

  app.put<{ Params: { monat: string }; Body: { ids: string[] } }>(
    '/api/months/:monat/statements/order',
    async (req) => {
      const monat = pruefeMonat(req.params.monat);
      await ctx.db.ordneKontoauszuege(monat, req.body.ids);
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

  /**
   * Legt die Belege in den OneDrive-Monatsordnern ab.
   *
   * Bewusst erst am Ende, zusammen mit dem Abrechnungs-PDF: die Einteilung
   * haengt davon ab, welche Buchung sich auf einer Kontoauszugsseite
   * wiederfindet - und das steht erst fest, wenn der Auszug hochgeladen ist.
   *
   * Ohne `?ausfuehren=true` entsteht nur eine Vorschau. Dateien in fremde
   * Ordner zu schieben ist nichts, was nebenbei passieren sollte.
   */
  const legeAb = async (
    monat: string,
    ausfuehren: boolean,
    melde: (f: LadeFortschritt) => void,
  ) => {
    const daten = await ctx.monate.lade(monat);

    const ablage = new OneDriveAblage(ctx.ablageOptionen ?? {}, {
      ladeDatei: (dateiId) => ctx.ablage.lese(monat, dateiId),
      // Die einmal berechneten Fingerabdruecke ueberdauern den Lauf: ein
      // zweiter Anlauf desselben Monats liest die Dateien nicht noch einmal.
      abdruckSpeicher: {
        hole: (itemId, cTag) => ctx.db.ladeAbdruck(itemId, cTag),
        lege: (itemId, cTag, abdruck) => ctx.db.speichereAbdruck(itemId, cTag, abdruck),
      },
      /*
       * Belege ohne Textebene - Tanken, Bewirtung, Geschenke - werden vom
       * Modell gelesen. Ohne KI-Schluessel entfaellt das; dann entscheidet bei
       * diesen Dateien nur der Dateiname.
       */
      ...(ctx.ki
        ? {
            belegleser: async (daten: Buffer, dateiname: string) => {
              try {
                const gelesen = await ctx.ki!.extrahiereBeleg(daten, dateiname);
                const teile = [
                  gelesen.aussteller,
                  gelesen.belegdatum,
                  gelesen.kategorie,
                  gelesen.betrag === undefined ? undefined : gelesen.betrag.toFixed(2).replace('.', ','),
                  gelesen.ustBetrag === undefined
                    ? undefined
                    : gelesen.ustBetrag.toFixed(2).replace('.', ','),
                  gelesen.aktenzeichen,
                ].filter((t): t is string => Boolean(t));

                if (teile.length === 0) return null;
                return {
                  text: teile.join(' '),
                  ...(gelesen.konfidenz === undefined ? {} : { konfidenz: gelesen.konfidenz }),
                };
              } catch (err) {
                // Ein Beleg, den das Modell nicht lesen kann, darf den Abgleich
                // nicht anhalten - er faellt dann auf den Dateinamen zurueck.
                app.log.warn(
                  { datei: dateiname, err: err instanceof Error ? err.message : String(err) },
                  'Beleg liess sich nicht auslesen',
                );
                return null;
              }
            },
          }
        : {}),
      log: app.log,
    });

    return ablage.lege(daten, !ausfuehren, melde);
  };

  app.post<{ Params: { monat: string }; Querystring: { ausfuehren?: string } }>(
    '/api/months/:monat/ablage',
    async (req) =>
      legeAb(pruefeMonat(req.params.monat), req.query.ausfuehren === 'true', () => undefined),
  );

  /**
   * Dasselbe als Hintergrundvorgang, mit laufender Rueckmeldung.
   *
   * Ein voller Monat sind schnell fuenfzig Dateien, die einzeln und gedrosselt
   * hinausgehen. Der Aufruf kehrt sofort mit einer Kennung zurueck; gearbeitet
   * wird weiter, auch wenn niemand mehr zusieht.
   */
  app.post<{ Params: { monat: string }; Querystring: { ausfuehren?: string } }>(
    '/api/months/:monat/ablage/job',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);
      const ausfuehren = req.query.ausfuehren === 'true';

      const vorgang = ctx.vorgaenge.starte(
        {
          art: ausfuehren ? 'ablage' : 'ablage-vorschau',
          monat,
          titel: ausfuehren ? 'Belege werden abgelegt' : 'Belege werden eingeteilt',
        },
        (melde) => legeAb(monat, ausfuehren, melde),
      );

      return reply.code(202).send(vorgang);
    },
  );

  // -------------------------------------------------------------------------
  // KI - nur aktiv, wenn ANTHROPIC_API_KEY gesetzt ist
  // -------------------------------------------------------------------------

  /**
   * Liest die Belegdaten aller Dateien eines Monats, mit Cache je Datei.
   *
   * Jede Datei geht einzeln an das Modell - bei einem vollen Monat dauert das
   * eine Weile. `melde` gibt den Stand nach aussen.
   */
  const leseBelegeAus = async (
    monat: string,
    melde: (f: LadeFortschritt) => void,
  ): Promise<{ neuAnalysiert: number; monat: Monat }> => {
    const ki = brauchtKi(ctx);

    melde({
      phase: 'ki-belege',
      schritt: 'sammeln',
      titel: 'Belege zusammenstellen',
      text: 'Der Monat wird aus dem Zwischenspeicher geholt',
    });

    const daten = await ctx.monate.lade(monat);
    const zuLesen = daten.positionen.filter(
      (p) => p.dateien[0]?.mimeType.includes('pdf'),
    );
    const schonGelesen = (
      await Promise.all(zuLesen.map((p) => ctx.db.ladeExtraktion(p.dateien[0]!.id)))
    ).filter(Boolean).length;

    melde({
      phase: 'ki-belege',
      schritt: 'sammeln',
      titel: 'Belege zusammenstellen',
      text:
        `${zuLesen.length} Belege im Monat` +
        (schonGelesen > 0 ? `, davon ${schonGelesen} bereits gelesen` : ''),
      erledigt: zuLesen.length,
      gesamt: zuLesen.length,
    });

    melde({
      phase: 'ki-belege',
      schritt: 'lesen',
      titel: 'Belege werden gelesen',
      text: zuLesen.length === schonGelesen ? 'nichts Neues zu lesen' : 'los geht es',
      erledigt: 0,
      gesamt: zuLesen.length,
    });

    let neu = 0;
    for (const [i, position] of zuLesen.entries()) {
      const datei = position.dateien[0]!;

      // Der Cache haengt am Inhalts-Hash: dieselbe Datei wird nie zweimal
      // an das Modell geschickt.
      let extraktion = await ctx.db.ladeExtraktion<
        NonNullable<(typeof position)['extraktion']>
      >(datei.id);

      if (!extraktion) {
        const bytes = await ctx.ablage.lese(monat, datei.id);
        extraktion = await ki.extrahiereBeleg(bytes, datei.dateiname);
        await ctx.db.speichereExtraktion(datei.id, extraktion);
        neu++;
      }

      await ctx.db.speichereOverride(monat, position.id, { extraktion });

      melde({
        phase: 'ki-belege',
        schritt: 'lesen',
        titel: 'Belege werden gelesen',
        text: datei.dateiname,
        erledigt: i + 1,
        gesamt: zuLesen.length,
      });
    }

    melde({
      phase: 'ki-belege',
      schritt: 'uebernehmen',
      titel: 'Ergebnisse übernehmen',
      text: neu === 0 ? 'alle Belege waren bereits gelesen' : `${neu} neu ausgelesen`,
    });

    return { neuAnalysiert: neu, monat: await ctx.monate.lade(monat) };
  };

  app.post<{ Params: { monat: string } }>(
    '/api/months/:monat/ai/extract',
    async (req) => leseBelegeAus(pruefeMonat(req.params.monat), () => undefined),
  );

  /** Dasselbe als Hintergrundvorgang, mit Rueckmeldung je Beleg. */
  app.post<{ Params: { monat: string } }>(
    '/api/months/:monat/ai/extract/job',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);
      // Fehlt der Schluessel, soll das sofort auffallen und nicht erst als
      // fehlgeschlagener Vorgang eine Sekunde spaeter.
      brauchtKi(ctx);

      const vorgang = ctx.vorgaenge.starte(
        { art: 'ki-belege', monat, titel: 'Belege werden ausgelesen' },
        (melde) => leseBelegeAus(monat, melde),
      );

      return reply.code(202).send(vorgang);
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
    const freieBelege = await Promise.all(
      [
        ...daten.verwaisteBelege,
        ...daten.positionen.flatMap((p) => p.kandidaten ?? []),
      ].map(async (b) => ({
        id: b.id,
        dateiname: b.dateiname,
        extraktion: (await ctx.db.ladeExtraktion<never>(b.id)) ?? undefined,
      })),
    );

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
    await ctx.db.speichereReview(monat, review);
    return review;
  });

  /**
   * Die Pruefung als Hintergrundvorgang.
   *
   * Sie ist ein einzelner Modellaufruf und dauert bei einem vollen Monat
   * Minuten - in denen nichts zu melden waere. Genau daran ist die fruehere
   * Strom-Fassung gescheitert: der Reverse-Proxy kappte die Verbindung nach
   * 100 Sekunden ohne Daten (Cloudflare 524), und der Nutzer sah einen Fehler,
   * obwohl das Modell weiterarbeitete. Jetzt kehrt der Aufruf sofort zurueck.
   */
  app.post<{ Params: { monat: string } }>(
    '/api/months/:monat/ai/review/job',
    async (req, reply) => {
      const monat = pruefeMonat(req.params.monat);
      const ki = brauchtKi(ctx);

      const vorgang = ctx.vorgaenge.starte(
        { art: 'ki-pruefung', monat, titel: 'Der Monat wird geprüft' },
        async (melde) => {
        melde({
          phase: 'ki-pruefung',
          schritt: 'sammeln',
          titel: 'Monat zusammenstellen',
          text: 'Buchungen, Belege und bisherige Korrekturen',
        });

        const daten = await ctx.monate.lade(monat);
        const mitBeleg = daten.positionen.filter((p) => p.dateien.length > 0).length;
        const ausgelesen = daten.positionen.filter((p) => p.extraktion).length;

        melde({
          phase: 'ki-pruefung',
          schritt: 'sammeln',
          titel: 'Monat zusammenstellen',
          text: `${daten.positionen.length} Buchungen, ${mitBeleg} mit Beleg, ${ausgelesen} ausgelesen`,
          erledigt: 1,
          gesamt: 1,
        });

        melde({
          phase: 'ki-pruefung',
          schritt: 'modell',
          titel: 'Prüfung läuft',
          text: 'Dubletten, Betragsabweichungen, USt-Plausibilität, fehlende Belege',
        });

        const review = await ki.pruefeMonat(monat, daten.positionen);

        melde({
          phase: 'ki-pruefung',
          schritt: 'befunde',
          titel: 'Befunde werden übernommen',
          // Defensiv: liefert das Modell eine unvollstaendige Antwort, soll
          // daran nicht die Fortschrittsmeldung scheitern.
          text:
            (review.auffaelligkeiten?.length ?? 0) === 0
              ? 'keine Auffälligkeiten'
              : `${review.auffaelligkeiten.length} Auffälligkeit(en)`,
        });

        await ctx.db.speichereReview(monat, review);
        return review;
        },
      );

      return reply.code(202).send(vorgang);
    },
  );

  app.get<{ Params: { monat: string } }>('/api/months/:monat/ai/review', async (req) => {
    const monat = pruefeMonat(req.params.monat);
    return (await ctx.db.ladeReview(monat)) ?? { zusammenfassung: null, auffaelligkeiten: [] };
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
