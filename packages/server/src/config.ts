import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function env(name: string): string | undefined {
  const wert = process.env[name];
  if (wert === undefined) return undefined;
  const getrimmt = wert.trim();
  return getrimmt.length === 0 ? undefined : getrimmt;
}

function pflicht(name: string): string {
  const wert = env(name);
  if (!wert) {
    throw new Error(
      `Umgebungsvariable ${name} fehlt. Siehe .env.example fuer die vollstaendige Liste.`,
    );
  }
  return wert;
}

export interface Config {
  port: number;
  logLevel: string;
  dataDir: string;

  sevdesk: {
    token: string;
    baseUrl: string;
    /** Optional. Wenn nicht gesetzt, wird das Konto zur Laufzeit ermittelt. */
    checkAccountId?: string;
  };

  n8n?: {
    findRechnungUrl: string;
    authHeader?: string;
    authValue?: string;
  };

  anthropic?: {
    apiKey: string;
    modell: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Nur gesetzt, wenn bewusst ein Gateway davorgeschaltet ist. */
    baseUrl?: string;
  };
}

const ERLAUBTE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof ERLAUBTE_EFFORTS)[number];

function leseEffort(): Effort {
  const roh = env('ANTHROPIC_EFFORT') ?? 'high';
  if ((ERLAUBTE_EFFORTS as readonly string[]).includes(roh)) {
    return roh as Effort;
  }
  throw new Error(
    `ANTHROPIC_EFFORT="${roh}" ist ungueltig. Erlaubt: ${ERLAUBTE_EFFORTS.join(', ')}`,
  );
}

export function ladeConfig(): Config {
  const dataDir = resolve(env('DATA_DIR') ?? './data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Der Anthropic-Key ist bewusst optional: die App laeuft ohne ihn vollstaendig,
  // nur die KI-Funktionen melden sich ueber /api/capabilities als inaktiv.
  const anthropicKey = env('ANTHROPIC_API_KEY');
  const n8nUrl = env('N8N_FIND_RECHNUNG_URL');

  return {
    port: Number(env('PORT') ?? 3000),
    logLevel: env('LOG_LEVEL') ?? 'info',
    dataDir,

    sevdesk: {
      token: pflicht('SEVDESK_API_TOKEN'),
      baseUrl: env('SEVDESK_BASE_URL') ?? 'https://my.sevdesk.de/api/v1',
      checkAccountId: env('SEVDESK_CHECK_ACCOUNT_ID'),
    },

    n8n: n8nUrl
      ? {
          findRechnungUrl: n8nUrl,
          authHeader: env('N8N_WEBHOOK_AUTH_HEADER'),
          authValue: env('N8N_WEBHOOK_AUTH_VALUE'),
        }
      : undefined,

    anthropic: anthropicKey
      ? {
          apiKey: anthropicKey,
          modell: env('ANTHROPIC_MODEL') ?? 'claude-opus-5',
          effort: leseEffort(),
          baseUrl: env('ANTHROPIC_BASE_URL'),
        }
      : undefined,
  };
}
