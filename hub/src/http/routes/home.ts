import type { FastifyInstance } from 'fastify';
import { hasPermission, type EntityCommand, type HubState, type MediaConfig } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { canSee, filterState } from '../../realtime.ts';
import { forbidden, notFound } from '../errors.ts';
import { actor, auth, parseBody } from '../server.ts';
import { commandSchema } from '../commands.ts';

/** What a command on a door or gate did, for the audit log. */
const ACCESS_WORDS: Partial<Record<EntityCommand['action'], string>> = {
  open: 'geöffnet',
  hold_open: 'dauerhaft geöffnet',
  close: 'geschlossen',
  lock: 'gesperrt',
  stop: 'angehalten',
};

export function registerHomeRoutes(app: FastifyInstance, ctx: HubContext): void {
  /** Full state, filtered to what the user may see. The apps normally get it over the WebSocket. */
  app.get('/api/state', async (request): Promise<HubState> => filterState(ctx.state.snapshot(), auth(request).user));

  app.post<{ Params: { id: string } }>(
    '/api/entities/:id/command',
    { config: { permission: 'home.control' } },
    async (request) => {
      const command = parseBody(commandSchema, request.body) as EntityCommand;
      const entity = ctx.integrations.entity(request.params.id);
      const { user } = auth(request);
      if (!canSee(user, entity)) throw notFound('Dieses Gerät gibt es nicht (mehr).');
      // Doors and gates: only for whoever may open doors, and every use is on record.
      if (entity.kind === 'access') {
        if (!hasPermission(user, 'doors.open')) throw forbidden('Du darfst keine Türen öffnen.');
        try {
          await ctx.integrations.entityCommand(entity.id, command);
        } catch (err) {
          if (command.action === 'open' || command.action === 'hold_open') ctx.audit.record('door.open_failed', actor(request), { door: entity.name });
          throw err;
        }
        ctx.audit.record('access.command', actor(request), { door: entity.name, action: command.action, text: ACCESS_WORDS[command.action] ?? command.action });
        ctx.log.info({ user: actor(request).username, entity: entity.id, action: command.action }, 'access command');
        return { ok: true };
      }
      await ctx.integrations.entityCommand(entity.id, command);
      ctx.log.info({ user: actor(request).username, entity: entity.id, action: command.action }, 'entity command');
      return { ok: true };
    },
  );

  app.get('/api/media/config', async (): Promise<MediaConfig> => ctx.integrations.media.clientConfig());
}
