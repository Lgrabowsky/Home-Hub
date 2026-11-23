import type { FastifyInstance } from 'fastify';
import type { HouseLayout } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { actor } from '../server.ts';

/** The household's arrangement of the house: everybody reads it with the state, administrators change it. */
export function registerLayoutRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get('/api/layout', async (): Promise<{ layout: HouseLayout }> => ({ layout: ctx.layout.get() }));

  app.put<{ Body: { layout?: unknown; change?: unknown } }>('/api/layout', { config: { access: 'admin' } }, async (request): Promise<{ layout: HouseLayout }> => {
    const layout = ctx.layout.set(request.body?.layout);
    const change = typeof request.body?.change === 'string' ? request.body.change.slice(0, 120) : null;
    ctx.audit.record('layout.changed', actor(request), change ? { change } : {});
    return { layout };
  });
}
