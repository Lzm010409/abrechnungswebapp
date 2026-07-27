import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function env(name: string): string | undefined {
  const wert = process.env[name];
  if (wert === undefined) return undefined;
  const getrimmt = wert.trim();
  return getrimmt.length === 0 ? undefined : getrimmt;
}

/** Zahl aus der Umgebung; Unsinn wird ignoriert, dann gilt der Standardwert. */
function zahl(name: string): number | undefined {
  const wert = env(name);
  if (wert === undefined) return undefined;
  const n = Number(wert);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
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
  /** Gebautes Frontend. Ohne Angabe packages/web/dist relativ zum Startpfad. */
  webDist?: string;

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

  /** Ablage der Belege in den OneDrive-Monatsordnern. */
  ablage?: {
    /** Webhook: Jahr + Monat -> Ordner-ID des Ausgabenordners */
    ordnerUrl?: string;
    /** Webhook: legt eine Datei in einen Unterordner */
    ablageUrl?: string;
    authHeader?: string;
    authValue?: string;
    /** Pause zwischen zwei Dateien, damit n8n nicht ueberrannt wird */
    pauseMs?: number;
    /** Versuche je Aufruf, einschliesslich des ersten */
    versuche?: number;
  };

  anthropic?: {
    apiKey: string;
    modell: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Nur gesetzt, wenn bewusst ein Gateway davorgeschaltet ist. */
    baseUrl?: string;
  };

  auth: {
    /** true nur bei ausdruecklichem AUTH_MODE=disabled - fuer lokale Arbeit. */
    deaktiviert: boolean;
    /** Cookies nur ueber HTTPS ausliefern. */
    sicher: boolean;
    sessionDauer: number;
    entra?: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      /** Optional - ohne Angabe aus der aufgerufenen Adresse gebildet. */
      redirectUri?: string;
      sessionSecret: string;
      erlaubteBenutzer: string[];
      erlaubteGruppen: string[];
    };
  };
}

function liste(name: string): string[] {
  return (env(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Anmeldung ist Pflicht, sofern sie nicht ausdruecklich abgeschaltet wurde.
 *
 * Die Anwendung zeigt Kontobewegungen und Belege eines Buelros. Faellt die
 * Konfiguration weg, darf sie nicht einfach offen weiterlaufen - der Server
 * verweigert dann den Start und sagt, was fehlt.
 */
function ladeAuth(): Config['auth'] {
  const sessionDauer = Number(env('SESSION_DAUER_SEKUNDEN') ?? 8 * 60 * 60);
  const sicher = (env('COOKIE_SECURE') ?? 'true') !== 'false';

  if (env('AUTH_MODE') === 'disabled') {
    return { deaktiviert: true, sicher, sessionDauer };
  }

  const tenantId = env('ENTRA_TENANT_ID');
  const clientId = env('ENTRA_CLIENT_ID');
  const clientSecret = env('ENTRA_CLIENT_SECRET');
  const redirectUri = env('ENTRA_REDIRECT_URI');
  const sessionSecret = env('SESSION_SECRET');

  // ENTRA_REDIRECT_URI fehlt hier bewusst: ohne Angabe bildet der Server den
  // Rueckweg aus der Adresse, unter der er aufgerufen wurde. Gesetzt werden
  // muss sie nur, wenn die Anwendung intern anders heisst als nach aussen.
  const fehlend = [
    ['ENTRA_TENANT_ID', tenantId],
    ['ENTRA_CLIENT_ID', clientId],
    ['ENTRA_CLIENT_SECRET', clientSecret],
    ['SESSION_SECRET', sessionSecret],
  ]
    .filter(([, wert]) => !wert)
    .map(([name]) => name);

  if (fehlend.length > 0) {
    throw new Error(
      `Anmeldung ist nicht konfiguriert. Es fehlt: ${fehlend.join(', ')}.\n` +
        'Die Anwendung startet ohne Anmeldung nicht, weil sie Kontobewegungen ' +
        'und Belege offenlegt.\n' +
        'Einrichtung siehe README, Abschnitt "Anmeldung (Microsoft Entra ID)".\n' +
        'Nur fuer die lokale Arbeit ohne Entra: AUTH_MODE=disabled setzen.',
    );
  }

  if (sessionSecret!.length < 32) {
    throw new Error(
      'SESSION_SECRET ist zu kurz. Es signiert die Sitzungscookies und braucht ' +
        'mindestens 32 Zeichen. Erzeugen mit: openssl rand -base64 48',
    );
  }

  return {
    deaktiviert: false,
    sicher,
    sessionDauer,
    entra: {
      tenantId: tenantId!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      redirectUri,
      sessionSecret: sessionSecret!,
      erlaubteBenutzer: liste('ENTRA_ERLAUBTE_BENUTZER'),
      erlaubteGruppen: liste('ENTRA_ERLAUBTE_GRUPPEN'),
    },
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
  const ordnerUrl = env('N8N_ORDNER_URL');
  const ablageUrl = env('N8N_ABLAGE_URL');

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

    ablage:
      ordnerUrl || ablageUrl
        ? {
            ordnerUrl,
            ablageUrl,
            authHeader: env('N8N_WEBHOOK_AUTH_HEADER'),
            authValue: env('N8N_WEBHOOK_AUTH_VALUE'),
            pauseMs: zahl('N8N_ABLAGE_PAUSE_MS'),
            versuche: zahl('N8N_ABLAGE_VERSUCHE'),
          }
        : undefined,

    anthropic: anthropicKey
      ? {
          apiKey: anthropicKey,
          // Sonnet reicht fuer beide Aufgaben: Belegdaten auslesen und einen
          // Monat auf Plausibilitaet pruefen. Opus kostet ein Vielfaches, ohne
          // hier erkennbar besser zu sein - wer will, setzt ANTHROPIC_MODEL.
          modell: env('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
          effort: leseEffort(),
          baseUrl: env('ANTHROPIC_BASE_URL'),
        }
      : undefined,

    auth: ladeAuth(),
  };
}
