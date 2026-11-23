import type { FastifyInstance } from 'fastify';
import { hasPermission, type HubTimer, type TimersResponse } from '@home-hub/shared';
import type { AuthContext } from '../../auth/sessions.ts';
import type { HubContext } from '../../context.ts';
import { localDate, sunOn } from '../../automation/timers.ts';
import { forbidden } from '../errors.ts';
import { actor, auth } from '../server.ts';

/** Everybody signed in except guests may set up time switches (they switch lights, blinds …, never doors). */
function canEdit(user: AuthContext['user']): boolean {
  return user.role !== 'guest' && hasPermission(user, 'home.control');
}

/** The hub's own time switches. */
export function registerTimerRoutes(app: FastifyInstance, ctx: HubContext): void {
  const timers = ctx.timers;
  const guard = (request: Parameters<typeof auth>[0]) => {
    const { user } = auth(request);
    if (!canEdit(user)) throw forbidden('Zeitschaltuhren ändern dürfen nur Mitglieder des Haushalts.');
  };

  app.get('/api/timers', async (request): Promise<TimersResponse> => {
    const { user } = auth(request);
    const place = timers.place();
    const sun = sunOn(localDate(Date.now(), place.timeZone), place);
    return { timers: timers.list(), timeZone: place.timeZone, located: place.located, sunrise: sun.rise, sunset: sun.set, canEdit: canEdit(user) };
  });

  app.post('/api/timers', async (request): Promise<{ timer: HubTimer }> => {
    guard(request);
    const timer = timers.create(request.body, actor(request).username);
    ctx.audit.record('timer.changed', actor(request), { name: timer.name, change: 'created' });
    return { timer };
  });

  app.put<{ Params: { id: string } }>('/api/timers/:id', async (request): Promise<{ timer: HubTimer }> => {
    guard(request);
    const timer = timers.update(request.params.id, request.body, actor(request).username);
    ctx.audit.record('timer.changed', actor(request), { name: timer.name, change: 'updated' });
    return { timer };
  });

  app.delete<{ Params: { id: string } }>('/api/timers/:id', async (request): Promise<{ ok: true }> => {
    guard(request);
    const removed = timers.remove(request.params.id);
    ctx.audit.record('timer.changed', actor(request), { name: removed.name, change: 'deleted' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/timers/:id/run', { config: { permission: 'home.control' } }, async (request): Promise<{ timer: HubTimer }> => {
    guard(request);
    return { timer: await timers.runNow(request.params.id) };
  });
}
