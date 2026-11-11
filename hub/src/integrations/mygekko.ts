import type { ContactCandidate, EntityCommand, MyGekkoSettings, TestResult } from '@home-hub/shared';
import { HttpError } from '../http/errors.ts';
import { sleep } from '../util/http.ts';
import { Poller } from '../util/poller.ts';
import { GekkoClient, GekkoError, isGekkoError, type GekkoErrorKind } from './mygekko/client.ts';
import { isSuperseding, planCommand } from './mygekko/commands.ts';
import { ROOM_WINDOW_FIELD, listCandidates, openRoomWindows, resolveContacts, type ResolvedContact } from './mygekko/contacts.ts';
import { EntityFactory, MAPPED_SYSTEMS, SERVICE } from './mygekko/entities.ts';
import { controllerKey, credentialsKey, loginBlockedUntil, noteRejection } from './mygekko/lockout.ts';
import { clockTime, describeFailure, missingSetting } from './mygekko/messages.ts';
import { filled, parseStatus, parseTree, splitSumstate, type GekkoStatus, type GekkoTree, type TreeItem } from './mygekko/protocol.ts';
import { runConnectionTest } from './mygekko/selftest.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/** All pauses and intervals of the integration (milliseconds). Tests shorten them. */
export interface MyGekkoTiming {
  /** Status poll while an app is open / while nobody is looking. */
  activeMs: number;
  idleMs: number;
  /** The resource tree (names, pages, formats) only changes when the controller is reconfigured. */
  treeRefreshMs: number;
  /** After a failed refresh of a tree that is already known. */
  treeRetryMs: number;
  requestTimeoutMs: number;
  /** After a rejected login: the controller locks the account for 10 minutes on repeated attempts. */
  authPauseMs: number;
  /** After HTTP 429 (session / rate limit). */
  rateLimitPauseMs: number;
  /** After other answers that are errors; doubles up to the maximum. Every failed call raises an alarm on the controller's display. */
  errorPauseMs: number;
  errorPauseMaxMs: number;
  /** After network errors; doubles up to the maximum. */
  retryMs: number;
  retryMaxMs: number;
  /** Extra status polls after a command, so the app sees the result quickly. */
  commandKicksMs: readonly number[];
  /** Cloud: the first answer may lack values because the server only subscribes on the first query. */
  cloudSettleMs: number;
  /** Minimum distance between two commands / two status polls. */
  commandGapMs: number;
  minPollGapMs: number;
  /** While on plain HTTP: how often to check whether HTTPS works (again). */
  httpsRetryMs: number;
}

const LOCAL_TIMING: MyGekkoTiming = {
  activeMs: 2000,
  idleMs: 20_000,
  treeRefreshMs: 30 * 60_000,
  treeRetryMs: 60_000,
  requestTimeoutMs: 6000,
  authPauseMs: 11 * 60_000,
  rateLimitPauseMs: 4.5 * 60_000,
  errorPauseMs: 30_000,
  errorPauseMaxMs: 5 * 60_000,
  retryMs: 2000,
  retryMaxMs: 60_000,
  commandKicksMs: [400, 1500],
  cloudSettleMs: 2000,
  commandGapMs: 150,
  minPollGapMs: 250,
  httpsRetryMs: 30 * 60_000,
};

/** The cloud relays the controller's values with a delay and limits the number of requests. */
const CLOUD_TIMING: MyGekkoTiming = {
  ...LOCAL_TIMING,
  activeMs: 10_000,
  idleMs: 60_000,
  requestTimeoutMs: 15_000,
  retryMs: 5000,
  commandKicksMs: [1500, 4000],
  commandGapMs: 600,
  minPollGapMs: 2000,
};

export function defaultTiming(mode: MyGekkoSettings['mode']): MyGekkoTiming {
  return mode === 'cloud' ? CLOUD_TIMING : LOCAL_TIMING;
}

export interface MyGekkoOptions {
  timing?: Partial<MyGekkoTiming>;
  /** Tests point the cloud mode at a simulator instead of live.my-gekko.com. */
  cloudBaseUrl?: string;
}

/** Key of the integration's own state in the settings store (encrypted at rest, never sent to clients). */
const STATE_KEY = 'mygekko.state';

interface PersistedState {
  /** The controller the entries belong to. */
  controller: string;
  /** Room controllers whose window contact was seen open (see `resolveContacts`). */
  windowContacts: string[];
  /** A login the controller rejected: not to be repeated before `until`. */
  authBlock: { credentials: string; until: number } | null;
}

interface QueuedCommand {
  entityId: string;
  command: EntityCommand;
  waiters: { resolve: () => void; reject: (err: unknown) => void }[];
}

type PauseReason = 'auth' | 'rate_limit' | 'error' | 'retry';

/** A cloud answer without any content is tolerated this often in a row (the server is still subscribing). */
const MAX_EMPTY_CLOUD_ANSWERS = 3;

function unavailable(message: string): HttpError {
  return new HttpError(503, 'unavailable', message);
}

/**
 * myGEKKO building controller (Query API, local or via live.my-gekko.com).
 *
 * One loop reads the status (and, rarely, the resource tree) and publishes the
 * complete entity list; commands go through a queue that sends one at a time.
 * Everything is built around the controller's rules: wrong credentials and
 * rate limits pause all traffic, a command is sent exactly once, and nothing
 * is sent that the addressed element does not document.
 */
export class MyGekkoIntegration implements Integration {
  private readonly timing: MyGekkoTiming;
  private readonly client: GekkoClient | null;
  private readonly configProblem: string | null;
  private readonly poller: Poller;
  private readonly factory = new EntityFactory();
  /** Aborts requests that are on their way when the integration stops. */
  private readonly abort = new AbortController();
  private readonly timers = new Set<NodeJS.Timeout>();

  private started = false;
  private stopped = false;
  private active = false;

  // --- What is known about the controller ---------------------------------------
  private tree: GekkoTree | null = null;
  private treeLoadedAt = 0;
  private treeFailedAt = 0;
  /** A command hit an element the controller no longer has: read the tree again. */
  private treeStale = false;
  /** Elements the status mentions although the freshly read tree does not (no reason to re-read it). */
  private unknownElements = new Set<string>();
  /** Latest fields per `system/element`. */
  private readonly values = new Map<string, string[]>();
  private readonly meteo = new Map<string, string>();
  private network: GekkoStatus['network'] = { gekkoName: null, version: null, hardware: null };
  private elements = new Map<string, TreeItem>();
  private contacts: ResolvedContact[] = [];
  private notes: string[] = [];
  private readonly provenWindows = new Set<string>();
  private authBlockStored = false;

  // --- Health -------------------------------------------------------------------
  private online = false;
  private failures = 0;
  private emptyAnswers = 0;
  private pausedUntil = 0;
  private pauseReason: PauseReason | null = null;
  private commandsBlockedUntil = 0;
  private lastPollAt = 0;
  private lastOkAt: number | null = null;
  private lastPollMs: number | null = null;
  private lastProblem: { kind: GekkoErrorKind | 'unexpected'; status: number | null; at: number } | null = null;

  // --- Commands -----------------------------------------------------------------
  private readonly queue = new Map<string, QueuedCommand>();
  private draining: Promise<void> | null = null;
  private commandSeq = 0;
  /** Counts executed commands; a status answer that was requested before a command may predate it. */
  private commandEpoch = 0;
  private lastCommandAt = 0;
  private readonly stats = { polls: 0, failedPolls: 0, commands: 0, failedCommands: 0, superseded: 0 };

  constructor(
    protected readonly deps: IntegrationDeps,
    protected readonly settings: MyGekkoSettings,
    options: MyGekkoOptions = {},
  ) {
    this.timing = { ...defaultTiming(settings.mode), ...options.timing };
    let client: GekkoClient | null = null;
    let problem = missingSetting(settings);
    if (!problem) {
      try {
        client = new GekkoClient(settings, {
          timeoutMs: this.timing.requestTimeoutMs,
          httpsRetryMs: this.timing.httpsRetryMs,
          cloudBaseUrl: options.cloudBaseUrl,
        });
      } catch (err) {
        problem = describeFailure(err, settings.mode);
      }
    }
    this.client = client;
    this.configProblem = problem;
    this.poller = new Poller(
      (signal) => this.tick(signal),
      () => this.nextDelay(),
      (err) => this.deps.log.error({ err }, 'myGEKKO poll loop failed unexpectedly'),
    );
  }

  // --- Life cycle -----------------------------------------------------------------

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.client) {
      this.deps.state.setService(SERVICE, 'offline', this.configProblem);
      return;
    }
    this.restore();
    this.poller.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.abort.abort();
    const restarting = unavailable('Die Verbindung zum myGEKKO wird gerade neu aufgebaut. Bitte gleich noch einmal versuchen.');
    for (const job of this.queue.values()) for (const waiter of job.waiters) waiter.reject(restarting);
    this.queue.clear();
    await this.poller.stop();
    await this.draining;
    this.client?.destroy();
  }

  setActive(active: boolean): void {
    const wake = active && !this.active;
    this.active = active;
    // An app was just opened: do not make it wait for the slow idle rhythm.
    if (wake) this.poller.kick();
  }

  diagnostics(): unknown {
    const iso = (timestamp: number | null) => (timestamp ? new Date(timestamp).toISOString() : null);
    const systems: Record<string, { items: number; groups: number }> = {};
    const unmapped: Record<string, number> = {};
    for (const [system, items] of this.tree?.systems ?? []) {
      const groups = [...items.values()].filter((item) => item.isGroup).length;
      systems[system] = { items: items.size - groups, groups };
      const used = (MAPPED_SYSTEMS as readonly string[]).includes(system) || this.contacts.some((contact) => contact.source.startsWith(`${system}/`));
      if (!used) unmapped[system] = items.size - groups;
    }
    const entities: Record<string, number> = {};
    for (const entity of this.deps.state.all()) {
      if (entity.service === SERVICE) entities[entity.kind] = (entities[entity.kind] ?? 0) + 1;
    }
    const paused = Date.now() < this.pausedUntil;
    return {
      mode: this.settings.mode,
      transport: this.client?.transport ?? null,
      online: this.online,
      configProblem: this.configProblem,
      controller: { name: this.network.gekkoName, firmware: this.network.version, hardware: this.network.hardware },
      polling: {
        appOpen: this.active,
        intervalMs: this.active ? this.timing.activeMs : this.timing.idleMs,
        lastOkAt: iso(this.lastOkAt),
        lastDurationMs: this.lastPollMs,
        consecutiveFailures: this.failures,
        lastProblem: this.lastProblem ? { ...this.lastProblem, at: iso(this.lastProblem.at) } : null,
        pausedUntil: paused ? iso(this.pausedUntil) : null,
        pauseReason: paused ? this.pauseReason : null,
        polls: this.stats.polls,
        failedPolls: this.stats.failedPolls,
      },
      tree: { loadedAt: iso(this.treeLoadedAt || null), systems },
      unmapped,
      entities,
      contacts: {
        explicit: this.contacts.filter((contact) => !contact.auto).length,
        automatic: this.contacts.filter((contact) => contact.auto).length,
        // Room controllers report a window state whether or not a contact is wired;
        // they become contacts once the window was seen open.
        roomControllersReportingWindow: this.roomControllersReportingWindow(),
        provenWindowContacts: [...this.provenWindows],
        notes: this.notes,
      },
      commands: {
        sent: this.stats.commands,
        failed: this.stats.failedCommands,
        superseded: this.stats.superseded,
        waiting: this.queue.size,
      },
    };
  }

  // --- Public operations ------------------------------------------------------------

  /**
   * Executes a command on one of this integration's entities (`gekko:…`).
   * Throws `HttpError` (German message) when the entity is unknown, the command
   * does not fit the entity or the controller rejects it.
   */
  async command(entityId: string, command: EntityCommand): Promise<void> {
    const entity = this.deps.state.get(entityId);
    if (!entity || entity.service !== SERVICE) throw new HttpError(404, 'not_found', 'Dieses Gerät gibt es auf dem myGEKKO nicht (mehr).');
    const item = this.elements.get(entityId);
    if (!item) {
      if (entity.kind === 'contact' || entity.kind === 'alarm' || entity.kind === 'sensor') {
        throw new HttpError(400, 'unsupported', `„${entity.name}“ zeigt nur einen Zustand an und lässt sich nicht bedienen.`);
      }
      throw unavailable(`„${entity.name}“ ist gerade nicht erreichbar.`);
    }
    this.assertReady();
    // Refuse what cannot work right away instead of after waiting in the queue.
    planCommand(entity, item, command);
    return this.enqueue(entityId, command);
  }

  /** Every element that could be a window/door contact, with its raw values (admin mapping / learn UI). */
  contactCandidates(): ContactCandidate[] {
    if (!this.tree) return [];
    return listCandidates(this.tree, this.values, this.settings, this.contacts);
  }

  /** Connection test for (possibly unsaved) settings. Never throws. */
  static async test(settings: MyGekkoSettings, options: MyGekkoOptions = {}): Promise<TestResult> {
    try {
      const timing = { ...defaultTiming(settings.mode), ...options.timing };
      return await runConnectionTest(settings, { timing, cloudBaseUrl: options.cloudBaseUrl });
    } catch {
      return { ok: false, message: 'Der Test konnte nicht durchgeführt werden. Bitte später noch einmal versuchen.', details: [] };
    }
  }

  // --- Polling --------------------------------------------------------------------

  private nextDelay(): number {
    const remaining = this.pausedUntil - Date.now();
    // Sleep through a pause, but look up now and then so a changed rhythm is picked up.
    if (remaining > 0) return Math.min(Math.max(remaining, 50), 60_000);
    return this.active ? this.timing.activeMs : this.timing.idleMs;
  }

  private kickLater(delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.poller.kick();
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private async tick(signal: AbortSignal): Promise<void> {
    const client = this.client;
    if (!client || this.stopped || Date.now() < this.pausedUntil) return;
    const wait = this.lastPollAt + this.timing.minPollGapMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    if (this.stopped || signal.aborted) return;

    const startedAt = Date.now();
    this.lastPollAt = startedAt;
    this.stats.polls++;
    const epoch = this.commandEpoch;
    try {
      const status = parseStatus(await client.readStatus(signal));
      if (this.stopped) return;
      if (!status) throw new GekkoError('status is not a JSON object', 'protocol');
      if (!status.hasGlobals && status.values.size === 0) {
        if (client.mode !== 'cloud' || ++this.emptyAnswers > MAX_EMPTY_CLOUD_ANSWERS) throw new GekkoError('status carries no data', 'protocol');
        this.kickLater(this.timing.cloudSettleMs);
        return;
      }
      this.emptyAnswers = 0;
      await this.refreshTree(client, status, signal);
      if (this.stopped) return;
      this.lastPollMs = Date.now() - startedAt;
      this.absorb(status);
      if (epoch === this.commandEpoch) {
        this.publish();
      } else {
        // The answer may be older than a command that went through meanwhile; showing it
        // would flip the entity back. The polls scheduled after the command bring the truth.
        this.kickLater(this.timing.minPollGapMs);
      }
      this.pollSucceeded(client);
    } catch (err) {
      if (this.stopped || signal.aborted) return;
      this.pollFailed(err);
    }
  }

  /** Reads the resource tree when it is missing, old, or the status shows an element it does not know. */
  private async refreshTree(client: GekkoClient, status: GekkoStatus, signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const unknown = this.tree ? [...status.values.keys()].filter((key) => !this.knows(key)) : [];
    const due =
      !this.tree || this.treeStale || now - this.treeLoadedAt >= this.timing.treeRefreshMs || unknown.some((key) => !this.unknownElements.has(key));
    if (!due) return;
    if (this.tree && now - this.treeFailedAt < this.timing.treeRetryMs) return;
    try {
      const tree = parseTree(await client.readTree(signal));
      if (!tree) throw new GekkoError('resource tree is not a JSON object', 'protocol');
      this.tree = tree;
      this.treeLoadedAt = Date.now();
      this.treeFailedAt = 0;
      this.treeStale = false;
      this.unknownElements = new Set([...status.values.keys()].filter((key) => !this.knows(key)));
      for (const key of this.values.keys()) if (!this.knows(key)) this.values.delete(key);
      const systems: Record<string, number> = {};
      for (const [system, items] of tree.systems) systems[system] = items.size;
      this.deps.log.info({ systems }, 'myGEKKO resource tree loaded');
    } catch (err) {
      // Without any tree there is nothing to show; rejected logins and rate limits pause everything.
      const fatal = !this.tree || !isGekkoError(err) || err.kind === 'auth' || err.kind === 'rate_limit' || err.kind === 'aborted';
      if (fatal) throw err;
      this.treeFailedAt = Date.now();
      this.deps.log.warn({ kind: err.kind, status: err.status }, 'refreshing the myGEKKO resource tree failed, keeping the previous one');
    }
  }

  private knows(key: string): boolean {
    const [system = '', element = ''] = key.split('/');
    return this.tree?.systems.get(system)?.has(element) ?? false;
  }

  /** Takes over what the answer carries; what it lacks keeps its last value (a cloud answer may be partial). */
  private absorb(status: GekkoStatus): void {
    for (const [key, raw] of status.values) this.values.set(key, splitSumstate(raw));
    for (const [key, raw] of status.meteo) this.meteo.set(key, raw);
    this.network = {
      gekkoName: status.network.gekkoName ?? this.network.gekkoName,
      version: status.network.version ?? this.network.version,
      hardware: status.network.hardware ?? this.network.hardware,
    };
    if (!this.tree) return;
    const opened = openRoomWindows(this.tree, this.values).filter((source) => !this.provenWindows.has(source));
    if (opened.length > 0) {
      for (const source of opened) this.provenWindows.add(source);
      this.deps.log.info({ sources: opened }, 'room controller reports an open window: shown as contact from now on');
      this.persist();
    }
  }

  private publish(): void {
    const tree = this.tree;
    if (!tree || this.stopped) return;
    this.contacts = resolveContacts(tree, this.values, this.settings, this.provenWindows);
    const built = this.factory.build({ tree, values: this.values, meteo: this.meteo, contacts: this.contacts, now: Date.now() });
    this.elements = built.elements;
    this.notes = built.notes;
    this.deps.state.replace(SERVICE, built.entities);
  }

  private pollSucceeded(client: GekkoClient): void {
    const { log, state } = this.deps;
    if (!this.online) {
      log.info({ transport: client.transport, firmware: this.network.version, firstContact: this.lastOkAt === null }, 'myGEKKO is reachable');
      // The first cloud answer after a break may lack values (the server subscribes on the first query).
      if (client.mode === 'cloud') this.kickLater(this.timing.cloudSettleMs);
    }
    this.online = true;
    this.failures = 0;
    this.pausedUntil = 0;
    this.pauseReason = null;
    this.lastOkAt = Date.now();
    if (this.authBlockStored) {
      this.authBlockStored = false;
      this.persist();
    }
    state.setService(SERVICE, 'ok');
  }

  private pollFailed(err: unknown): void {
    const { log } = this.deps;
    const kind = isGekkoError(err) ? err.kind : 'unexpected';
    const status = isGekkoError(err) ? (err.status ?? null) : null;
    this.stats.failedPolls++;
    this.failures++;
    this.lastProblem = { kind, status, at: Date.now() };
    if (kind === 'unexpected') log.error({ err }, 'unexpected error while reading the myGEKKO');

    let message = describeFailure(err, this.settings.mode);
    if (kind === 'auth') {
      message = this.loginRejected(message);
    } else if (kind === 'rate_limit') {
      this.pause(Date.now() + this.timing.rateLimitPauseMs, 'rate_limit');
    } else if (kind === 'timeout' || kind === 'network') {
      this.pause(Date.now() + this.backoff(this.timing.retryMs, this.timing.retryMaxMs), 'retry');
    } else {
      // The controller answered, but with an error: every further failed call would raise
      // another alarm pop-up on its display, so these are retried sparingly.
      this.pause(Date.now() + this.backoff(this.timing.errorPauseMs, this.timing.errorPauseMaxMs), 'error');
    }

    if (this.failures >= 2) {
      this.goOffline(message, { kind, status });
    } else {
      // A single failure is not worth alarming anybody (no flapping); only a rate limit is announced,
      // because commands are refused while it lasts.
      if (kind === 'rate_limit') this.deps.state.setService(SERVICE, 'degraded', message);
      log.debug({ kind, status }, 'reading the myGEKKO failed, trying again');
    }
  }

  private backoff(baseMs: number, maxMs: number): number {
    return Math.min(maxMs, baseMs * 2 ** Math.min(this.failures - 1, 10));
  }

  private pause(until: number, reason: PauseReason): void {
    this.pausedUntil = until;
    this.pauseReason = reason;
  }

  private goOffline(message: string, cause: { kind: string; status: number | null }): void {
    if (this.stopped) return;
    const { log, state } = this.deps;
    if (this.online || state.getService(SERVICE).status !== 'offline') log.warn(cause, 'myGEKKO is offline');
    this.online = false;
    state.setService(SERVICE, 'offline', message);
    state.setAvailable(SERVICE, false);
  }

  /**
   * The controller rejected the login. Nothing is sent to it until the lock-out
   * window has passed — also not by a restarted integration or hub.
   * Returns the health message including the time of the next attempt.
   */
  private loginRejected(message: string): string {
    const now = Date.now();
    const until = now + this.timing.authPauseMs;
    noteRejection(this.settings, now);
    this.pause(until, 'auth');
    this.authBlockStored = true;
    this.persist({ credentials: credentialsKey(this.settings), until });
    // No second attempt is needed to know that this will not work.
    this.failures = Math.max(this.failures, 2);
    return `${message} Nächster Versuch gegen ${clockTime(until)} Uhr.`;
  }

  // --- Persistent state -------------------------------------------------------------

  private restore(): void {
    const now = Date.now();
    let blockedUntil = loginBlockedUntil(this.settings, now, this.timing.authPauseMs) ?? 0;
    try {
      const stored = this.deps.settings.getInternal<Partial<PersistedState>>(STATE_KEY);
      if (stored && stored.controller === controllerKey(this.settings)) {
        for (const source of Array.isArray(stored.windowContacts) ? stored.windowContacts : []) {
          if (typeof source === 'string') this.provenWindows.add(source);
        }
        const block = stored.authBlock;
        if (block && block.credentials === credentialsKey(this.settings) && typeof block.until === 'number') {
          this.authBlockStored = true;
          // A wrong clock must not stretch the pause beyond its length.
          blockedUntil = Math.max(blockedUntil, Math.min(block.until, now + this.timing.authPauseMs));
        }
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'could not read the stored myGEKKO state');
    }
    if (blockedUntil > now) {
      this.pause(blockedUntil, 'auth');
      this.failures = 2;
      this.lastProblem = { kind: 'auth', status: 403, at: now };
      const message = describeFailure(new GekkoError('login was rejected recently', 'auth', 403), this.settings.mode);
      this.goOffline(`${message} Nächster Versuch gegen ${clockTime(blockedUntil)} Uhr.`, { kind: 'auth', status: 403 });
    }
  }

  private persist(authBlock: PersistedState['authBlock'] = null): void {
    if (this.stopped) return;
    const state: PersistedState = { controller: controllerKey(this.settings), windowContacts: [...this.provenWindows], authBlock };
    try {
      this.deps.settings.setInternal(STATE_KEY, state);
    } catch (err) {
      this.deps.log.warn({ err }, 'could not store the myGEKKO state');
    }
  }

  private roomControllersReportingWindow(): number {
    let count = 0;
    for (const item of this.tree?.systems.get('roomtemps')?.values() ?? []) {
      if (!item.isGroup && filled(this.values.get(`roomtemps/${item.key}`)?.[ROOM_WINDOW_FIELD])) count++;
    }
    return count;
  }

  // --- Commands ---------------------------------------------------------------------

  /** Throws when nothing may be sent to the controller right now. */
  private assertReady(): void {
    const now = Date.now();
    if (this.stopped || !this.started || !this.client) throw unavailable('Der myGEKKO ist gerade nicht verbunden.');
    if (now < this.pausedUntil && this.pauseReason === 'auth') {
      throw unavailable('Der myGEKKO lehnt die Anmeldung des Hubs ab. Bitte die Zugangsdaten in den Einstellungen prüfen.');
    }
    if (now < this.pausedUntil && this.pauseReason === 'rate_limit') {
      throw new HttpError(
        429,
        'rate_limited',
        'Der myGEKKO nimmt gerade keine Befehle an (zu viele Anfragen). Bitte in ein paar Minuten noch einmal versuchen.',
        Math.ceil((this.pausedUntil - now) / 1000),
      );
    }
    if (now < this.commandsBlockedUntil) {
      throw new HttpError(502, 'device_forbidden', 'Der myGEKKO hat eben einen Befehl des Hubs abgelehnt. Bitte prüfen, ob der Benutzer am myGEKKO schalten darf, und gleich noch einmal versuchen.');
    }
    if (!this.online) throw unavailable('Der myGEKKO ist gerade nicht erreichbar.');
  }

  /**
   * Commands are sent one after another. While a command for the same entity
   * and action is still waiting (a slider being dragged), a newer one takes
   * its place; everybody who asked gets the outcome of the one that was sent.
   */
  private enqueue(entityId: string, command: EntityCommand): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      const key = isSuperseding(command) ? `${entityId}|${command.action}` : `${entityId}|${command.action}|${++this.commandSeq}`;
      const waiting = this.queue.get(key);
      if (waiting) {
        waiting.command = command;
        waiting.waiters.push({ resolve, reject });
        this.stats.superseded++;
      } else {
        this.queue.set(key, { entityId, command, waiters: [{ resolve, reject }] });
      }
    });
    this.draining ??= this.drain();
    return promise;
  }

  /** Works the queue off; never rejects. */
  private async drain(): Promise<void> {
    try {
      for (;;) {
        const next = this.queue.entries().next();
        if (next.done) break;
        const [key, job] = next.value;
        this.queue.delete(key);
        try {
          await this.execute(job);
          for (const waiter of job.waiters) waiter.resolve();
        } catch (err) {
          this.stats.failedCommands++;
          for (const waiter of job.waiters) waiter.reject(err);
        }
      }
    } finally {
      // Cleared in the same step in which the queue was found empty, so a command
      // arriving right afterwards starts a new run instead of waiting forever.
      this.draining = null;
    }
  }

  private async execute(job: QueuedCommand): Promise<void> {
    const gap = this.lastCommandAt + this.timing.commandGapMs - Date.now();
    if (gap > 0) await sleep(gap, this.abort.signal);
    this.assertReady();
    const entity = this.deps.state.get(job.entityId);
    const item = this.elements.get(job.entityId);
    if (!entity || !item) throw new HttpError(404, 'not_found', 'Dieses Gerät gibt es auf dem myGEKKO nicht (mehr).');
    // Planned at the moment of sending: toggling a group depends on its state right now.
    const plan = planCommand(entity, item, job.command);

    this.lastCommandAt = Date.now();
    try {
      await this.client!.sendCommand(item.system, item.key, plan.value, this.abort.signal);
    } catch (err) {
      throw this.commandFailed(err, entity.name);
    } finally {
      this.lastCommandAt = Date.now();
    }
    if (this.stopped) return;
    this.commandEpoch++;
    this.stats.commands++;
    // Shown at once; the next status poll replaces it with what the controller reports.
    this.deps.state.patch(job.entityId, plan.optimistic);
    this.deps.log.debug({ entity: job.entityId, action: job.command.action, scmd: plan.value }, 'myGEKKO command sent');
    for (const delay of this.timing.commandKicksMs) this.kickLater(delay);
  }

  /** Turns a failed command into the error shown to the user (and draws the consequences for the connection). */
  private commandFailed(err: unknown, name: string): HttpError {
    const { log } = this.deps;
    if (this.stopped) return unavailable('Die Verbindung zum myGEKKO wird gerade neu aufgebaut. Bitte gleich noch einmal versuchen.');
    if (!isGekkoError(err)) {
      log.error({ err }, 'unexpected error while sending a myGEKKO command');
      return new HttpError(502, 'device_error', 'Der Befehl konnte nicht an den myGEKKO gesendet werden.');
    }
    log.warn({ kind: err.kind, status: err.status }, 'myGEKKO command failed');
    switch (err.kind) {
      case 'auth':
        // Reading worked a moment ago, so this is most likely a missing write permission.
        // No more commands for a while (each one would raise an alarm on the controller);
        // the next status poll tells whether the login itself still works.
        this.commandsBlockedUntil = Date.now() + this.timing.errorPauseMs;
        this.poller.kick();
        // 502, not 403: for the app a 403 means that the signed-in person lacks a permission on the hub.
        return new HttpError(502, 'device_forbidden', 'Der myGEKKO hat den Befehl abgelehnt. Bitte prüfen, ob der Benutzer am myGEKKO schalten darf.');
      case 'rate_limit': {
        const until = Date.now() + this.timing.rateLimitPauseMs;
        this.pause(until, 'rate_limit');
        this.deps.state.setService(SERVICE, 'degraded', describeFailure(err, this.settings.mode));
        return new HttpError(
          429,
          'rate_limited',
          'Der myGEKKO nimmt gerade keine Befehle an (zu viele Anfragen). Bitte in ein paar Minuten noch einmal versuchen.',
          Math.ceil(this.timing.rateLimitPauseMs / 1000),
        );
      }
      case 'not_found':
        this.treeStale = true;
        this.poller.kick();
        return new HttpError(404, 'not_found', `„${name}“ gibt es auf dem myGEKKO nicht mehr.`);
      case 'not_writable':
        return new HttpError(400, 'unsupported', `„${name}“ lässt sich nicht schalten.`);
      case 'not_executed':
        return new HttpError(409, 'not_executed', `Der myGEKKO konnte den Befehl für „${name}“ nicht ausführen.`);
      case 'gone':
        this.poller.kick();
        return unavailable('Der myGEKKO ist über die Cloud gerade nicht erreichbar.');
      case 'timeout':
      case 'network':
        // Not repeated: the command may have arrived. The status poll finds out what state the controller is in.
        this.poller.kick();
        return unavailable('Der myGEKKO ist gerade nicht erreichbar.');
      case 'aborted':
        return unavailable('Der Befehl wurde abgebrochen.');
      default:
        return new HttpError(502, 'device_error', `Der myGEKKO hat den Befehl abgelehnt${err.status ? ` (HTTP ${err.status})` : ''}.`);
    }
  }
}
