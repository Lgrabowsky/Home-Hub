import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DoorHistoryPage } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import type { Actor } from '../../integrations/types.ts';
import { notFound } from '../errors.ts';
import { sniffImageType } from '../../util/images.ts';
import { auth, parseBody } from '../server.ts';

const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  type: z.enum(['doorbell', 'motion', 'open']).optional(),
});

export function actorOf(request: FastifyRequest): Actor {
  const { user } = auth(request);
  return { userId: user.id, username: user.username, displayName: user.displayName, ip: request.ip };
}

export function registerDoorRoutes(app: FastifyInstance, ctx: HubContext): void {
  const view = { config: { permission: 'doors.view' as const } };

  app.get<{ Params: { id: string } }>('/api/doors/:id/snapshot', view, async (request, reply) => {
    const image = await ctx.integrations.need('doorbird').snapshot(request.params.id);
    return reply.type(sniffImageType(image)).send(image);
  });

  app.post<{ Params: { id: string } }>(
    '/api/doors/:id/open',
    { config: { permission: 'doors.open', sensitive: true } },
    async (request) => {
      const body = parseBody(z.object({ relay: z.string().min(1).max(40) }), request.body);
      // The integration writes the audit entry and the history record itself.
      await ctx.integrations.need('doorbird').openDoor(request.params.id, body.relay, actorOf(request));
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/doors/:id/light', view, async (request) => {
    await ctx.integrations.need('doorbird').light(request.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/doors/:id/history', view, async (request): Promise<DoorHistoryPage> => {
    const query = parseBody(historyQuery, request.query);
    return ctx.integrations.need('doorbird').history(request.params.id, {
      before: query.before ?? null,
      limit: query.limit ?? 40,
      type: query.type ?? null,
    });
  });

  app.get<{ Params: { eventId: string } }>('/api/doors/events/:eventId/image', view, async (request, reply) => {
    const image = ctx.integrations.need('doorbird').historyImage(request.params.eventId);
    if (!image) throw notFound('Zu diesem Ereignis gibt es kein Bild (mehr).');
    // History images never change: let the app keep them (privately) for a while.
    return reply.header('Cache-Control', 'private, max-age=86400, immutable').type(sniffImageType(image)).send(image);
  });
}
