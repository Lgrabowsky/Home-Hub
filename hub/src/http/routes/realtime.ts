import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { hasPermission, type Permission } from '@home-hub/shared';
import type { UserRecord } from '../../auth/users.ts';
import type { HubContext } from '../../context.ts';
import { streamName, type StreamQualityName } from '../../integrations/media.ts';
import { expectedOrigins, isAllowedAppOrigin } from '../server.ts';

/**
 * WebSocket endpoints.
 *
 * Both are opened with a one-time ticket (see auth/tickets.ts) and only from
 * our own pages or the packaged apps:
 *   /api/ws        live state
 *   /api/media/ws  signalling + fallback transport for one video/talk stream,
 *                  relayed to the private go2rtc instance
 */

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_UNAVAILABLE = 4503;

const MAX_MEDIA_SOCKETS_PER_SESSION = 24;
const MAX_CLIENT_MESSAGES = 2000;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const ALLOWED_CLIENT_TYPES = new Set(['webrtc/offer', 'webrtc/candidate', 'mse']);

function originAllowed(ctx: HubContext, request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // not a browser; the ticket is still required
  return expectedOrigins(ctx, request).includes(origin) || isAllowedAppOrigin(ctx, origin);
}

function redeem(ctx: HubContext, request: FastifyRequest, scope: 'realtime' | 'media'): { user: UserRecord; sessionId: string } | null {
  const ticket = (request.query as Record<string, unknown>).ticket;
  if (typeof ticket !== 'string') return null;
  const sessionId = ctx.tickets.redeem(ticket, scope);
  if (!sessionId) return null;
  const session = ctx.sessions.get(sessionId);
  if (!session || session.kind !== 'full' || session.expiresAt <= Date.now()) return null;
  const user = ctx.users.get(session.userId);
  if (!user || user.disabled) return null;
  return { user, sessionId };
}

/** True when an SDP offer contains an audio/video section that would send media to the hub. */
export function offerSendsMedia(sdp: string): boolean {
  const sections = sdp.split(/\r?\n(?=m=)/).slice(1);
  return sections.some((section) => {
    if (!/^m=(audio|video) /.test(section)) return false;
    return !/^a=(recvonly|inactive)\s*$/m.test(section);
  });
}

export function registerRealtimeRoutes(app: FastifyInstance, ctx: HubContext): void {
  const mediaSockets = new Map<string, number>();

  app.get('/api/ws', { websocket: true, config: { access: 'public' } }, (socket: WebSocket, request) => {
    if (!originAllowed(ctx, request)) return socket.close(CLOSE_FORBIDDEN, 'origin');
    const who = redeem(ctx, request, 'realtime');
    if (!who) return socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
    ctx.realtime.attach(socket, who.user, who.sessionId);
  });

  app.get('/api/media/ws', { websocket: true, config: { access: 'public' } }, (socket: WebSocket, request) => {
    const sendError = (message: string, code: number) => {
      try {
        socket.send(JSON.stringify({ type: 'error', value: message }));
      } catch {
        /* closing anyway */
      }
      socket.close(code, 'error');
    };

    if (!originAllowed(ctx, request)) return socket.close(CLOSE_FORBIDDEN, 'origin');
    const who = redeem(ctx, request, 'media');
    if (!who) return socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');

    // --- Which stream, and may this user have it?
    const query = request.query as Record<string, unknown>;
    const match = typeof query.entity === 'string' ? /^(cam|door):([a-z0-9][a-z0-9-]{0,31})$/.exec(query.entity) : null;
    const quality = query.q === 'sub' || query.q === 'talk' ? query.q : 'main';
    if (!match) return sendError('Unbekannter Stream.', CLOSE_FORBIDDEN);
    const kind = match[1] as 'cam' | 'door';
    const needed: Permission = kind === 'door' ? 'doors.view' : quality === 'talk' ? 'cameras.control' : 'cameras.view';
    if (!hasPermission(who.user, needed)) return sendError('Dafür fehlt dir die Berechtigung.', CLOSE_FORBIDDEN);

    const media = ctx.integrations.media;
    // Door stations have a single video stream: "sub" falls back to it.
    const effective: StreamQualityName = kind === 'door' && quality === 'sub' ? 'main' : quality;
    const name = streamName(kind, match[2]!, effective);
    if (!media.hasStream(name)) return sendError('Diesen Stream gibt es nicht.', CLOSE_FORBIDDEN);
    if (!media.available) return sendError('Der Video-Dienst ist gerade nicht verfügbar.', CLOSE_UNAVAILABLE);

    const open = mediaSockets.get(who.sessionId) ?? 0;
    if (open >= MAX_MEDIA_SOCKETS_PER_SESSION) return sendError('Zu viele gleichzeitige Streams.', CLOSE_UNAVAILABLE);
    mediaSockets.set(who.sessionId, open + 1);

    // --- Relay
    const upstream = media.openSocket(name);
    const pending: string[] = [];
    let received = 0;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(guard);
      const count = (mediaSockets.get(who.sessionId) ?? 1) - 1;
      if (count <= 0) mediaSockets.delete(who.sessionId);
      else mediaSockets.set(who.sessionId, count);
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.terminate();
      if (socket.readyState === socket.OPEN) socket.close(1000);
    };

    // The stream ends as soon as the session behind it does.
    const guard = setInterval(() => {
      if (!ctx.sessions.isAlive(who.sessionId)) cleanup();
      else if (socket.readyState === socket.OPEN) socket.ping();
    }, 20_000);
    guard.unref();

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.length > MAX_CLIENT_MESSAGE_BYTES || ++received > MAX_CLIENT_MESSAGES) return cleanup();
      let message: { type?: unknown; value?: unknown };
      try {
        message = JSON.parse(text) as { type?: unknown; value?: unknown };
      } catch {
        return;
      }
      if (typeof message.type !== 'string' || !ALLOWED_CLIENT_TYPES.has(message.type)) return;
      if (message.value !== undefined && typeof message.value !== 'string') return;
      if (message.type === 'webrtc/offer' && quality !== 'talk' && offerSendsMedia(String(message.value ?? ''))) {
        // Viewing streams are strictly one-way; talking needs the dedicated talk stream.
        return sendError('Senden ist auf diesem Stream nicht erlaubt.', CLOSE_FORBIDDEN);
      }
      const payload = JSON.stringify({ type: message.type, value: message.value ?? '' });
      if (upstream.readyState === upstream.OPEN) upstream.send(payload);
      else pending.push(payload);
    });

    upstream.on('open', () => {
      for (const payload of pending.splice(0)) upstream.send(payload);
    });
    upstream.on('message', (data, isBinary) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > 32 * 1024 * 1024) return cleanup(); // the viewer cannot keep up
      socket.send(data, { binary: isBinary });
    });
    upstream.on('error', (err) => {
      ctx.log.debug({ err, stream: name }, 'media upstream error');
      if (!closed) sendError('Der Video-Dienst ist gerade nicht verfügbar.', CLOSE_UNAVAILABLE);
      cleanup();
    });
    upstream.on('close', cleanup);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
