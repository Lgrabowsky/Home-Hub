import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import type { Logger } from '../../log.ts';
import {
  KNX_PORT,
  MESSAGE_CODE,
  ROUTING_MULTICAST,
  SERVICE,
  STATUS_TEXT,
  connectRequest,
  connectionStateRequest,
  disconnectRequest,
  disconnectResponse,
  formatIndividualAddress,
  frame,
  groupReadCemi,
  parseCemi,
  parseConnectResponse,
  parseConnectionHeader,
  parseFrame,
  parseSearchResponse,
  searchRequest,
  tunnellingAck,
  tunnellingRequest,
  type FoundInterface,
  type GroupTelegram,
} from './protocol.ts';

/**
 * The hub's line to the KNX bus: a tunnel through a KNX IP interface (or
 * router), or listening to a KNX IP router's multicast ("routing"). Both
 * report group telegrams and can ask a group address for its value.
 */

export interface LinkStatus {
  connected: boolean;
  /** German, for the service health. */
  message: string;
  /** Individual address the hub has on the bus (tunnel), when connected. */
  address: string | null;
}

export interface LinkEvents {
  telegram: [telegram: GroupTelegram];
  status: [status: LinkStatus];
}

export interface KnxLink extends EventEmitter<LinkEvents> {
  start(): void;
  stop(): Promise<void>;
  /** GroupValue_Read; resolves once the bus took it (the answer comes as a telegram). */
  read(destination: number): Promise<void>;
  readonly status: LinkStatus;
}

const RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const HEARTBEAT_MS = 60_000;
const ANSWER_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 1_000;
const CONFIRM_TIMEOUT_MS = 3_000;

interface Waiter {
  match(service: number, body: Buffer): boolean;
  resolve(body: Buffer): void;
}

/** Tunnelling: one connection to a KNX IP interface; the interface acknowledges every frame. */
export class KnxTunnel extends EventEmitter<LinkEvents> implements KnxLink {
  private socket: Socket | null = null;
  private channel: number | null = null;
  private sendSequence = 0;
  private lastReceived = -1;
  private waiters = new Set<Waiter>();
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  status: LinkStatus = { connected: false, message: 'Verbinde mit der KNX-Schnittstelle …', address: null };

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly log: Logger,
  ) {
    super();
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    const socket = this.socket;
    if (socket && this.channel !== null) {
      const channel = this.channel;
      await this.request(disconnectRequest(channel), (service, body) => service === SERVICE.DISCONNECT_RESPONSE && body[0] === channel, 1000).catch(() => undefined);
    }
    this.channel = null;
    this.socket = null;
    socket?.close();
  }

  private setStatus(status: LinkStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  private async openSocket(): Promise<Socket> {
    if (this.socket) return this.socket;
    const socket = createSocket('udp4');
    socket.on('message', (data, from) => this.onMessage(data, from));
    socket.on('error', (err) => this.log.warn({ err: err.message }, 'KNX socket error'));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    this.socket = socket;
    return socket;
  }

  private send(data: Buffer): void {
    this.socket?.send(data, this.port, this.host);
  }

  /** Sends a frame and waits for the matching answer. */
  private request(data: Buffer, match: Waiter['match'], timeoutMs = ANSWER_TIMEOUT_MS): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (body) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(body);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.waiters.add(waiter);
      this.send(data);
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.openSocket();
      const body = await this.request(connectRequest(), (service) => service === SERVICE.CONNECT_RESPONSE);
      const answer = parseConnectResponse(body);
      if (answer.status !== 0) throw new Error(STATUS_TEXT[answer.status] ?? `Die Schnittstelle lehnt die Verbindung ab (Code ${answer.status}).`);
      this.channel = answer.channel;
      this.sendSequence = 0;
      this.lastReceived = -1;
      this.attempts = 0;
      const address = answer.address === null ? null : formatIndividualAddress(answer.address);
      this.log.info({ host: this.host, channel: answer.channel, address }, 'KNX tunnel connected');
      this.setStatus({ connected: true, message: `Verbunden${address ? ` als ${address}` : ''}`, address });
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => void this.checkAlive(), HEARTBEAT_MS);
      this.heartbeat.unref();
    } catch (err) {
      const reason = err instanceof Error && err.message !== 'timeout' ? err.message : `Die KNX-Schnittstelle ${this.host} antwortet nicht.`;
      this.lost(reason);
    }
  }

  /** The connection is gone: tell, and try again after a while. */
  private lost(reason: string): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel = null;
    if (this.stopped) return;
    this.setStatus({ connected: false, message: reason, address: null });
    const delay = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)]!;
    this.attempts++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), delay);
    this.retry.unref();
  }

  private async checkAlive(): Promise<void> {
    const channel = this.channel;
    if (channel === null) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = await this.request(connectionStateRequest(channel), (service, answer) => service === SERVICE.CONNECTIONSTATE_RESPONSE && answer[0] === channel);
        if (body[1] === 0) return;
        break;
      } catch {
        /* try again */
      }
    }
    if (this.channel === channel) this.lost('Die Verbindung zur KNX-Schnittstelle ist abgerissen.');
  }

  private onMessage(data: Buffer, from: RemoteInfo): void {
    const parsed = parseFrame(data);
    if (!parsed) return;
    const { service, body } = parsed;
    for (const waiter of this.waiters) {
      if (waiter.match(service, body)) {
        waiter.resolve(body);
        return;
      }
    }
    if (service === SERVICE.TUNNELLING_REQUEST) {
      const header = parseConnectionHeader(body);
      if (!header || header.channel !== this.channel) return;
      this.socket?.send(tunnellingAck(header.channel, header.sequence), from.port, from.address);
      // A repeated frame (our acknowledgement got lost) is acknowledged again but handled once.
      if (header.sequence === this.lastReceived) return;
      this.lastReceived = header.sequence;
      const telegram = parseCemi(header.rest);
      if (telegram && telegram.messageCode === MESSAGE_CODE.L_DATA_IND) this.emit('telegram', telegram);
    } else if (service === SERVICE.DISCONNECT_REQUEST) {
      const channel = body[0] ?? 0;
      this.socket?.send(disconnectResponse(channel), from.port, from.address);
      if (channel === this.channel) this.lost('Die KNX-Schnittstelle hat die Verbindung beendet.');
    }
  }

  read(destination: number): Promise<void> {
    const next = this.queue.then(() => this.sendCemi(groupReadCemi(destination), destination));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** One frame at a time: acknowledged by the interface, then confirmed from the bus. */
  private async sendCemi(cemi: Buffer, destination: number): Promise<void> {
    const channel = this.channel;
    if (channel === null) throw new Error('Keine Verbindung zum KNX-Bus.');
    const sequence = this.sendSequence;
    const isAck = (service: number, body: Buffer) => service === SERVICE.TUNNELLING_ACK && body[1] === channel && body[2] === sequence;
    let acknowledged = false;
    for (let attempt = 0; attempt < 2 && !acknowledged; attempt++) {
      try {
        // Some interfaces confirm before they acknowledge: listen from the start (a missing confirmation is no error).
        const confirmed = this.waitForConfirmation(destination).catch(() => undefined);
        const ack = await this.request(tunnellingRequest(channel, sequence, cemi), isAck, ACK_TIMEOUT_MS);
        acknowledged = true;
        this.sendSequence = (sequence + 1) & 0xff;
        if (ack[3] !== 0) throw new Error('Die KNX-Schnittstelle hat das Telegramm abgelehnt.');
        await confirmed;
      } catch (err) {
        if (acknowledged) throw err;
      }
    }
    if (!acknowledged) {
      this.lost('Die KNX-Schnittstelle bestätigt keine Telegramme mehr.');
      throw new Error('Die KNX-Schnittstelle antwortet nicht.');
    }
  }

  /** The interface reports back (L_Data.con) once the telegram went over the bus. */
  private waitForConfirmation(destination: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match: (service, body) => {
          if (service !== SERVICE.TUNNELLING_REQUEST) return false;
          const header = parseConnectionHeader(body);
          const telegram = header ? parseCemi(header.rest) : null;
          if (!header || !telegram || telegram.messageCode !== MESSAGE_CODE.L_DATA_CON || telegram.destination !== destination) return false;
          // Acknowledge it like any other frame from the interface.
          this.send(tunnellingAck(header.channel, header.sequence));
          this.lastReceived = header.sequence;
          return true;
        },
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('timeout'));
      }, CONFIRM_TIMEOUT_MS);
      this.waiters.add(waiter);
    });
  }
}

/** Routing: a KNX IP router sends every telegram of its line to a multicast group; the hub listens there. */
export class KnxRouting extends EventEmitter<LinkEvents> implements KnxLink {
  private socket: Socket | null = null;
  status: LinkStatus = { connected: false, message: 'Starte …', address: null };

  constructor(
    private readonly log: Logger,
    /** Address the hub's own read requests carry. */
    private readonly ownAddress = 0xfffa,
    private readonly port = KNX_PORT,
    private readonly group = ROUTING_MULTICAST,
  ) {
    super();
  }

  start(): void {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (data) => this.handle(data));
    socket.on('error', (err) => {
      this.log.warn({ err: err.message }, 'KNX routing socket error');
      this.status = { connected: false, message: `Mithören im Netz nicht möglich: ${err.message}`, address: null };
      this.emit('status', this.status);
    });
    socket.bind(this.port, () => {
      try {
        socket.addMembership(this.group);
        socket.setMulticastLoopback(false);
        this.status = { connected: true, message: 'Hört im Netz mit (Routing)', address: formatIndividualAddress(this.ownAddress) };
      } catch (err) {
        this.status = { connected: false, message: `Mithören im Netz nicht möglich: ${(err as Error).message}`, address: null };
      }
      this.emit('status', this.status);
    });
  }

  /** Public for tests: one datagram as it arrives. */
  handle(data: Buffer): void {
    const parsed = parseFrame(data);
    if (!parsed || parsed.service !== SERVICE.ROUTING_INDICATION) return;
    const telegram = parseCemi(parsed.body);
    if (telegram && telegram.source !== this.ownAddress) this.emit('telegram', telegram);
  }

  async read(destination: number): Promise<void> {
    if (!this.socket || !this.status.connected) throw new Error('Keine Verbindung zum KNX-Bus.');
    this.socket.send(frame(SERVICE.ROUTING_INDICATION, groupReadCemi(destination, MESSAGE_CODE.L_DATA_IND, this.ownAddress)), this.port, this.group);
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

/** This machine's IPv4 addresses in the home network (for the search's answer address). */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.family === 'IPv4' && !entry.internal))
    .map((entry) => entry.address);
}

/** Asks the network for KNX IP interfaces and routers (KNXnet/IP search, multicast). */
export async function searchInterfaces(timeoutMs = 3000, target = { host: ROUTING_MULTICAST, port: KNX_PORT }): Promise<FoundInterface[]> {
  const found = new Map<string, FoundInterface>();
  const addresses = target.host === ROUTING_MULTICAST ? localAddresses() : ['127.0.0.1'];
  await Promise.all(
    addresses.map(
      (address) =>
        new Promise<void>((resolve) => {
          const socket = createSocket('udp4');
          const done = () => {
            try {
              socket.close();
            } catch {
              /* already closed */
            }
            resolve();
          };
          socket.on('error', done);
          socket.on('message', (data, from) => {
            const parsed = parseFrame(data);
            if (!parsed || parsed.service !== SERVICE.SEARCH_RESPONSE) return;
            const entry = parseSearchResponse(parsed.body, from.address);
            if (entry) found.set(`${entry.host}:${entry.port}`, entry);
          });
          socket.bind(0, address, () => {
            try {
              if (target.host === ROUTING_MULTICAST) socket.setMulticastInterface(address);
              socket.send(searchRequest(address, socket.address().port), target.port, target.host);
            } catch {
              done();
              return;
            }
            setTimeout(done, timeoutMs).unref();
          });
        }),
    ),
  );
  return [...found.values()].sort((a, b) => a.host.localeCompare(b.host));
}
