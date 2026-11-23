import type { FastifyInstance } from 'fastify';
import type { KnxInterfaceInfo, KnxTelegramsResponse } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { searchInterfaces } from '../../integrations/knx/link.ts';

/**
 * KNX helpers for administrators: the telegrams the hub heard (to find out
 * which group address belongs to which window) and the search for KNX IP
 * interfaces. Bus traffic tells when people are at home: administrators only.
 */
export function registerKnxRoutes(app: FastifyInstance, ctx: HubContext): void {
  const admin = { config: { access: 'admin' as const } };

  app.get<{ Querystring: { since?: string } }>('/api/admin/knx/telegrams', admin, async (request): Promise<KnxTelegramsResponse> => {
    const knx = ctx.integrations.need('knx');
    const since = Number(request.query.since ?? 0);
    return knx.recentTelegrams(Number.isFinite(since) ? since : 0);
  });

  app.post('/api/admin/knx/search', admin, async (): Promise<{ interfaces: KnxInterfaceInfo[] }> => ({
    interfaces: await searchInterfaces(3000, ctx.knxSearchTarget ?? undefined),
  }));
}
