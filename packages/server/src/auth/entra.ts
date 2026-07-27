import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { AngemeldeterBenutzer } from '@abrechnung/shared';
import { EingabeFehler } from '../fehler.js';

/**
 * Anmeldung ueber Microsoft Entra ID (frueher Azure AD).
 *
 * Verwendet den Authorization Code Flow mit PKCE. Der Browser bekommt zu
 * keinem Zeitpunkt ein Microsoft-Token zu sehen: der Code wird serverseitig
 * gegen Tokens getauscht, das ID-Token wird gegen die JWKS des Tenants
 * geprueft, und anschliessend wird eine eigene, kurzlebige Sitzung als
 * signiertes Cookie ausgestellt. Der Server bleibt damit zustandslos - es gibt
 * keine Sitzungstabelle, die gepflegt werden muesste.
 */

export interface EntraKonfiguration {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Muss exakt der in Entra hinterlegten Redirect-URI entsprechen. */
  redirectUri: string;
  /** Schluessel zum Signieren der eigenen Sitzungscookies. */
  sessionSecret: string;
  /** Sitzungsdauer in Sekunden. */
  sessionDauer: number;
  /**
   * Optionale Einschraenkung auf einzelne Konten. Leer = jedes Konto des
   * Tenants darf hinein. E-Mail-Adressen, Vergleich ohne Gross-/Kleinschreibung.
   */
  erlaubteBenutzer: string[];
  /** Optionale Einschraenkung auf Entra-Gruppen (Object-IDs). */
  erlaubteGruppen: string[];
}

export interface AnmeldeStart {
  /** URL, auf die der Browser umgeleitet wird. */
  autorisierungsUrl: string;
  /** Inhalt des kurzlebigen Cookies, das den Rueckweg absichert. */
  uebergang: string;
}

interface UebergangsDaten extends JWTPayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  ziel: string;
}

export class EntraAnmeldung {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly schluessel: Uint8Array;

  constructor(private readonly config: EntraKonfiguration) {
    this.jwks = createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
      ),
    );
    this.schluessel = new TextEncoder().encode(config.sessionSecret);
  }

  private get autorisierungsEndpunkt(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/authorize`;
  }

  private get tokenEndpunkt(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
  }

  private get aussteller(): string {
    return `https://login.microsoftonline.com/${this.config.tenantId}/v2.0`;
  }

  /** URL, auf die nach dem Abmelden umgeleitet wird. */
  abmeldeUrl(zurueck: string): string {
    const url = new URL(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/logout`,
    );
    url.searchParams.set('post_logout_redirect_uri', zurueck);
    return url.toString();
  }

  /**
   * Beginnt die Anmeldung. `ziel` ist der Pfad, auf den nach erfolgreicher
   * Anmeldung zurueckgesprungen wird.
   */
  async starte(ziel: string): Promise<AnmeldeStart> {
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const url = new URL(this.autorisierungsEndpunkt);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_mode', 'query');
    // openid/profile/email genuegen - die Anwendung braucht keine Graph-Rechte.
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    // Der Uebergangszustand liegt signiert im Browser, nicht im Serverspeicher.
    // Damit ueberlebt eine laufende Anmeldung auch einen Neustart des Servers.
    const uebergang = await new SignJWT({ state, nonce, codeVerifier, ziel })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(this.schluessel);

    return { autorisierungsUrl: url.toString(), uebergang };
  }

  /**
   * Schliesst die Anmeldung ab: prueft state, tauscht den Code gegen Tokens
   * und verifiziert das ID-Token.
   */
  async schliesseAb(
    code: string,
    state: string,
    uebergangsCookie: string | undefined,
  ): Promise<{ benutzer: AngemeldeterBenutzer; ziel: string }> {
    if (!uebergangsCookie) {
      throw new EingabeFehler(
        'Die Anmeldung ist abgelaufen oder wurde in einem anderen Browser begonnen. Bitte erneut anmelden.',
      );
    }

    let uebergang: UebergangsDaten;
    try {
      const { payload } = await jwtVerify(uebergangsCookie, this.schluessel);
      uebergang = payload as UebergangsDaten;
    } catch {
      throw new EingabeFehler('Der Anmeldevorgang ist ungueltig oder abgelaufen.');
    }

    // Vergleich in konstanter Zeit - state schuetzt gegen CSRF auf dem Rueckweg.
    if (!gleichSicher(uebergang.state, state)) {
      throw new EingabeFehler('Der Anmeldevorgang konnte nicht zugeordnet werden.');
    }

    const antwort = await fetch(this.tokenEndpunkt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: uebergang.codeVerifier,
        scope: 'openid profile email',
      }),
    });

    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      throw new Error(
        `Entra hat den Token-Tausch abgelehnt (HTTP ${antwort.status}): ${text.slice(0, 300)}`,
      );
    }

    const tokens = (await antwort.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new Error('Entra hat kein ID-Token geliefert.');
    }

    // Signatur, Aussteller und Zielgruppe pruefen - ohne das waere jedes
    // beliebige Token akzeptabel.
    const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
      issuer: this.aussteller,
      audience: this.config.clientId,
    });

    if (payload.nonce !== uebergang.nonce) {
      throw new EingabeFehler('Das Anmeldetoken passt nicht zum Anmeldevorgang.');
    }

    const benutzer = leseBenutzer(payload);
    this.pruefeBerechtigung(benutzer, payload);

    return { benutzer, ziel: uebergang.ziel };
  }

  /**
   * Prueft die optionale Positivliste. Ohne Konfiguration darf jedes Konto des
   * Tenants hinein - der Tenant selbst ist bereits die aeussere Schranke, weil
   * das Token gegen seinen Aussteller geprueft wurde.
   */
  private pruefeBerechtigung(benutzer: AngemeldeterBenutzer, payload: JWTPayload): void {
    const { erlaubteBenutzer, erlaubteGruppen } = this.config;
    if (erlaubteBenutzer.length === 0 && erlaubteGruppen.length === 0) return;

    const email = benutzer.email?.toLowerCase() ?? '';
    if (erlaubteBenutzer.some((e) => e.toLowerCase() === email)) return;

    const gruppen = Array.isArray(payload.groups) ? (payload.groups as string[]) : [];
    if (gruppen.some((g) => erlaubteGruppen.includes(g))) return;

    const fehler = new Error(
      `Das Konto ${benutzer.email ?? benutzer.name} ist fuer diese Anwendung nicht freigeschaltet.`,
    ) as Error & { statusCode?: number };
    fehler.statusCode = 403;
    throw fehler;
  }

  /** Stellt das eigene Sitzungscookie aus. */
  async erzeugeSitzung(benutzer: AngemeldeterBenutzer): Promise<string> {
    return new SignJWT({ ...benutzer })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${this.config.sessionDauer}s`)
      .sign(this.schluessel);
  }

  /** Liest eine bestehende Sitzung. null, wenn ungueltig oder abgelaufen. */
  async leseSitzung(cookie: string | undefined): Promise<AngemeldeterBenutzer | null> {
    if (!cookie) return null;
    try {
      const { payload } = await jwtVerify(cookie, this.schluessel);
      return {
        sub: String(payload.sub ?? ''),
        name: String(payload.name ?? ''),
        email: payload.email ? String(payload.email) : undefined,
      };
    } catch {
      return null;
    }
  }
}

function leseBenutzer(payload: JWTPayload): AngemeldeterBenutzer {
  // Entra liefert die Adresse je nach Kontotyp in unterschiedlichen Feldern.
  const email =
    (payload.email as string | undefined) ??
    (payload.preferred_username as string | undefined) ??
    (payload.upn as string | undefined);

  return {
    sub: String(payload.sub ?? ''),
    name: String(payload.name ?? email ?? 'Unbekannt'),
    email,
  };
}

function gleichSicher(a: string, b: string): boolean {
  const pa = Buffer.from(a);
  const pb = Buffer.from(b);
  if (pa.length !== pb.length) return false;
  return timingSafeEqual(pa, pb);
}
