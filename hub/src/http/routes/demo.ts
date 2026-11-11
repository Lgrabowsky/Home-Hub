import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DemoState } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { notFound } from '../errors.ts';
import { parseBody } from '../server.ts';

const trigger = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ring'), door: z.string().max(40) }),
  z.object({ action: z.literal('motion'), door: z.string().max(40) }),
  z.object({ action: z.literal('contact'), name: z.string().max(80), open: z.boolean() }),
]);

/**
 * Demo mode only: lets a signed-in tester make the simulated house do
 * something (ring the bell, open a window). The routes do not exist otherwise.
 */
export function registerDemoRoutes(app: FastifyInstance, ctx: HubContext): void {
  if (!ctx.config.demo) return;
  const control = () => {
    if (!ctx.demo) throw notFound('Die Demo läuft noch nicht.');
    return ctx.demo;
  };

  app.get('/api/demo/state', async (): Promise<DemoState> => control().state());

  app.post('/api/demo/trigger', async (request) => {
    await control().trigger(parseBody(trigger, request.body));
    return { ok: true };
  });
}
