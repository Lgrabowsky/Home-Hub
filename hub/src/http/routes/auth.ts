import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_VERSION,
  type BootstrapInfo,
  type LoginResponse,
  type MeResponse,
  type SessionInfo,
  type TotpEnableResponse,
  type TotpSetupResponse,
  type UserPrefs,
} from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { publicSession } from '../../auth/sessions.ts';
import { publicUser, type UserRecord } from '../../auth/users.ts';
import { dummyVerify, hashPassword, needsRehash, verifyPassword } from '../../security/password.ts';
import { LOGIN_RULES } from '../../security/throttle.ts';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../../security/totp.ts';
import { HttpError, forbidden, notFound } from '../errors.ts';
import { actor, auth, clearSessionCookie, parseBody, setSessionCookie } from '../server.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  code: z.string().trim().max(20).optional(),
  client: z.enum(['web', 'native']).default('web'),
  deviceName: z.string().trim().max(80).optional(),
});

const setupSchema = z.object({
  setupCode: z.string().trim().min(1).max(40),
  username: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(60).optional(),
  password: z.string().min(1).max(256),
  client: z.enum(['web', 'native']).default('web'),
  deviceName: z.string().trim().max(80).optional(),
});

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} Sekunden`;
  return `${Math.ceil(seconds / 60)} Minuten`;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: HubContext): void {
  const { users, sessions, audit, throttle, settings } = ctx;

  /** Creates the session and hands the token to the client in the way that suits it. */
  function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: UserRecord,
    client: 'web' | 'native',
    deviceName: string | undefined,
  ): LoginResponse {
    const mustEnroll = !user.totpEnabled && settings.get('general').requireTotp;
    const { token } = sessions.create(user.id, {
      kind: mustEnroll ? 'enroll' : 'full',
      client,
      deviceName,
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });
    if (client === 'web') setSessionCookie(ctx, request, reply, token);
    const base = { user: publicUser(user), ...(client === 'native' ? { token } : {}) };
    return mustEnroll ? { status: 'enroll_required', ...base } : { status: 'ok', ...base };
  }

  function verifySecondFactor(user: UserRecord, code: string): boolean {
    if (looksLikeRecoveryCode(code)) return users.consumeRecoveryCode(user.id, hashRecoveryCode(code));
    const secret = users.getTotpSecret(user.id);
    if (!secret) return false;
    const step = verifyTotp(secret, code, user.totpLastStep);
    return step !== null && users.consumeTotpStep(user.id, step);
  }

  async function requirePassword(request: FastifyRequest, password: string): Promise<UserRecord> {
    const { user } = auth(request);
    const key = `reauth:${user.id}`;
    const wait = throttle.retryAfter([key]);
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte in ${formatWait(wait)} erneut versuchen.`, wait);
    if (!(await verifyPassword(password, user.passwordHash))) {
      throttle.fail(key, LOGIN_RULES.pair);
      throw new HttpError(403, 'wrong_password', 'Das Passwort ist falsch.');
    }
    throttle.reset(key);
    return user;
  }

  // --- Public ------------------------------------------------------------------------

  app.get('/api/bootstrap', { config: { access: 'public' } }, async (request): Promise<BootstrapInfo> => {
    // Deliberately says nothing about the household to visitors who are not signed in.
    const signedIn = request.auth?.session.kind === 'full';
    return {
      apiVersion: API_VERSION,
      hubName: signedIn ? ctx.state.hubName : 'Home Hub',
      setupRequired: ctx.setup.required,
      demo: ctx.config.demo,
      version: signedIn ? ctx.config.version : '',
    };
  });

  app.post('/api/setup', { config: { access: 'public', sensitive: true } }, async (request, reply): Promise<LoginResponse> => {
    const body = parseBody(setupSchema, request.body);
    if (!ctx.setup.required) throw new HttpError(409, 'already_set_up', 'Der Hub ist bereits eingerichtet.');
    const key = `setup:${request.ip}`;
    const wait = throttle.retryAfter([key, 'setup:*']);
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte in ${formatWait(wait)} erneut versuchen.`, wait);
    if (!ctx.setup.verify(body.setupCode)) {
      throttle.fail(key, LOGIN_RULES.pair);
      throttle.fail('setup:*', LOGIN_RULES.ip);
      audit.record('setup.failed', { ip: request.ip });
      throw new HttpError(403, 'invalid_setup_code', 'Der Einrichtungscode stimmt nicht. Er steht im Protokoll des Hubs.');
    }
    const user = await users.create({ username: body.username, displayName: body.displayName, role: 'admin', password: body.password });
    ctx.setup.complete();
    audit.record('setup.completed', { userId: user.id, username: user.username, ip: request.ip });
    return startSession(request, reply, user, body.client, body.deviceName);
  });

  app.post('/api/auth/login', { config: { access: 'public', sensitive: true } }, async (request, reply): Promise<LoginResponse> => {
    const body = parseBody(loginSchema, request.body);
    const username = body.username.toLowerCase();
    const keys = { pair: `pair:${username}|${request.ip}`, ip: `ip:${request.ip}`, user: `user:${username}` };

    const wait = throttle.retryAfter(Object.values(keys));
    if (wait > 0) {
      throw new HttpError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte in ${formatWait(wait)} erneut versuchen.`, wait);
    }
    const fail = (reason: string, status: number, code: string, message: string): never => {
      throttle.fail(keys.pair, LOGIN_RULES.pair);
      throttle.fail(keys.ip, LOGIN_RULES.ip);
      throttle.fail(keys.user, LOGIN_RULES.user);
      audit.record('login.failed', { username: body.username.slice(0, 64), ip: request.ip }, { reason });
      throw new HttpError(status, code, message);
    };

    const user = users.getByUsername(body.username);
    // Always do the expensive comparison so response times do not reveal which accounts exist.
    const passwordOk = user && !user.disabled ? await verifyPassword(body.password, user.passwordHash) : await dummyVerify(body.password);
    if (!user || user.disabled || !passwordOk) {
      return fail('credentials', 401, 'invalid_credentials', 'Benutzername oder Passwort ist falsch.');
    }

    if (user.totpEnabled) {
      if (!body.code) return { status: 'totp_required' };
      if (!verifySecondFactor(user, body.code)) {
        return fail('second_factor', 401, 'invalid_code', 'Der Code ist falsch oder abgelaufen.');
      }
    }

    throttle.reset(keys.pair);
    throttle.reset(keys.user);
    if (needsRehash(user.passwordHash)) users.setPasswordHash(user.id, await hashPassword(body.password));
    audit.record('login.success', { userId: user.id, username: user.username, ip: request.ip }, { client: body.client });
    return startSession(request, reply, user, body.client, body.deviceName);
  });

  // --- Signed in (also during 2FA enrolment) -----------------------------------------

  app.post('/api/auth/logout', { config: { access: 'enroll' } }, async (request, reply) => {
    const { session } = auth(request);
    sessions.revoke(session.id);
    clearSessionCookie(request, reply);
    audit.record('logout', actor(request));
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { access: 'enroll' } }, async (request): Promise<MeResponse> => {
    const { user, session } = auth(request);
    return {
      user: publicUser(user),
      session: publicSession(session, session.id),
      prefs: users.getPrefs(user.id),
      enrollRequired: session.kind === 'enroll',
    };
  });

  app.post('/api/auth/totp/setup', { config: { access: 'enroll', sensitive: true } }, async (request): Promise<TotpSetupResponse> => {
    const { user } = auth(request);
    if (user.totpEnabled) {
      throw new HttpError(409, 'totp_active', 'Die Zwei-Faktor-Anmeldung ist bereits aktiv. Deaktiviere sie zuerst, um sie neu einzurichten.');
    }
    const secret = generateTotpSecret();
    users.setPendingTotpSecret(user.id, secret);
    return { secret, otpauthUrl: otpauthUrl(secret, user.username, 'Home Hub') };
  });

  app.post('/api/auth/totp/enable', { config: { access: 'enroll', sensitive: true } }, async (request, reply): Promise<TotpEnableResponse> => {
    const body = parseBody(z.object({ code: z.string().trim().min(6).max(10) }), request.body);
    const { user, session } = auth(request);
    if (user.totpEnabled) throw new HttpError(409, 'totp_active', 'Die Zwei-Faktor-Anmeldung ist bereits aktiv.');
    const secret = users.getTotpSecret(user.id);
    if (!secret) throw new HttpError(409, 'totp_not_started', 'Bitte starte die Einrichtung erneut.');

    const key = `totp-enable:${user.id}`;
    const wait = throttle.retryAfter([key]);
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', `Zu viele Fehlversuche. Bitte in ${formatWait(wait)} erneut versuchen.`, wait);
    const step = verifyTotp(secret, body.code, 0);
    if (step === null) {
      throttle.fail(key, LOGIN_RULES.pair);
      throw new HttpError(400, 'invalid_code', 'Der Code stimmt nicht. Prüfe die Uhrzeit deines Geräts und versuche es erneut.');
    }
    throttle.reset(key);

    const recoveryCodes = generateRecoveryCodes();
    users.enableTotp(user.id, step, recoveryCodes.map(hashRecoveryCode));
    audit.record('totp.enabled', actor(request));

    if (session.kind === 'enroll') {
      const promoted = sessions.promote(session);
      if (session.client === 'web') setSessionCookie(ctx, request, reply, promoted.token);
      return { recoveryCodes, ...(session.client === 'native' ? { token: promoted.token } : {}) };
    }
    return { recoveryCodes };
  });

  // --- Fully signed in ----------------------------------------------------------------

  app.post('/api/auth/totp/disable', { config: { sensitive: true } }, async (request) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(256) }), request.body);
    const user = await requirePassword(request, body.password);
    users.disableTotp(user.id);
    audit.record('totp.disabled', actor(request));
    return { ok: true, requireTotp: settings.get('general').requireTotp };
  });

  app.post('/api/auth/recovery-codes', { config: { sensitive: true } }, async (request) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(256) }), request.body);
    const user = await requirePassword(request, body.password);
    if (!user.totpEnabled) throw new HttpError(409, 'totp_inactive', 'Die Zwei-Faktor-Anmeldung ist nicht aktiv.');
    const recoveryCodes = generateRecoveryCodes();
    users.enableTotp(user.id, user.totpLastStep, recoveryCodes.map(hashRecoveryCode));
    audit.record('totp.recovery_codes_renewed', actor(request));
    return { recoveryCodes };
  });

  app.post('/api/auth/password', { config: { sensitive: true } }, async (request) => {
    const body = parseBody(z.object({ current: z.string().min(1).max(256), next: z.string().min(1).max(256) }), request.body);
    const user = await requirePassword(request, body.current);
    await users.setPassword(user.id, body.next);
    // Every other device has to sign in again with the new password.
    const revoked = sessions.revokeAllForUser(user.id, auth(request).session.id);
    audit.record('password.changed', actor(request), { revokedSessions: revoked });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (request): Promise<{ sessions: SessionInfo[] }> => {
    const { user, session } = auth(request);
    return { sessions: sessions.list(user.id).map((s) => publicSession(s, session.id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (request, reply) => {
    const { user, session } = auth(request);
    const target = sessions.get(request.params.id);
    if (!target || target.userId !== user.id) throw notFound('Diese Anmeldung gibt es nicht (mehr).');
    sessions.revoke(target.id);
    if (target.id === session.id) clearSessionCookie(request, reply);
    audit.record('session.revoked', actor(request), { device: target.deviceName ?? target.userAgent?.slice(0, 60) ?? null });
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (request) => {
    const { user, session } = auth(request);
    const count = sessions.revokeAllForUser(user.id, session.id);
    audit.record('session.revoked_others', actor(request), { count });
    return { ok: true, count };
  });

  /** One-time ticket for opening a WebSocket (see auth/tickets.ts). */
  app.post('/api/auth/ticket', async (request) => {
    const body = parseBody(z.object({ scope: z.enum(['realtime', 'media']) }), request.body);
    const { user, session } = auth(request);
    if (body.scope === 'media' && user.role !== 'admin' && !user.permissions.some((p) => p === 'cameras.view' || p === 'doors.view')) {
      throw forbidden();
    }
    return { ticket: ctx.tickets.issue(session.id, body.scope) };
  });

  app.put('/api/prefs', async (request): Promise<{ prefs: UserPrefs }> => {
    const { user } = auth(request);
    return { prefs: users.setPrefs(user.id, request.body) };
  });
}
