import { existsSync } from 'node:fs';
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
import { SevDeskClient } from './sevdesk/client.js';
import { Dateiablage } from './storage/dateien.js';

export interface AppInstanz {
  app: FastifyInstance;
  db: Datenbank;
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
      ...(process.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    bodyLimit: 50 * 1024 * 1024,
  });

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
      { tenant: config.auth.entra!.tenantId, redirect: config.auth.entra!.redirectUri },
      'Anmeldung ueber Microsoft Entra ID aktiv',
    );
  }

  const sevdesk = new SevDeskClient({
    token: config.sevdesk.token,
    baseUrl: config.sevdesk.baseUrl,
  });

  const checkAccount = await sevdesk.ermittleCheckAccount(config.sevdesk.checkAccountId);
  app.log.info(
    { id: checkAccount.id, name: checkAccount.name },
    'Bankkonto fuer die Abrechnung',
  );

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
  });

  // Gebautes Frontend ausliefern, sofern vorhanden (Produktion / Docker).
  const webDist = join(process.cwd(), 'packages/web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ fehler: 'Unbekannter API-Endpunkt' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}
