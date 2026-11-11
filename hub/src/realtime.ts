import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import {
  API_VERSION,
  PTZ_OPS,
  hasPermission,
  viewPermissionFor,
  type ClientMessage,
  type Entity,
  type HubEvent,
  type HubState,
  type Permission,
  type PtzOp,
  type ServerMessage,
} from '@home-hub/shared';
import type { SessionStore } from './auth/sessions.ts';
import type { UserRecord, UserStore } from './auth/users.ts';
import type { Logger } from './log.ts';
import type { StateStore } from './state.ts';

/**
 * Pushes live state to the apps over WebSocket.
 *
 * Every client only receives what its user may see. Connections are tied to
 * their session: when it is revoked or expires the socket is closed at once.
 */

interface Client {
  socket: WebSocket;
  sessionId: string;
  user: UserRecord;
  alive: boolean;
}

const HEARTBEAT_MS = 25_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 4096;

function canSee(user: UserRecord, entity: Entity): boolean {
  const needed = viewPermissionFor(entity.kind);
  return needed === null || hasPermission(user, needed);
}

function eventPermission(event: HubEvent): Permission | null {
  switch (event.type) {
    case 'doorbell':
    case 'door_motion':
    case 'door_opened':
    case 'history_updated':
      return 'doors.view';
  }
}

export function filterState(state: HubState, user: UserRecord): HubState {
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(state.entities)) {
    if (canSee(user, entity)) entities[id] = entity;
  }
  return { ...state, entities };
}

export interface RealtimeEvents {
  /** Fired when the first app connects / the last one disconnects. */
  activity: [active: boolean];
  ptz: [user: UserRecord, cameraId: string, op: PtzOp, speed: number | undefined];
}

export class RealtimeHub extends EventEmitter<RealtimeEvents> {
  private readonly clients = new Set<Client>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly state: StateStore,
    private readonly sessions: SessionStore,
    private readonly users: UserStore,
    private readonly log: Logger,
  ) {
    super();

    state.on('entities', (changed, removed) => {
      for (const client of this.clients) {
        const visible = changed.filter((entity) => canSee(client.user, entity));
        const gone = removed.filter((entity) => canSee(client.user, entity)).map((entity) => entity.id);
        if (visible.length > 0 || gone.length > 0) this.send(client, { type: 'entities', changed: visible, removed: gone });
      }
    });
    state.on('music', (music) => this.broadcast({ type: 'music', music }));
    state.on('services', (services) => this.broadcast({ type: 'services', services }));
    state.on('event', (event) => {
      const needed = eventPermission(event);
      for (const client of this.clients) {
        if (needed === null || hasPermission(client.user, needed)) this.send(client, { type: 'event', event });
      }
    });

    sessions.on('ended', (sessionId, reason) => {
      for (const client of [...this.clients]) {
        if (client.sessionId === sessionId) {
          this.send(client, { type: 'session_ended', reason });
          client.socket.close(4001, 'session ended');
        }
      }
    });

    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(socket: WebSocket, user: UserRecord, sessionId: string): void {
    const client: Client = { socket, sessionId, user, alive: true };
    const wasIdle = this.clients.size === 0;
    this.clients.add(client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.length > MAX_CLIENT_MESSAGE_BYTES) return;
      this.handleMessage(client, text);
    });
    socket.on('close', () => this.detach(client));
    socket.on('error', (err) => {
      this.log.debug({ err }, 'realtime socket error');
      this.detach(client);
    });

    this.send(client, { type: 'hello', apiVersion: API_VERSION, serverTime: Date.now() });
    this.send(client, { type: 'snapshot', state: filterState(this.state.snapshot(), user) });
    if (wasIdle) this.emit('activity', true);
  }

  private detach(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0) this.emit('activity', false);
  }

  /** Call after a user's role or permissions changed: re-evaluates what their apps may see. */
  refreshUser(userId: string): void {
    const user = this.users.get(userId);
    for (const client of [...this.clients]) {
      if (client.user.id !== userId) continue;
      if (!user || user.disabled) {
        client.socket.close(4001, 'session ended');
        continue;
      }
      client.user = user;
      this.send(client, { type: 'snapshot', state: filterState(this.state.snapshot(), user) });
    }
  }

  private handleMessage(client: Client, text: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ping') {
      this.send(client, { type: 'pong', t: typeof message.t === 'number' ? message.t : 0 });
    } else if (message.type === 'ptz') {
      if (!hasPermission(client.user, 'cameras.control')) return;
      if (typeof message.cameraId !== 'string' || !PTZ_OPS.includes(message.op)) return;
      const speed = typeof message.speed === 'number' && Number.isFinite(message.speed) ? message.speed : undefined;
      this.emit('ptz', client.user, message.cameraId, message.op, speed);
    }
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) this.sendRaw(client, payload);
  }

  private send(client: Client, message: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(message));
  }

  private sendRaw(client: Client, payload: string): void {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // The client cannot keep up; drop it — it reconnects and receives a fresh snapshot.
      socket.terminate();
      return;
    }
    socket.send(payload, (err) => {
      if (err) this.log.debug({ err }, 'realtime send failed');
    });
  }

  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (!client.alive) {
        client.socket.terminate();
        this.detach(client);
        continue;
      }
      if (!this.sessions.isAlive(client.sessionId)) {
        this.send(client, { type: 'session_ended', reason: 'expired' });
        client.socket.close(4001, 'session ended');
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const client of this.clients) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
  }
}
