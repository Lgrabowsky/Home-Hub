import type { FastifyInstance } from 'fastify';
import { hasPermission, viewPermissionFor, type House3DState } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { MAX_IFC_BYTES } from '../../house3d/store.ts';
import { badRequest, notFound } from '../errors.ts';
import { actor, auth } from '../server.ts';

/** The 3D model of the house (Labs): what everybody sees, and what the administrator sets up. */
export function registerHouse3DRoutes(app: FastifyInstance, ctx: HubContext): void {
  const store = ctx.house3d;

  /** Model description, view settings and device positions — only devices the user may see. */
  app.get('/api/house3d', async (request): Promise<House3DState> => {
    const { user } = auth(request);
    const state = store.state();
    const markers = state.markers.filter((marker) => {
      const entity = ctx.state.get(marker.entityId);
      if (!entity) return false;
      const needed = viewPermissionFor(entity.kind);
      return needed === null || hasPermission(user, needed);
    });
    return { ...state, markers };
  });

  /** The converted model. The version in the query only makes every upload a new address. */
  app.get('/api/house3d/model', async (_request, reply) => {
    const binary = store.model();
    if (!binary) throw notFound('Es wurde noch kein 3D-Modell hochgeladen.');
    return reply.header('Content-Type', 'application/octet-stream').send(binary);
  });

  // Uploads arrive as the raw file; only this route accepts such a body, and only this large.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_IFC_BYTES }, (_request, body, done) => done(null, body));
    scope.post(
      '/api/house3d/model',
      { config: { access: 'admin' }, bodyLimit: MAX_IFC_BYTES },
      async (request): Promise<House3DState> => {
        const body = request.body;
        if (!Buffer.isBuffer(body)) throw badRequest('Bitte die IFC-Datei als Datei senden.');
        const header = request.headers['x-file-name'];
        let fileName = 'Modell.ifc';
        try {
          if (typeof header === 'string') fileName = decodeURIComponent(header);
        } catch {
          /* keep the default */
        }
        const model = store.import(body, fileName);
        ctx.audit.record('house3d.uploaded', actor(request), { file: model.fileName, elements: model.elements });
        return store.state();
      },
    );
  });

  app.delete('/api/house3d/model', { config: { access: 'admin' } }, async (request): Promise<House3DState> => {
    store.remove();
    ctx.audit.record('house3d.removed', actor(request));
    return store.state();
  });

  app.put('/api/house3d/view', { config: { access: 'admin' } }, async (request): Promise<House3DState> => {
    store.setView(request.body);
    ctx.audit.record('settings.changed', actor(request), { area: 'house3d' });
    return store.state();
  });

  app.put<{ Params: { entityId: string } }>('/api/house3d/markers/:entityId', { config: { access: 'admin' } }, async (request): Promise<House3DState> => {
    const entity = ctx.integrations.entity(request.params.entityId);
    store.setMarker(entity.id, request.body);
    return store.state();
  });

  app.delete<{ Params: { entityId: string } }>('/api/house3d/markers/:entityId', { config: { access: 'admin' } }, async (request): Promise<House3DState> => {
    store.removeMarker(request.params.entityId);
    return store.state();
  });
}
