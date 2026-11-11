import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, ROLES, type UserInfo } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { publicUser } from '../../auth/users.ts';
import { HttpError, notFound } from '../errors.ts';
import { actor, auth, parseBody } from '../server.ts';

const role = z.enum(ROLES);
const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const createSchema = z.object({
  username: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(60).optional(),
  role,
  permissions: permissions.optional(),
  password: z.string().min(1).max(256),
});

const updateSchema = z.object({
  displayName: z.string().trim().max(60).optional(),
  role: role.optional(),
  permissions: permissions.optional(),
  disabled: z.boolean().optional(),
});

/** User administration — administrators only. */
export function registerUserRoutes(app: FastifyInstance, ctx: HubContext): void {
  const { users, sessions, audit, realtime } = ctx;
  const admin = { config: { access: 'admin' as const } };
  const adminSensitive = { config: { access: 'admin' as const, sensitive: true } };

  app.get('/api/users', admin, async (): Promise<{ users: UserInfo[] }> => ({ users: users.list().map(publicUser) }));

  app.post('/api/users', adminSensitive, async (request): Promise<{ user: UserInfo }> => {
    const body = parseBody(createSchema, request.body);
    const user = await users.create(body);
    audit.record('user.created', actor(request), { username: user.username, role: user.role });
    return { user: publicUser(user) };
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', admin, async (request): Promise<{ user: UserInfo }> => {
    const body = parseBody(updateSchema, request.body);
    const before = users.get(request.params.id);
    if (!before) throw notFound('Benutzer nicht gefunden.');
    if (before.id === auth(request).user.id && (body.disabled === true || (body.role && body.role !== 'admin'))) {
      throw new HttpError(409, 'self_lockout', 'Du kannst dir die Administratorrechte nicht selbst entziehen.');
    }
    const user = users.update(before.id, body);
    if (user.disabled) sessions.revokeAllForUser(user.id);
    else {
      realtime.refreshUser(user.id);
      // Streams that are already open must not outlive a permission that was taken away.
      const lost = before.role === 'admin' && user.role !== 'admin' ? true : before.permissions.some((permission) => !user.permissions.includes(permission));
      if (lost) ctx.integrations.media.revokeUser(sessions.list(user.id).map((session) => session.id));
    }
    audit.record('user.updated', actor(request), {
      username: user.username,
      role: user.role,
      disabled: user.disabled,
      permissions: user.permissions,
    });
    return { user: publicUser(user) };
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/password', adminSensitive, async (request) => {
    const body = parseBody(z.object({ password: z.string().min(1).max(256) }), request.body);
    const target = users.get(request.params.id);
    if (!target) throw notFound('Benutzer nicht gefunden.');
    await users.setPassword(target.id, body.password);
    const self = target.id === auth(request).user.id;
    sessions.revokeAllForUser(target.id, self ? auth(request).session.id : null);
    audit.record('user.password_reset', actor(request), { username: target.username });
    return { ok: true };
  });

  /** For a lost phone: removes the second factor so the user can enrol again at the next sign-in. */
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-totp', adminSensitive, async (request) => {
    const target = users.get(request.params.id);
    if (!target) throw notFound('Benutzer nicht gefunden.');
    users.disableTotp(target.id);
    if (target.id !== auth(request).user.id) sessions.revokeAllForUser(target.id);
    audit.record('user.totp_reset', actor(request), { username: target.username });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/revoke-sessions', admin, async (request) => {
    const target = users.get(request.params.id);
    if (!target) throw notFound('Benutzer nicht gefunden.');
    const self = target.id === auth(request).user.id;
    const count = sessions.revokeAllForUser(target.id, self ? auth(request).session.id : null);
    audit.record('user.sessions_revoked', actor(request), { username: target.username, count });
    return { ok: true, count };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', admin, async (request) => {
    const target = users.get(request.params.id);
    if (!target) throw notFound('Benutzer nicht gefunden.');
    if (target.id === auth(request).user.id) {
      throw new HttpError(409, 'self_delete', 'Du kannst dein eigenes Konto nicht löschen.');
    }
    sessions.revokeAllForUser(target.id);
    users.delete(target.id);
    audit.record('user.deleted', actor(request), { username: target.username });
    return { ok: true };
  });
}
