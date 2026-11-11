import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { hasPermission, type ApiError, type Permission } from '@home-hub/shared';
import type { AuthContext } from '../auth/sessions.ts';
import { NATIVE_APP_ORIGINS } from '../config.ts';
import type { HubContext } from '../context.ts';
import { HttpError, forbidden, unauthorized } from './errors.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerHomeRoutes } from './routes/home.ts';
import { registerDoorRoutes } from './routes/doors.ts';
import { registerCameraRoutes } from './routes/cameras.ts';
import { registerMusicRoutes } from './routes/music.ts';
import { registerRealtimeRoutes } from './routes/realtime.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    authVia: 'cookie' | 'bearer' | null;
  }
  interface FastifyContextConfig {
    /**
     * Who may call the route. Routes are private by default (`user`):
     * forgetting the annotation can never open something up.
     */
    access?: 'public' | 'enroll' | 'user' | 'admin';
    permission?: Permission;
    /** Credential endpoints get a much stricter request budget. */
    sensitive?: boolean;
  }
}

export const COOKIE_SECURE = '__Host-hh_session';
export const COOKIE_PLAIN = 'hh_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'HomeHub';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

/** The origin the browser must report for same-origin requests. */
export function expectedOrigins(ctx: HubContext, request: FastifyRequest): string[] {
  const origins = [`${request.protocol}://${request.host}`];
  if (ctx.config.publicUrl) origins.push(ctx.config.publicUrl.origin);
  return origins;
}

export function isAllowedAppOrigin(ctx: HubContext, origin: string): boolean {
  return NATIVE_APP_ORIGINS.includes(origin) || ctx.config.extraOrigins.includes(origin);
}

export function setSessionCookie(ctx: HubContext, request: FastifyRequest, reply: FastifyReply, token: string): void {
  const secure = isSecureRequest(request);
  const days = ctx.settings.get('general').sessionDays;
  reply.setCookie(secure ? COOKIE_SECURE : COOKIE_PLAIN, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: days * 24 * 60 * 60,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  for (const [name, secure] of [
    [COOKIE_SECURE, true],
    [COOKIE_PLAIN, false],
  ] as const) {
    if (secure && !isSecureRequest(request)) continue;
    reply.clearCookie(name, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'bad_request', `Ungültige Eingabe (${where}${issue?.message ?? 'unbekannt'}).`);
  }
  return result.data;
}

/** The authenticated context; only call inside routes that are not `public`. */
export function auth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function actor(request: FastifyRequest): { userId: string | null; username: string | null; ip: string } {
  return { userId: request.auth?.user.id ?? null, username: request.auth?.user.username ?? null, ip: request.ip };
}

function securityHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  if (isSecureRequest(request)) reply.header('Strict-Transport-Security', 'max-age=15552000');
}

/** Trust exactly `hops` proxies in front of the hub when reading X-Forwarded-* headers. */
function trustHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}

export async function buildServer(ctx: HubContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log.child({ mod: 'http' }),
    // Requests are logged by our own onResponse hook (without query strings, which may carry tickets).
    logController: new LogController({ disableRequestLogging: true }),
    // A number means "this many reverse proxies in front of the hub".
    trustProxy: typeof ctx.config.trustProxy === 'number' ? trustHops(ctx.config.trustProxy) : ctx.config.trustProxy,
    bodyLimit: 512 * 1024,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 300 },
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  app.decorateRequest('auth', null);
  app.decorateRequest('authVia', null);

  app.addHook('onRequest', async (request, reply) => {
    securityHeaders(request, reply);
    const path = request.url.split('?', 1)[0]!;
    if (!path.startsWith('/api/')) return;

    reply.header('Cache-Control', 'no-store');

    // --- CORS: only the packaged app shells may call the API cross-origin, and only with a bearer token.
    const origin = request.headers.origin;
    if (origin && isAllowedAppOrigin(ctx, origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Expose-Headers', 'Retry-After, X-Event-Ts, Content-Length');
      if (request.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With');
        reply.header('Access-Control-Max-Age', '600');
        return reply.code(204).send();
      }
    }

    // --- Rate limits
    const config = request.routeOptions.config;
    const limiter = config.sensitive ? ctx.authLimiter : ctx.apiLimiter;
    const wait = limiter.hit(request.ip);
    if (wait > 0) throw new HttpError(429, 'rate_limited', 'Zu viele Anfragen. Bitte kurz warten.', wait);

    // --- Authentication
    const access = config.access ?? 'user';
    let token: string | null = null;
    const header = request.headers.authorization;
    if (header && /^bearer /i.test(header)) {
      token = header.slice(7).trim();
      request.authVia = 'bearer';
    } else {
      token = request.cookies[COOKIE_SECURE] ?? request.cookies[COOKIE_PLAIN] ?? null;
      if (token) request.authVia = 'cookie';
    }

    if (token && request.authVia === 'cookie') {
      // Cookies are ambient credentials: make sure the request really comes from our own pages.
      const site = request.headers['sec-fetch-site'];
      const safe = SAFE_METHODS.has(request.method);
      const crossSite = typeof site === 'string' && site !== 'same-origin' && !(safe && site === 'none');
      const badOrigin = Boolean(origin) && !expectedOrigins(ctx, request).includes(origin!);
      const missingHeader = !safe && request.headers[CSRF_HEADER] !== CSRF_VALUE;
      if (crossSite || badOrigin || missingHeader) {
        if (access === 'public') token = null;
        else throw new HttpError(403, 'csrf', 'Die Anfrage wurde aus Sicherheitsgründen abgelehnt.');
      }
    }

    if (token) request.auth = ctx.sessions.authenticate(token, request.ip);
    if (access === 'public') return;
    if (!request.auth) throw unauthorized();
    if (request.auth.session.kind === 'enroll' && access !== 'enroll') {
      throw new HttpError(403, 'enroll_required', 'Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.');
    }
    if (access === 'admin' && request.auth.user.role !== 'admin') throw forbidden('Nur für Administratoren.');
    if (config.permission && !hasPermission(request.auth.user, config.permission)) throw forbidden();
  });

  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!;
    if (!path.startsWith('/api/')) return;
    const record = {
      method: request.method,
      path,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      user: request.auth?.user.username,
    };
    if (reply.statusCode >= 500) app.log.warn(record, 'request failed');
    else if (SAFE_METHODS.has(request.method)) app.log.debug(record, 'request');
    else app.log.info(record, 'request');
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfter) reply.header('Retry-After', String(error.retryAfter));
      const body: ApiError = { error: error.code, message: error.message, retryAfter: error.retryAfter };
      return reply.code(error.statusCode).send(body);
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const body: ApiError = { error: 'bad_request', message: 'Die Anfrage konnte nicht verarbeitet werden.' };
      return reply.code(status).send(body);
    }
    app.log.error({ err: error, path: request.url.split('?', 1)[0] }, 'unhandled error');
    const body: ApiError = { error: 'internal', message: 'Interner Fehler im Hub. Details stehen im Protokoll.' };
    return reply.code(500).send(body);
  });

  // Preflight for every API path (the hook above answers it).
  app.options('/api/*', { config: { access: 'public' } }, async (_request, reply) => reply.code(204).send());

  app.get('/api/health', { config: { access: 'public' } }, async () => ({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerHomeRoutes(app, ctx);
  registerDoorRoutes(app, ctx);
  registerCameraRoutes(app, ctx);
  registerMusicRoutes(app, ctx);
  registerRealtimeRoutes(app, ctx);

  // --- Web app (static files + SPA fallback) ---------------------------------------
  if (ctx.config.webDir) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDir,
      // Files are looked up per request, so a rebuilt web app is picked up without restarting the hub.
      wildcard: true,
      dotfiles: 'ignore',
      setHeaders(reply, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?', 1)[0]!;
    const wantsHtml = request.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]{2,5}$/i.test(path);
    if (wantsHtml && ctx.config.webDir) {
      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    const body: ApiError = { error: 'not_found', message: 'Nicht gefunden.' };
    return reply.code(404).send(body);
  });

  return app;
}
