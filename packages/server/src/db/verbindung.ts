import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { Datenbank } from './index.js';

/**
 * Die Verbindung zur Postgres-Datenbank.
 *
 * `DATABASE_URL` ist die einzige Schnittstelle zur Datenbank. In Coolify ist
 * der interne Hostname einer Standalone-Datenbank ihre UUID - die Adresse ist
 * also umgebungsabhaengig und hat im Quelltext nichts zu suchen.
 */
export function verbinde(url: string): Datenbank {
  // Der Pool ist bewusst klein: der Server beantwortet wenige gleichzeitige
  // Anfragen, und die langlaufenden Vorgaenge warten auf sevDesk und die KI,
  // nicht auf die Datenbank.
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return new Datenbank(db, () => client.end({ timeout: 5 }));
}
