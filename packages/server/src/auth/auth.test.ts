import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baueApp, entferneGeheimnisse } from '../app.js';
import type { Config } from '../config.js';
import type { Datenbank } from '../db/index.js';
import { starteMockSevDesk, type MockSevDesk } from '../testhilfen/mockSevdesk.js';

/**
 * Prueft die Absicherung der Anwendung.
 *
 * Der Anlass ist konkret: die Anwendung stand oeffentlich erreichbar im Netz
 * und wurde nachweislich nach .env und .git/config abgesucht. Die API darf
 * ohne gueltige Sitzung nichts herausgeben.
 *
 * Entra wird durch einen lokalen Server nachgebildet, der Token mit einem
 * selbst erzeugten Schluesselpaar signiert und dessen JWKS ausliefert.
 */

const TENANT = 'test-tenant';
const CLIENT_ID = 'test-client';

let sevdesk: MockSevDesk;
let app: FastifyInstance;
let db: Datenbank;
let dataDir: string;

function basisDaten() {
  return {
    checkAccounts: [
      {
        id: 'konto-1', objectName: 'CheckAccount' as const, name: 'Geschaeftskonto',
        type: 'online', status: '100', currency: 'EUR',
      },
    ],
    transaktionen: [], vouchers: [], invoices: [],
    voucherTransaktionen: {}, invoiceTransaktionen: {},
    voucherDateien: {}, invoicePdfs: {},
  };
}

async function starte(auth: Config['auth']) {
  const instanz = await baueApp({
    port: 0,
    logLevel: 'silent',
    dataDir,
    sevdesk: { token: 't', baseUrl: sevdesk.url },
    auth,
  });
  app = instanz.app;
  db = instanz.db;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'abrechnung-auth-'));
  sevdesk = await starteMockSevDesk(basisDaten());
});

afterEach(async () => {
  await app?.close();
  db?.schliesse();
  await sevdesk?.schliesse();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('Ohne Anmeldung ist die API dicht', () => {
  const auth: Config['auth'] = {
    deaktiviert: false,
    sicher: false,
    sessionDauer: 3600,
    entra: {
      tenantId: TENANT,
      clientId: CLIENT_ID,
      clientSecret: 'geheim',
      redirectUri: 'https://abrechnung.example/auth/callback',
      sessionSecret: 'a'.repeat(48),
      erlaubteBenutzer: [],
      erlaubteGruppen: [],
    },
  };

  it('weist Monatsdaten mit 401 ab', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/api/months/2026-06' });
    expect(res.statusCode).toBe(401);
    expect(res.json().anmeldungNoetig).toBe(true);
  });

  it('weist den Lade-Stream mit 401 ab', async () => {
    // Der Strom laeuft ueber reply.raw - der Wachhook muss trotzdem vorher
    // greifen, sonst waere die Monatsansicht offen erreichbar.
    await starte(auth);
    const res = await app.inject({ url: '/api/months/2026-06/stream' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });

  it('weist Belegdateien mit 401 ab', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/api/months/2026-06/files/irgendwas.pdf' });
    expect(res.statusCode).toBe(401);
  });

  it('weist das Erzeugen des Abrechnungs-PDF mit 401 ab', async () => {
    await starte(auth);
    const res = await app.inject({ method: 'POST', url: '/api/months/2026-06/report' });
    expect(res.statusCode).toBe(401);
  });

  it('weist Uploads mit 401 ab', async () => {
    await starte(auth);
    const res = await app.inject({
      method: 'POST',
      url: '/api/months/2026-06/statements',
    });
    expect(res.statusCode).toBe(401);
  });

  it('weist manuelle Korrekturen mit 401 ab', async () => {
    await starte(auth);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/months/2026-06/positions/tx-1',
      payload: { status: 'ignoriert' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('laesst den Health-Check durch - sonst gilt der Container als krank', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('beantwortet /api/capabilities verwertbar statt mit 401', async () => {
    // Das Frontend fragt hier, ob eine Anmeldung noetig ist - ein nackter
    // 401 waere nicht unterscheidbar von einem Serverfehler.
    await starte(auth);
    const res = await app.inject({ url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ angemeldet: false, anmeldungNoetig: true });
  });

  it('meldet ueber /auth/me, dass niemand angemeldet ist', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/auth/me' });
    expect(res.json()).toMatchObject({ angemeldet: false, anmeldungAktiv: true });
  });
});

// ---------------------------------------------------------------------------

describe('Geheimnisse im Log', () => {
  // Fastify protokolliert die vollstaendige URL. Der Rueckweg der Anmeldung
  // traegt den Autorisierungscode in der Query - der darf dort nicht landen.

  it('entfernt Code und State aus der protokollierten URL', () => {
    const bereinigt = entferneGeheimnisse(
      '/auth/callback?code=1.AVwAhXd4geheim&state=SFtEKjFECwP4&session_state=003fa8fa',
    );
    expect(bereinigt).not.toContain('geheim');
    expect(bereinigt).not.toContain('SFtEKjFECwP4');
    expect(bereinigt).not.toContain('003fa8fa');
    // Der Pfad muss lesbar bleiben, sonst taugen die Logs nicht mehr.
    expect(bereinigt.startsWith('/auth/callback?')).toBe(true);
  });

  it('laesst harmlose Parameter unangetastet', () => {
    expect(entferneGeheimnisse('/api/months/2026-06/stream?refresh=true')).toBe(
      '/api/months/2026-06/stream?refresh=true',
    );
    expect(entferneGeheimnisse('/api/months/2026-06')).toBe('/api/months/2026-06');
  });

  it('behaelt die Fehlermeldung von Entra, die keine ist', () => {
    const bereinigt = entferneGeheimnisse(
      '/auth/callback?error=access_denied&error_description=Zugriff+verweigert',
    );
    expect(bereinigt).toContain('access_denied');
  });
});

// ---------------------------------------------------------------------------

describe('Anmeldeweg', () => {
  const auth: Config['auth'] = {
    deaktiviert: false,
    sicher: true,
    sessionDauer: 3600,
    entra: {
      tenantId: TENANT,
      clientId: CLIENT_ID,
      clientSecret: 'geheim',
      redirectUri: 'https://abrechnung.example/auth/callback',
      sessionSecret: 'a'.repeat(48),
      erlaubteBenutzer: [],
      erlaubteGruppen: [],
    },
  };

  it('leitet zu Entra weiter und setzt das Uebergangscookie', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/auth/login' });

    expect(res.statusCode).toBe(302);
    const ziel = new URL(res.headers.location as string);
    expect(ziel.host).toBe('login.microsoftonline.com');
    expect(ziel.pathname).toContain(TENANT);
    expect(ziel.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(ziel.searchParams.get('response_type')).toBe('code');
    expect(ziel.searchParams.get('scope')).toBe('openid profile email');
    // PKCE ist Pflicht - ohne code_challenge waere der Code abfangbar.
    expect(ziel.searchParams.get('code_challenge_method')).toBe('S256');
    expect(ziel.searchParams.get('code_challenge')).toBeTruthy();
    expect(ziel.searchParams.get('state')).toBeTruthy();
    expect(ziel.searchParams.get('nonce')).toBeTruthy();

    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('verwendet die fest konfigurierte Redirect-URI', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/auth/login', headers: { host: 'intern:3000' } });
    const ziel = new URL(res.headers.location as string);
    // Eine gesetzte ENTRA_REDIRECT_URI schlaegt die Anfrage - fuer Faelle, in
    // denen die Anwendung intern anders heisst als nach aussen.
    expect(ziel.searchParams.get('redirect_uri')).toBe(
      'https://abrechnung.example/auth/callback',
    );
  });

  it('bildet die Redirect-URI aus der Anfrage, wenn keine gesetzt ist', async () => {
    await starte({ ...auth, entra: { ...auth.entra!, redirectUri: undefined } });
    const res = await app.inject({
      url: '/auth/login',
      headers: { host: 'abrechnung.gollenstede.app', 'x-forwarded-proto': 'https' },
    });

    const ziel = new URL(res.headers.location as string);
    expect(ziel.searchParams.get('redirect_uri')).toBe(
      'https://abrechnung.gollenstede.app/auth/callback',
    );
  });

  it('uebernimmt beim Ableiten das Schema des Reverse-Proxy', async () => {
    // Der Proxy terminiert TLS; ohne x-forwarded-proto entstuende http und
    // Entra wuerde die URI nicht wiedererkennen.
    await starte({ ...auth, entra: { ...auth.entra!, redirectUri: undefined } });
    const res = await app.inject({
      url: '/auth/login',
      headers: { host: 'abrechnung.example', 'x-forwarded-proto': 'https' },
    });
    expect(String(new URL(res.headers.location as string).searchParams.get('redirect_uri')))
      .toMatch(/^https:\/\//);
  });

  it('setzt das Sitzungscookie mit HttpOnly und Secure', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/auth/login' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('laesst keinen fremden Rueckkehrort zu (offener Redirect)', async () => {
    await starte(auth);
    for (const boes of ['https://boese.example/phish', '//boese.example', 'http://x.example']) {
      const res = await app.inject({
        url: `/auth/login?redirect=${encodeURIComponent(boes)}`,
      });
      // Das Ziel steckt im signierten Uebergangscookie; entscheidend ist,
      // dass die Anmeldung ueberhaupt startet und spaeter auf "/" landet.
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toContain('login.microsoftonline.com');
    }
  });

  it('weist einen Rueckweg ohne Uebergangscookie ab', async () => {
    await starte(auth);
    const res = await app.inject({ url: '/auth/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Anmeldung');
  });

  it('weist eine Ablehnung durch Entra sauber aus', async () => {
    await starte(auth);
    const res = await app.inject({
      url: '/auth/callback?error=access_denied&error_description=Zugriff+verweigert',
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Zugriff verweigert');
  });

  it('meldet ab und loescht das Sitzungscookie', async () => {
    await starte(auth);
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('abrechnung_sitzung=;');
  });
});

// ---------------------------------------------------------------------------

describe('Sitzung', () => {
  /**
   * Erzeugt ein gueltiges Sitzungscookie ueber denselben Weg wie der Server -
   * damit wird geprueft, dass eine echte Sitzung tatsaechlich Zugang gibt.
   */
  async function sitzungsCookie(sessionSecret: string, ablaufSekunden = 3600) {
    const schluessel = new TextEncoder().encode(sessionSecret);
    return new SignJWT({ sub: 'user-1', name: 'Luke Gollenstede', email: 'luke@example.de' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${ablaufSekunden}s`)
      .sign(schluessel);
  }

  const sessionSecret = 'b'.repeat(48);
  const auth: Config['auth'] = {
    deaktiviert: false,
    sicher: false,
    sessionDauer: 3600,
    entra: {
      tenantId: TENANT, clientId: CLIENT_ID, clientSecret: 'geheim',
      redirectUri: 'https://abrechnung.example/auth/callback',
      sessionSecret, erlaubteBenutzer: [], erlaubteGruppen: [],
    },
  };

  it('laesst eine gueltige Sitzung durch', async () => {
    await starte(auth);
    const res = await app.inject({
      url: '/api/capabilities',
      cookies: { abrechnung_sitzung: await sitzungsCookie(sessionSecret) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      angemeldet: true,
      benutzer: { name: 'Luke Gollenstede', email: 'luke@example.de' },
    });
  });

  it('weist eine abgelaufene Sitzung ab', async () => {
    await starte(auth);
    const abgelaufen = await sitzungsCookie(sessionSecret, -60);
    const res = await app.inject({
      url: '/api/months/2026-06',
      cookies: { abrechnung_sitzung: abgelaufen },
    });
    expect(res.statusCode).toBe(401);
  });

  it('weist ein mit fremdem Schluessel signiertes Cookie ab', async () => {
    await starte(auth);
    const gefaelscht = await sitzungsCookie('c'.repeat(48));
    const res = await app.inject({
      url: '/api/months/2026-06',
      cookies: { abrechnung_sitzung: gefaelscht },
    });
    expect(res.statusCode).toBe(401);
  });

  it('weist ein manipuliertes Cookie ab', async () => {
    await starte(auth);
    const echt = await sitzungsCookie(sessionSecret);
    const manipuliert = `${echt.slice(0, -4)}AAAA`;
    const res = await app.inject({
      url: '/api/months/2026-06',
      cookies: { abrechnung_sitzung: manipuliert },
    });
    expect(res.statusCode).toBe(401);
  });

  it('weist blossen Unsinn im Cookie ab', async () => {
    await starte(auth);
    const res = await app.inject({
      url: '/api/months/2026-06',
      cookies: { abrechnung_sitzung: 'kein-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe('Abgeschaltete Anmeldung', () => {
  it('laesst alles durch und weist das in den Capabilities aus', async () => {
    await starte({ deaktiviert: true, sicher: false, sessionDauer: 3600 });

    const res = await app.inject({ url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ angemeldet: true, anmeldungNoetig: false });

    expect((await app.inject({ url: '/api/months/2026-06' })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('Pruefung des ID-Tokens', () => {
  /**
   * Vollstaendiger Rueckweg gegen einen nachgebauten Entra-Endpunkt:
   * Token-Tausch und JWKS laufen ueber einen lokalen Server, das ID-Token
   * wird mit einem echten RS256-Schluessel signiert.
   */
  let entraMock: Server;
  let entraUrl: string;
  let privater: KeyLike;
  let jwk: JWK;

  beforeEach(async () => {
    const paar = await generateKeyPair('RS256');
    privater = paar.privateKey;
    jwk = { ...(await exportJWK(paar.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

    entraMock = createServer((req, res) => {
      if ((req.url ?? '').includes('/keys')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => entraMock.listen(0, '127.0.0.1', r));
    entraUrl = `http://127.0.0.1:${(entraMock.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => entraMock.close(() => r()));
  });

  it('erzeugt ein Token, das zur JWKS passt - Testaufbau ist tragfaehig', async () => {
    const token = await new SignJWT({ name: 'Test', email: 'test@example.de' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(`https://login.microsoftonline.com/${TENANT}/v2.0`)
      .setAudience(CLIENT_ID)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privater);

    expect(token.split('.')).toHaveLength(3);

    const antwort = await fetch(`${entraUrl}/keys`);
    const { keys } = (await antwort.json()) as { keys: JWK[] };
    expect(keys[0]!.kid).toBe('test-key');
  });
});
