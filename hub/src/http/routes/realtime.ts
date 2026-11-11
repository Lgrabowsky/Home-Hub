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
const MAX_CLIENT_MESSAGES = 300;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const MAX_OFFER_BYTES = 32 * 1024;
const MAX_CANDIDATE_BYTES = 512;
const MAX_CANDIDATES = 100;
const MAX_MSE_BYTES = 300;
/** How often an open stream re-checks that its viewer may still see it. */
const GUARD_INTERVAL_MS = 5000;
const ALLOWED_CLIENT_TYPES = new Set(['webrtc/offer', 'webrtc/candidate', 'mse']);

/**
 * Checks what a client wants to hand to go2rtc. go2rtc trusts its API (it is
 * meant for the owner only); here it hears from every viewer, so anything it
 * could choke on is refused first. Example: an `a=rtpmap:` line without a
 * clock rate makes go2rtc 1.9.15 panic (pkg/core/codec.go) — the whole video
 * service would go down for everybody.
 */
export function clientMessageProblem(type: string, value: string, state: { candidates: number }): string | null {
  switch (type) {
    case 'webrtc/offer': {
      if (value.length > MAX_OFFER_BYTES) return 'offer too large';
      if (!/^v=0\r?\n/.test(value)) return 'not an SDP offer';
      for (const line of value.split(/\r?\n/)) {
        if (line.startsWith('a=rtpmap:') && !/^a=rtpmap:\d{1,3} [A-Za-z0-9._-]{1,32}\/\d{1,6}(\/\d{1,2})?\s*$/.test(line)) return 'malformed rtpmap';
      }
      return null;
    }
    case 'webrtc/candidate':
      if (++state.candidates > MAX_CANDIDATES) return 'too many candidates';
      if (value.length > MAX_CANDIDATE_BYTES) return 'candidate too large';
      if (value !== '' && !/^candidate:[\x20-\x7e]+$/.test(value)) return 'not a candidate';
      return null;
    case 'mse':
      return value.length > MAX_MSE_BYTES ? 'codec list too large' : null;
    default:
      return 'unknown type';
  }
}

/**
 * go2rtc's error texts can contain the source URL of a stream — with the
 * camera's user name and password when they are part of its query string.
 * Viewers only get the prefix the app needs ("mse", "webrtc/offer" …) and a
 * neutral sentence.
 */
export function sanitizeUpstreamText(text: string): { text: string; type: string | null; error: string | null } {
  let message: { type?: unknown; value?: unknown };
  try {
    message = JSON.parse(text) as { type?: unknown; value?: unknown };
  } catch {
    return { text, type: null, error: null };
  }
  const type = typeof message.type === 'string' ? message.type : null;
  if (type !== 'error') return { text, type, error: null };
  const original = typeof message.value === 'string' ? message.value : '';
  const prefix = /^([a-z]+(?:\/[a-z]+)?):/.exec(original)?.[1];
  const value = `${prefix ? `${prefix}: ` : ''}Der Stream ist gerade nicht verfügbar.`;
  return { text: JSON.stringify({ type: 'error', value }), type, error: original };
}

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
    // The talk stream of a camera carries its picture as well: talking needs "view" too.
    const needed: Permission[] = kind === 'door' ? ['doors.view'] : quality === 'talk' ? ['cameras.view', 'cameras.control'] : ['cameras.view'];
    const allowed = (user: UserRecord | null | undefined) => Boolean(user && !user.disabled && needed.every((permission) => hasPermission(user, permission)));
    if (!allowed(who.user)) return sendError('Dafür fehlt dir die Berechtigung.', CLOSE_FORBIDDEN);

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
    const traffic = { offerSeen: false, candidates: 0 };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(guard);
      unregister();
      const count = (mediaSockets.get(who.sessionId) ?? 1) - 1;
      if (count <= 0) mediaSockets.delete(who.sessionId);
      else mediaSockets.set(who.sessionId, count);
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.terminate();
      if (socket.readyState === socket.OPEN) socket.close(1000);
    };

    // The stream ends as soon as the session behind it does, or the viewer loses the permission.
    const stillAllowed = () => ctx.sessions.isAlive(who.sessionId) && allowed(ctx.users.get(who.user.id));
    const check = () => {
      if (!stillAllowed()) cleanup();
      else if (socket.readyState === socket.OPEN) socket.ping();
    };
    const guard = setInterval(check, GUARD_INTERVAL_MS);
    guard.unref();
    // … and at once when an administrator changes the user.
    const unregister = media.registerRelay(() => {
      if (!stillAllowed()) cleanup();
    });

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
      const value = String(message.value ?? '');
      // Candidates are only meaningful after an offer (go2rtc would keep early ones in memory).
      if (message.type === 'webrtc/candidate' && !traffic.offerSeen) return;
      const problem = clientMessageProblem(message.type, value, traffic);
      if (problem) {
        ctx.log.info({ user: who.user.username, stream: name, problem }, 'refused a media message');
        return sendError('Diese Anfrage wurde abgelehnt.', CLOSE_FORBIDDEN);
      }
      if (message.type === 'webrtc/offer') {
        if (quality !== 'talk' && offerSendsMedia(value)) {
          // Viewing streams are strictly one-way; talking needs the dedicated talk stream.
          return sendError('Senden ist auf diesem Stream nicht erlaubt.', CLOSE_FORBIDDEN);
        }
        traffic.offerSeen = true;
      }
      const payload = JSON.stringify({ type: message.type, value });
      if (upstream.readyState === upstream.OPEN) upstream.send(payload);
      else pending.push(payload);
    });

    upstream.on('open', () => {
      for (const payload of pending.splice(0)) upstream.send(payload);
    });
    upstream.on('message', (data, isBinary) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > 32 * 1024 * 1024) return cleanup(); // the viewer cannot keep up
      if (isBinary) return socket.send(data, { binary: true });
      const { text, type, error } = sanitizeUpstreamText(data.toString());
      if (error) ctx.log.debug({ stream: name, error }, 'media upstream reported an error');
      // Only a session go2rtc really answered has media flowing outside this socket (see MediaManager.endSession).
      if (type === 'webrtc/answer') media.noteRtcSession(who.sessionId);
      socket.send(text);
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
