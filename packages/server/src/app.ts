import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { KiDienst } from './ai/client.js';
import { EntraAnmeldung } from './auth/entra.js';
import { registriereAuth } from './auth/plugin.js';
import type { Config } from './config.js';
import { Datenbank } from './db/index.js';
import { StandardRechnungsProvider } from './invoices/provider.js';
import { MonatsDienst } from './monatsdienst.js';
import { registriereRouten } from './routes/index.js';
import { Vorgaenge } from './vorgaenge.js';
import { SevDeskClient } from './sevdesk/client.js';
import { Dateiablage } from './storage/dateien.js';

export interface AppInstanz {
  app: FastifyInstance;
  db: Datenbank;
}

/**
 * Warnt, wenn das Datenverzeichnis im Container nicht eingebunden ist.
 *
 * Ohne Einbindung liegen Datenbank und Belege in der Schreibschicht des
 * Containers und sind beim naechsten Deploy verschwunden. Das faellt sonst
 * erst auf, wenn ein Beleg nicht mehr angezeigt werden kann - also spaet und
 * an der falschen Stelle.
 */
async function warneVorFluechtigemDatenverzeichnis(
  app: FastifyInstance,
  dataDir: string,
): Promise<void> {
  // Nur im Container aussagekraeftig; lokal ist ./data ohnehin dauerhaft.
  if (!existsSync('/.dockerenv')) return;

  try {
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    const eingebunden = mounts
      .split('\n')
      .some((zeile) => zeile.split(' ')[4] === dataDir);

    if (!eingebunden) {
      app.log.warn(
        { dataDir },
        `${dataDir} ist nicht eingebunden - Datenbank und heruntergeladene Belege ` +
          'gehen beim naechsten Deploy verloren. In Coolify unter "Persistent Storage" ' +
          'ein Volume auf diesen Pfad legen.',
      );
    }
  } catch {
    // Ohne /proc laesst sich das nicht feststellen - dann eben ohne Warnung.
  }
}

/** Parameter, die als Klartext im Log nichts zu suchen haben. */
const GEHEIME_PARAMETER = ['code', 'state', 'session_state', 'id_token', 'code_verifier'];

/**
 * Ersetzt die Werte sicherheitsrelevanter Query-Parameter durch einen Platzhalter.
 * Der Pfad bleibt lesbar, damit die Logs weiter zur Fehlersuche taugen.
 */
export function entferneGeheimnisse(url: string): string {
  const trenner = url.indexOf('?');
  if (trenner < 0) return url;

  const parameter = new URLSearchParams(url.slice(trenner + 1));
  let veraendert = false;
  for (const name of GEHEIME_PARAMETER) {
    if (parameter.has(name)) {
      parameter.set(name, '[entfernt]');
      veraendert = true;
    }
  }
  if (!veraendert) return url;
  return `${url.slice(0, trenner)}?${parameter.toString()}`;
}

/**
 * Baut die vollstaendige Anwendung. Getrennt vom Bootstrap in index.ts, damit
 * Integrationstests dieselbe Instanz per app.inject() ansprechen koennen wie
 * der echte Betrieb - ohne Port und ohne Abweichung im Aufbau.
 */
export async function baueApp(config: Config): Promise<AppInstanz> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // Fastify protokolliert die vollstaendige URL. Auf dem Rueckweg der
        // Anmeldung steht dort der Autorisierungscode - der gehoert nicht in
        // ein Log, das Betreiber und Weiterleitungen zu sehen bekommen.
        req: (req) => ({
          method: req.method,
          url: entferneGeheimnisse(req.url),
          host: req.headers?.host,
          remoteAddress: req.socket?.remoteAddress,
        }),
      },
      ...(process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    bodyLimit: 50 * 1024 * 1024,
  });

  /*
   * Ein POST ohne Body ist fuer die Auslose-Endpunkte (KI, Ablage, Sync) der
   * Normalfall. Fastify beantwortet ihn von sich aus mit 400, sobald der
   * Aufrufer "application/json" mitschickt - also auch dann, wenn schlicht
   * nichts zu uebergeben ist. Ein leerer Koerper gilt hier als leeres Objekt.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, koerper: string, fertig) => {
      if (koerper.trim().length === 0) return fertig(null, {});
      try {
        fertig(null, JSON.parse(koerper));
      } catch (err) {
        const fehler = err as Error & { statusCode?: number };
        fehler.statusCode = 400;
        fertig(fehler, undefined);
      }
    },
  );

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  });

  // Anmeldung als Erstes registrieren, damit ihr onRequest-Hook vor allen
  // API-Routen greift.
  const entra = config.auth.entra
    ? new EntraAnmeldung({ ...config.auth.entra, sessionDauer: config.auth.sessionDauer })
    : undefined;

  await registriereAuth(app, {
    entra,
    deaktiviert: config.auth.deaktiviert,
    sicher: config.auth.sicher,
    sessionDauer: config.auth.sessionDauer,
  });

  if (config.auth.deaktiviert) {
    app.log.warn(
      'AUTH_MODE=disabled - die Anwendung laeuft OHNE Anmeldung. ' +
        'Nur fuer die lokale Arbeit gedacht, niemals oeffentlich erreichbar betreiben.',
    );
  } else {
    app.log.info(
      {
        tenant: config.auth.entra!.tenantId,
        redirect: config.auth.entra!.redirectUri ?? 'aus der Anfrage abgeleitet',
      },
      'Anmeldung ueber Microsoft Entra ID aktiv',
    );
  }

  const sevdesk = new SevDeskClient({
    token: config.sevdesk.token,
    baseUrl: config.sevdesk.baseUrl,
    log: app.log,
  });

  const checkAccount = await sevdesk.ermittleCheckAccount(config.sevdesk.checkAccountId);
  app.log.info(
    { id: checkAccount.id, name: checkAccount.name },
    'Bankkonto fuer die Abrechnung',
  );

  await warneVorFluechtigemDatenverzeichnis(app, config.dataDir);

  const db = new Datenbank(config.dataDir);
  const ablage = new Dateiablage(config.dataDir);

  const rechnungen = new StandardRechnungsProvider(
    sevdesk,
    config.n8n
      ? {
          url: config.n8n.findRechnungUrl,
          authHeader: config.n8n.authHeader,
          authValue: config.n8n.authValue,
        }
      : undefined,
  );

  const ki = config.anthropic ? new KiDienst(config.anthropic) : undefined;
  if (ki) {
    app.log.info({ modell: config.anthropic!.modell }, 'KI-Funktionen aktiv');
  } else {
    app.log.info(
      'KI-Funktionen inaktiv - ANTHROPIC_API_KEY nicht gesetzt. ' +
        'Die Anwendung laeuft vollstaendig, nur die KI-Schaltflaechen sind ausgeblendet.',
    );
  }

  if (!config.n8n) {
    app.log.warn(
      'N8N_FIND_RECHNUNG_URL nicht gesetzt - Ausgangsrechnungen kommen aus sevDesk ' +
        'statt als Original aus dem OneDrive-Gutachtenordner.',
    );
  }

  const monate = new MonatsDienst({
    sevdesk,
    rechnungen,
    db,
    ablage,
    checkAccount,
    log: app.log,
  });

  await registriereRouten(app, {
    monate,
    db,
    ablage,
    checkAccount,
    ki,
    n8nAktiv: Boolean(config.n8n),
    kiModell: config.anthropic?.modell,
    authDeaktiviert: config.auth.deaktiviert,
    ablageOptionen: config.ablage,
    vorgaenge: new Vorgaenge(app.log),
  });

  // Gebautes Frontend ausliefern, sofern vorhanden (Produktion / Docker).
  const webDist = config.webDist ?? join(process.cwd(), 'packages/web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      /*
       * Die Dateien unter /assets tragen den Inhalts-Hash im Namen und duerfen
       * deshalb beliebig lange im Browser liegen. Die index.html darf das
       * gerade nicht: sie verweist auf genau diese Hashes. Bleibt eine alte
       * Fassung im Cache, fordert der Browser nach einem Deploy Dateien an, die
       * es nicht mehr gibt - und die Anwendung startet nicht mehr.
       */
      // Die eigene Steuerung abschalten, sonst ueberschreibt sie setHeaders.
      cacheControl: false,
      setHeaders: (res, pfad) => {
        if (pfad.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store, must-revalidate');
        } else if (pfad.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      },
    });

    app.setNotFoundHandler((req, reply) => {
      const pfad = req.url.split('?')[0] ?? '';

      if (pfad.startsWith('/api/')) {
        return reply.status(404).send({ fehler: 'Unbekannter API-Endpunkt' });
      }

      /*
       * Eine fehlende Datei darf niemals die index.html zurueckbekommen. Der
       * Browser laedt sie sonst als Modul, bricht mit einem MIME-Fehler ab und
       * die eigentliche Ursache - eine veraltete Datei wurde angefragt - bleibt
       * unsichtbar. Ein ehrlicher 404 sagt genau das.
       */
      if (pfad.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(pfad)) {
        return reply
          .status(404)
          .send({ fehler: `${pfad} gehoert nicht zu dieser Fassung der Anwendung.` });
      }

      // Alles Uebrige ist eine Route des Frontends.
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}
