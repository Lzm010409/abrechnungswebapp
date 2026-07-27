import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AngemeldeterBenutzer } from '@abrechnung/shared';
import type { EntraAnmeldung } from './entra.js';

/** Sitzungscookie - haelt die angemeldete Person. */
const SITZUNG = 'abrechnung_sitzung';
/** Kurzlebiges Cookie, das den Rueckweg der Anmeldung absichert. */
const UEBERGANG = 'abrechnung_anmeldung';

declare module 'fastify' {
  interface FastifyRequest {
    benutzer?: AngemeldeterBenutzer;
  }
}

export interface AuthOptionen {
  entra?: EntraAnmeldung;
  /** true, wenn bewusst ohne Anmeldung gearbeitet wird (nur lokal). */
  deaktiviert: boolean;
  /** Cookies nur ueber HTTPS ausliefern. */
  sicher: boolean;
  sessionDauer: number;
}

/**
 * Haengt Anmelderouten ein und schuetzt die API.
 *
 * Geschuetzt wird alles unter /api/ mit Ausnahme von /api/health - der
 * Health-Check des Containers darf nicht an der Anmeldung scheitern. Die
 * Auslieferung des Frontends bleibt offen; ohne gueltige Sitzung zeigt es
 * lediglich die Anmeldeseite und bekommt von der API nichts als 401.
 */
export async function registriereAuth(
  app: FastifyInstance,
  opts: AuthOptionen,
): Promise<void> {
  await app.register(cookie);

  const cookieOptionen = {
    httpOnly: true,
    secure: opts.sicher,
    sameSite: 'lax' as const,
    path: '/',
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const pfad = req.url.split('?')[0] ?? '';

    if (!pfad.startsWith('/api/')) return;
    if (pfad === '/api/health') return;

    if (opts.deaktiviert) {
      req.benutzer = { sub: 'lokal', name: 'Anmeldung deaktiviert' };
      return;
    }

    const benutzer = await opts.entra!.leseSitzung(req.cookies[SITZUNG]);
    if (!benutzer) {
      // /api/capabilities beantwortet die Frage "bin ich angemeldet?" und muss
      // deshalb eine verwertbare Antwort geben statt eines nackten 401.
      if (pfad === '/api/capabilities') {
        return reply.send({
          angemeldet: false,
          ki: false,
          n8nRechnungsabruf: false,
          sevdesk: false,
          anmeldungNoetig: true,
        });
      }
      return reply.status(401).send({
        fehler: 'Nicht angemeldet.',
        anmeldungNoetig: true,
      });
    }

    req.benutzer = benutzer;
  });

  // -------------------------------------------------------------------------

  if (opts.deaktiviert) {
    app.get('/auth/me', async () => ({
      angemeldet: true,
      benutzer: { sub: 'lokal', name: 'Anmeldung deaktiviert' },
      anmeldungAktiv: false,
    }));
    return;
  }

  const entra = opts.entra!;

  app.get<{ Querystring: { redirect?: string } }>('/auth/login', async (req, reply) => {
    const ziel = sichererPfad(req.query.redirect);
    // Ohne feste ENTRA_REDIRECT_URI wird der Rueckweg aus der aufgerufenen
    // Adresse gebildet - eine Variable weniger, die zur Umgebung passen muss.
    const { autorisierungsUrl, uebergang } = await entra.starte(ziel, ganzeUrl(req));

    return reply
      .setCookie(UEBERGANG, uebergang, { ...cookieOptionen, maxAge: 600 })
      .redirect(autorisierungsUrl);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const { code, state, error, error_description } = req.query;

      if (error) {
        req.log.warn({ error, error_description }, 'Entra hat die Anmeldung abgelehnt');
        return reply
          .status(403)
          .type('text/html; charset=utf-8')
          .send(fehlerSeite('Anmeldung abgelehnt', error_description ?? error));
      }

      if (!code || !state) {
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(fehlerSeite('Unvollständige Antwort', 'Entra hat keinen Code geliefert.'));
      }

      try {
        const { benutzer, ziel } = await entra.schliesseAb(
          code,
          state,
          req.cookies[UEBERGANG],
        );
        const sitzung = await entra.erzeugeSitzung(benutzer);

        req.log.info({ benutzer: benutzer.email ?? benutzer.sub }, 'Anmeldung erfolgreich');

        return reply
          .clearCookie(UEBERGANG, cookieOptionen)
          .setCookie(SITZUNG, sitzung, { ...cookieOptionen, maxAge: opts.sessionDauer })
          .redirect(ziel);
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        req.log.warn({ err: meldung }, 'Anmeldung fehlgeschlagen');
        const status = (err as { statusCode?: number }).statusCode ?? 400;
        return reply
          .status(status)
          .type('text/html; charset=utf-8')
          .send(fehlerSeite('Anmeldung fehlgeschlagen', meldung));
      }
    },
  );

  app.get('/auth/me', async (req) => {
    const benutzer = await entra.leseSitzung(req.cookies[SITZUNG]);
    return benutzer
      ? { angemeldet: true, benutzer, anmeldungAktiv: true }
      : { angemeldet: false, anmeldungAktiv: true };
  });

  app.post<{ Body?: { abmeldenBeiMicrosoft?: boolean } }>(
    '/auth/logout',
    async (req, reply) => {
      reply.clearCookie(SITZUNG, cookieOptionen);

      // Nur die lokale Sitzung beenden, oder auch die Microsoft-Sitzung.
      if (req.body?.abmeldenBeiMicrosoft) {
        const zurueck = new URL('/', ganzeUrl(req)).toString();
        return reply.send({ abgemeldet: true, weiterZu: entra.abmeldeUrl(zurueck) });
      }
      return reply.send({ abgemeldet: true });
    },
  );
}

/**
 * Laesst nur anwendungsinterne Pfade als Rueckkehrziel zu.
 * Ohne diese Pruefung liesse sich die Anmeldung als offener Redirect
 * missbrauchen, um Nutzer auf fremde Seiten zu schicken.
 */
function sichererPfad(roh: string | undefined): string {
  if (!roh) return '/';
  if (!roh.startsWith('/') || roh.startsWith('//')) return '/';
  return roh;
}

function ganzeUrl(req: FastifyRequest): string {
  const protokoll = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  return `${protokoll}://${req.headers.host}`;
}

function fehlerSeite(titel: string, text: string): string {
  const sicher = (s: string) =>
    s.replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
    );

  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>${sicher(titel)}</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      background:#f7f8fa;color:#1a1d21;display:flex;align-items:center;
      justify-content:center;height:100vh;margin:0}
 .karte{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:32px;
        max-width:460px}
 h1{font-size:18px;margin:0 0 10px}
 p{color:#6b7280;font-size:14px;line-height:1.5}
 a{display:inline-block;margin-top:16px;background:#1f5fa9;color:#fff;
   padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px}
</style></head><body><div class="karte">
<h1>${sicher(titel)}</h1><p>${sicher(text)}</p>
<a href="/auth/login">Erneut anmelden</a>
</div></body></html>`;
}
