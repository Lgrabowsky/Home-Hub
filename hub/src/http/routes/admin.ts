import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditEntry, ContactCandidate, DiagnosticsReport, IntegrationSettingsMap, SettingsKey, TestResult } from '@home-hub/shared';
import type { HubContext } from '../../context.ts';
import { isSettingsKey } from '../../settings.ts';
import { notFound } from '../errors.ts';
import { actor, parseBody } from '../server.ts';

/** Hub administration: integration settings, connection tests, audit log, diagnostics. */
export function registerAdminRoutes(app: FastifyInstance, ctx: HubContext): void {
  const admin = { config: { access: 'admin' as const } };
  const { settings, integrations, audit } = ctx;

  function key(raw: string): SettingsKey {
    if (!isSettingsKey(raw)) throw notFound('Unbekannter Einstellungsbereich.');
    return raw;
  }

  app.get('/api/admin/settings', admin, async () => {
    const out: Partial<{ [K in SettingsKey]: IntegrationSettingsMap[K] }> = {};
    for (const k of ['general', 'mygekko', 'doorbird', 'reolink', 'sonos', 'spotify'] as const) {
      (out as Record<string, unknown>)[k] = settings.getMasked(k);
    }
    return { settings: out, demo: ctx.config.demo };
  });

  app.get<{ Params: { key: string } }>('/api/admin/settings/:key', admin, async (request) => {
    const k = key(request.params.key);
    return { value: settings.getMasked(k), locked: settings.isOverridden(k) };
  });

  app.put<{ Params: { key: string } }>('/api/admin/settings/:key', admin, async (request) => {
    const k = key(request.params.key);
    settings.set(k, request.body);
    audit.record('settings.changed', actor(request), { area: k });
    return { value: settings.getMasked(k) };
  });

  /** Tries the settings exactly as entered in the form — nothing is saved. */
  app.post<{ Params: { key: string } }>('/api/admin/settings/:key/test', { config: { access: 'admin', sensitive: true } }, async (request): Promise<TestResult> => {
    const k = key(request.params.key);
    const value = settings.prepare(k, request.body);
    return integrations.test(k, value);
  });

  app.get('/api/admin/audit', admin, async (request): Promise<{ entries: AuditEntry[] }> => {
    const query = parseBody(
      z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
      request.query,
    );
    return { entries: audit.list({ before: query.before ?? null, limit: query.limit ?? 100 }) };
  });

  /** Elements of the myGEKKO that could be window/door contacts, with their live raw values. */
  app.get('/api/admin/mygekko/contact-candidates', admin, async (): Promise<{ candidates: ContactCandidate[] }> => ({
    candidates: integrations.need('mygekko').contactCandidates(),
  }));

  app.get('/api/admin/diagnostics', admin, async (): Promise<DiagnosticsReport> => {
    const entities = ctx.state.all();
    const counts: Record<string, number> = {};
    for (const entity of entities) counts[entity.kind] = (counts[entity.kind] ?? 0) + 1;
    const music = ctx.state.getMusic();
    counts.speaker = music.players.length;
    counts.app = ctx.realtime.clientCount;
    const media = integrations.media.diagnostics();
    return {
      version: ctx.config.version,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      node: process.version,
      services: ctx.state.allServices(),
      media: { running: media.running, version: media.version, streams: media.streams, candidates: media.candidates },
      counts,
      raw: { ...integrations.diagnostics(), media },
    };
  });
}
