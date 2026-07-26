import { existsSync } from 'node:fs';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { KiDienst } from './ai/client.js';
import { ladeConfig } from './config.js';
import { Datenbank } from './db/index.js';
import { StandardRechnungsProvider } from './invoices/provider.js';
import { MonatsDienst } from './monatsdienst.js';
import { registriereRouten } from './routes/index.js';
import { SevDeskClient } from './sevdesk/client.js';
import { Dateiablage } from './storage/dateien.js';

async function start(): Promise<void> {
  const config = ladeConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(process.env.NODE_ENV !== 'production'
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    // Kontoauszuege und Belegscans koennen gross sein.
    bodyLimit: 50 * 1024 * 1024,
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  });

  const sevdesk = new SevDeskClient({
    token: config.sevdesk.token,
    baseUrl: config.sevdesk.baseUrl,
  });

  // Das Bankkonto wird beim Start einmal aufgeloest. Ist SEVDESK_CHECK_ACCOUNT_ID
  // nicht gesetzt, waehlt der Client das aktive Online-Bankkonto automatisch und
  // bricht mit einer Kandidatenliste ab, wenn die Wahl nicht eindeutig ist.
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

  const beenden = async (signal: string) => {
    app.log.info({ signal }, 'Fahre herunter');
    await app.close();
    db.schliesse();
    process.exit(0);
  };
  process.on('SIGTERM', () => void beenden('SIGTERM'));
  process.on('SIGINT', () => void beenden('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error('Start fehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
