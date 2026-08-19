import { baueApp } from './app.js';
import { ladeConfig } from './config.js';

async function start(): Promise<void> {
  const config = ladeConfig();
  const { app, db } = await baueApp(config);

  const beenden = async (signal: string) => {
    app.log.info({ signal }, 'Fahre herunter');
    await app.close();
    await db.schliesse();
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
