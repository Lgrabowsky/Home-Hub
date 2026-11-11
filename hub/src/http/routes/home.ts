import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EntityCommand, HubState, MediaConfig } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { filterState } from '../../realtime.ts';
import { actor, auth, parseBody } from '../server.ts';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const percent = z.number().min(0).max(100);

const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('turn_on') }),
  z.object({ action: z.literal('turn_off') }),
  z.object({ action: z.literal('toggle') }),
  z.object({ action: z.literal('set_brightness'), value: percent }),
  z.object({ action: z.literal('set_color'), value: color }),
  z.object({ action: z.literal('set_color_temp'), value: z.number().min(0).max(100) }),
  z.object({ action: z.literal('up') }),
  z.object({ action: z.literal('down') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('set_position'), value: percent }),
  z.object({ action: z.literal('set_tilt'), value: percent }),
  z.object({ action: z.literal('set_target'), value: z.number().min(4).max(35) }),
  z.object({ action: z.literal('set_mode'), value: z.enum(['off', 'comfort', 'reduced', 'manual', 'standby', 'unknown']) }),
  z.object({ action: z.literal('run') }),
  z.object({ action: z.literal('enable') }),
  z.object({ action: z.literal('disable') }),
]);

export function registerHomeRoutes(app: FastifyInstance, ctx: HubContext): void {
  /** Full state, filtered to what the user may see. The apps normally get it over the WebSocket. */
  app.get('/api/state', async (request): Promise<HubState> => filterState(ctx.state.snapshot(), auth(request).user));

  app.post<{ Params: { id: string } }>(
    '/api/entities/:id/command',
    { config: { permission: 'home.control' } },
    async (request) => {
      const command = parseBody(commandSchema, request.body) as EntityCommand;
      const entity = ctx.integrations.entity(request.params.id);
      await ctx.integrations.entityCommand(entity.id, command);
      ctx.log.info({ user: actor(request).username, entity: entity.id, action: command.action }, 'entity command');
      return { ok: true };
    },
  );

  app.get('/api/media/config', async (): Promise<MediaConfig> => ctx.integrations.media.clientConfig());
}
