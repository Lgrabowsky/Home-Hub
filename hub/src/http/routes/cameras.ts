import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PTZ_OPS, type PtzPreset } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { sniffImageType } from '../../util/images.ts';
import { parseBody } from '../server.ts';

export function registerCameraRoutes(app: FastifyInstance, ctx: HubContext): void {
  const view = { config: { permission: 'cameras.view' as const } };
  const control = { config: { permission: 'cameras.control' as const } };
  type Id = { Params: { id: string } };

  app.get<Id>('/api/cameras/:id/snapshot', view, async (request, reply) => {
    const image = await ctx.integrations.need('reolink').snapshot(request.params.id);
    return reply.type(sniffImageType(image)).send(image);
  });

  app.post<Id>('/api/cameras/:id/ptz', control, async (request) => {
    const body = parseBody(z.object({ op: z.enum(PTZ_OPS), speed: z.number().min(1).max(64).optional() }), request.body);
    await ctx.integrations.need('reolink').ptz(request.params.id, body.op, body.speed);
    return { ok: true };
  });

  app.get<Id>('/api/cameras/:id/presets', view, async (request): Promise<{ presets: PtzPreset[] }> => ({
    presets: await ctx.integrations.need('reolink').presets(request.params.id),
  }));

  app.post<Id>('/api/cameras/:id/preset', control, async (request) => {
    const body = parseBody(z.object({ id: z.number().int().min(0).max(255) }), request.body);
    await ctx.integrations.need('reolink').gotoPreset(request.params.id, body.id);
    return { ok: true };
  });

  app.post<Id>('/api/cameras/:id/light', control, async (request) => {
    const body = parseBody(z.object({ on: z.boolean() }), request.body);
    await ctx.integrations.need('reolink').setLight(request.params.id, body.on);
    return { ok: true };
  });

  app.post<Id>('/api/cameras/:id/siren', control, async (request) => {
    await ctx.integrations.need('reolink').siren(request.params.id);
    return { ok: true };
  });

  // Continuous PTZ over the realtime socket (lower latency than one HTTP request per tick).
  ctx.realtime.on('ptz', (user, cameraId, op, speed) => {
    const reolink = ctx.integrations.reolink;
    if (!reolink) return;
    reolink.ptz(cameraId, op, speed).catch((err: unknown) => {
      ctx.log.debug({ err, cameraId, user: user.username }, 'ptz command failed');
    });
  });
}
