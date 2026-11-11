import type { ClientMessage, PtzOp, ServerMessage } from '@home-hub/shared';
import { emitHubEvent, useHub } from '../store/hub.ts';
import { ApiError, post, wsBaseUrl } from './api.ts';
import { onResume } from './platform.ts';

/**
 * Keeps one WebSocket to the hub alive for as long as the user is signed in.
 *
 * "The app must always work when it is opened": the connection re-establishes
 * itself after network changes, sleep or a hub restart, and every new
 * connection starts with a complete snapshot, so the screen can never show
 * stale state for long. A watchdog catches half-open connections that the
 * operating system has not noticed yet.
 */

const PING_EVERY_MS = 20_000;
const SILENCE_LIMIT_MS = 45_000;
const OFFLINE_AFTER_MS = 6_000;
const BACKOFF_MS = [300, 800, 1500, 3000, 5000, 8000];

let socket: WebSocket | null = null;
let running = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;
let lastMessageAt = 0;
let stopResume: (() => void) | null = null;
let connecting = false;
let onSessionEnded: (() => void) | null = null;

function clearTimers(): void {
  if (retryTimer) clearTimeout(retryTimer);
  if (pingTimer) clearInterval(pingTimer);
  retryTimer = null;
  pingTimer = null;
}

function markDisconnected(): void {
  const { link, setLink } = useHub.getState();
  if (link === 'online') setLink('connecting');
  // Do not flash "offline" for a short reconnect; only say so when it lasts.
  offlineTimer ??= setTimeout(() => {
    offlineTimer = null;
    if (running && socket?.readyState !== WebSocket.OPEN) useHub.getState().setLink('offline');
  }, OFFLINE_AFTER_MS);
}

function markConnected(): void {
  if (offlineTimer) clearTimeout(offlineTimer);
  offlineTimer = null;
  attempt = 0;
  useHub.getState().setLink('online');
}

function scheduleReconnect(immediate = false): void {
  if (!running || retryTimer || connecting) return;
  const delay = immediate ? 0 : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]! * (0.8 + Math.random() * 0.4);
  attempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
}

function handle(message: ServerMessage): void {
  const hub = useHub.getState();
  switch (message.type) {
    case 'snapshot':
      hub.applySnapshot(message.state);
      markConnected();
      break;
    case 'entities':
      hub.applyEntities(message.changed, message.removed);
      break;
    case 'music':
      hub.setMusic(message.music);
      break;
    case 'services':
      hub.setServices(message.services);
      break;
    case 'event':
      if (message.event.type === 'doorbell') {
        hub.setRing({ doorId: message.event.doorId, doorName: message.event.doorName, ts: message.event.ts });
      }
      emitHubEvent(message.event);
      break;
    case 'session_ended':
      stopRealtime();
      onSessionEnded?.();
      break;
    case 'hello':
    case 'pong':
      break;
  }
}

async function connect(): Promise<void> {
  if (!running || connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    const { ticket } = await post<{ ticket: string }>('/api/auth/ticket', { scope: 'realtime' }, { timeoutMs: 8000 });
    if (!running) return;
    const ws = new WebSocket(`${wsBaseUrl()}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    socket = ws;
    lastMessageAt = Date.now();

    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== 'string') return;
      lastMessageAt = Date.now();
      try {
        handle(JSON.parse(event.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (!running) return;
      markDisconnected();
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    ws.onopen = () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (socket !== ws) return;
        if (Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
          // Half-open connection (e.g. after switching networks): start over.
          ws.close();
          return;
        }
        sendMessage({ type: 'ping', t: Date.now() });
      }, PING_EVERY_MS);
    };
  } catch (err) {
    // A 401 already signalled "signed out" through the API layer; anything else: try again.
    if (!(err instanceof ApiError && err.status === 401)) {
      markDisconnected();
      connecting = false;
      scheduleReconnect();
      return;
    }
  } finally {
    connecting = false;
  }
}

export function startRealtime(options: { onSessionEnded: () => void }): void {
  if (running) return;
  running = true;
  attempt = 0;
  onSessionEnded = options.onSessionEnded;
  useHub.getState().setLink('connecting');
  void connect();
  stopResume = onResume(() => {
    if (!running) return;
    const stale = Date.now() - lastMessageAt > PING_EVERY_MS + 5000;
    if (!socket || socket.readyState > WebSocket.OPEN || stale) {
      socket?.close();
      socket = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
      scheduleReconnect(true);
    }
  });
}

export function stopRealtime(): void {
  running = false;
  clearTimers();
  if (offlineTimer) clearTimeout(offlineTimer);
  offlineTimer = null;
  stopResume?.();
  stopResume = null;
  const ws = socket;
  socket = null;
  ws?.close();
}

function sendMessage(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * Continuous camera movement. Call repeatedly (every ~400 ms) while the button
 * is held — the hub stops the camera by itself when the calls stop coming.
 * Returns false when the realtime link is down (the caller falls back to HTTP).
 */
export function sendPtz(cameraId: string, op: PtzOp, speed?: number): boolean {
  return sendMessage({ type: 'ptz', cameraId, op, speed });
}
