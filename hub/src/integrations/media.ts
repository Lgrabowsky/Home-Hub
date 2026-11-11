import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import type { MediaConfig } from '@home-hub/shared';
import type { HubConfig } from '../config.ts';
import type { Logger } from '../log.ts';
import type { StateStore } from '../state.ts';
import { DeviceHttp, describeError } from '../util/http.ts';

/**
 * Live video and intercom audio are handled by go2rtc (https://go2rtc.org),
 * which the hub runs as a private child process:
 *
 * - its control API is only reachable through a Unix socket inside a 0700
 *   directory — no TCP port, nothing a browser or another host could reach;
 * - camera URLs (which contain credentials) are handed over as environment
 *   variables, so they never touch the disk;
 * - the only thing it exposes to the network is the WebRTC media port. Media
 *   on that port is DTLS-SRTP encrypted and a session can only be set up
 *   through the hub's authenticated signalling proxy.
 */

export interface StreamSpec {
  /** go2rtc stream name, see `streamName()`. */
  name: string;
  /** go2rtc sources; may contain credentials. */
  sources: string[];
}

const NAME_PATTERN = /^[a-z0-9_-]{1,80}$/;

export type StreamQualityName = 'main' | 'sub' | 'talk';

/**
 * Name of the go2rtc stream for a device. Device ids never contain an
 * underscore, so the name can be split unambiguously again.
 *   cam_<id>_main | cam_<id>_sub | cam_<id>_talk
 *   door_<id>_main | door_<id>_talk
 */
export function streamName(kind: 'cam' | 'door', deviceId: string, quality: StreamQualityName): string {
  return `${kind}_${deviceId}_${quality}`;
}
const HEALTH_INTERVAL_MS = 15_000;

/**
 * The environment go2rtc (and the ffmpeg it starts) gets: as little as possible, so that the hub's
 * own secrets (master key …) never reach a child process.
 */
function childBaseEnv(runDir: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: runDir, TMPDIR: runDir };
  if (process.platform === 'win32') {
    // Without these, Windows programs cannot even open a network socket.
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    env.TEMP = runDir;
    env.TMP = runDir;
  }
  return env;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export class MediaManager {
  private readonly runDir: string;
  readonly socketPath: string;
  private readonly configPath: string;
  private api: DeviceHttp;
  /** Only with `apiTransport: 'tcp'`: credentials (new for every hub start) and the current port. */
  private readonly apiAuth: { username: string; password: string } | null;
  private apiPort = 0;
  private child: ChildProcess | null = null;
  private specs: StreamSpec[] = [];
  private fingerprint = '';
  private started = false;
  private stopping = false;
  private ready = false;
  private version: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartDelay = 1000;
  private healthFailures = 0;
  private lastError: string | null = null;
  private binaryMissing = false;
  /** Sessions that negotiated a WebRTC connection with the current go2rtc process. */
  private readonly rtcSessions = new Set<string>();
  /** Re-checks of the open stream relays (see `recheckRelays`). */
  private readonly relays = new Set<() => void>();
  /** The process that is about to exit because the hub asked it to (new configuration, ended session). */
  private expectedExit: ChildProcess | null = null;

  constructor(
    private readonly config: HubConfig,
    private readonly state: StateStore,
    private readonly log: Logger,
  ) {
    // Unix socket paths are limited to ~100 bytes, so use a short private directory.
    this.runDir = mkdtempSync(join(tmpdir(), 'hh-'));
    chmodSync(this.runDir, 0o700);
    this.socketPath = join(this.runDir, 'g.sock');
    this.configPath = join(this.runDir, 'go2rtc.yaml');
    this.apiAuth = config.media.apiTransport === 'tcp' ? { username: 'hub', password: randomBytes(24).toString('base64url') } : null;
    this.api = this.apiClient();
  }

  private apiClient(): DeviceHttp {
    if (!this.apiAuth) return new DeviceHttp({ socketPath: this.socketPath, timeoutMs: 8000 });
    return new DeviceHttp({ baseUrl: `http://127.0.0.1:${this.apiPort}`, auth: this.apiAuth, authMode: 'basic', timeoutMs: 8000 });
  }

  get available(): boolean {
    return this.ready;
  }

  /** Remembers that a session set up WebRTC media (see `endSession`). */
  noteRtcSession(sessionId: string): void {
    this.rtcSessions.add(sessionId);
  }

  /**
   * Called when a session is revoked or expires.
   *
   * WebRTC media flows directly between the app and go2rtc and survives the
   * signalling socket, and go2rtc has no way to end a single viewer. A viewer
   * whose session ended must not keep watching, so the video service is
   * restarted — everyone else's player reconnects within a moment.
   */
  endSession(sessionId: string): void {
    if (!this.rtcSessions.has(sessionId)) return;
    this.rtcSessions.clear();
    if (this.child) {
      this.log.info('a session with live video ended: restarting the video service to cut its streams');
      this.killChild();
    }
  }

  /** A stream relay registers how it re-checks its viewer; returns the function that unregisters it. */
  registerRelay(check: () => void): () => void {
    this.relays.add(check);
    return () => this.relays.delete(check);
  }

  /**
   * Called when users or their permissions change: open relays close at once
   * if their viewer may no longer watch. WebRTC media flows outside the relay,
   * so the user's sessions are also ended for the video service.
   */
  revokeUser(sessionIds: string[]): void {
    for (const check of [...this.relays]) check();
    for (const sessionId of sessionIds) this.endSession(sessionId);
  }

  hasStream(name: string): boolean {
    return this.specs.some((spec) => spec.name === name);
  }

  clientConfig(): MediaConfig {
    return { iceServers: this.config.media.iceServers, available: this.ready };
  }

  start(): void {
    this.started = true;
    this.stopping = false;
    this.apply();
  }

  /** Declares the complete set of streams. go2rtc is (re)started when it changed. */
  setStreams(specs: StreamSpec[]): void {
    for (const spec of specs) {
      if (!NAME_PATTERN.test(spec.name)) throw new Error(`Invalid stream name: ${spec.name}`);
    }
    this.specs = specs.map((spec) => ({ name: spec.name, sources: [...spec.sources] }));
    if (this.started) this.apply();
  }

  private apply(): void {
    if (!this.config.media.enabled) {
      this.state.setService('media', 'unconfigured', 'Video-Dienst ist deaktiviert (HUB_MEDIA=0).');
      return;
    }
    const fingerprint = JSON.stringify(this.specs);
    if (this.specs.length === 0) {
      this.fingerprint = fingerprint;
      this.killChild();
      this.state.setService('media', 'unconfigured');
      return;
    }
    if (fingerprint === this.fingerprint && this.child) return;
    this.fingerprint = fingerprint;
    this.restartDelay = 1000;
    this.binaryMissing = false;
    if (this.child) {
      // The exit handler starts the new process with the new configuration.
      this.killChild();
    } else {
      this.spawnChild();
    }
  }

  private buildConfig(): { yaml: string; env: Record<string, string> } {
    const { media } = this.config;
    const env: Record<string, string> = {};
    const lines: string[] = [
      '# Generated by Home Hub — do not edit. Stream sources are passed via environment variables.',
      'api:',
      ...(this.apiAuth
        ? [
            // Loopback only, and credentials for every request — also from this machine (`local_auth`),
            // because other programs on the same computer must not be able to reach the cameras.
            `  listen: ${yamlString(`127.0.0.1:${this.apiPort}`)}`,
            `  username: ${yamlString(this.apiAuth.username)}`,
            // Passed through the environment like the stream sources: no secret in the file.
            '  password: "${HH_API_PASSWORD}"',
            '  local_auth: true',
          ]
        : ['  listen: ""', `  unix_listen: ${yamlString(this.socketPath)}`]),
      'rtsp:',
      `  listen: ${yamlString(`127.0.0.1:${media.rtspPort}`)}`,
      'srtp:',
      '  listen: ""',
      'webrtc:',
      `  listen: ${yamlString(`:${media.webrtcPort}`)}`,
    ];
    if (media.candidates.length > 0) {
      lines.push('  candidates:');
      for (const candidate of media.candidates) lines.push(`    - ${yamlString(candidate)}`);
    }
    if (media.iceServers.length === 0) {
      lines.push('  ice_servers: []');
    } else {
      lines.push('  ice_servers:');
      for (const server of media.iceServers) {
        lines.push(`    - urls: [${server.urls.map(yamlString).join(', ')}]`);
        if (server.username) lines.push(`      username: ${yamlString(server.username)}`);
        if (server.credential) lines.push(`      credential: ${yamlString(server.credential)}`);
      }
    }
    lines.push('ffmpeg:', `  bin: ${yamlString(media.ffmpegBin)}`, 'log:', '  format: "json"', '  level: "info"', 'streams:');
    let index = 0;
    for (const spec of this.specs) {
      lines.push(`  ${spec.name}:`);
      for (const source of spec.sources) {
        const variable = `HH_SRC_${index++}`;
        // go2rtc substitutes ${VAR} textually before parsing the YAML, so the value
        // must already be escaped for a double-quoted YAML scalar.
        env[variable] = JSON.stringify(source).slice(1, -1);
        lines.push(`    - "\${${variable}}"`);
      }
    }
    return { yaml: lines.join('\n') + '\n', env };
  }

  private spawnChild(): void {
    if (this.stopping || this.child || this.specs.length === 0) return;
    if (this.apiAuth) {
      // A fresh port for every start: if one is taken, the next attempt simply uses another.
      this.apiPort = randomInt(30_000, 50_000);
      this.api.destroy();
      this.api = this.apiClient();
    }
    const { yaml, env } = this.buildConfig();
    if (this.apiAuth) env.HH_API_PASSWORD = this.apiAuth.password;
    try {
      writeFileSync(this.configPath, yaml, { mode: 0o600 });
    } catch (err) {
      this.fail(`Konfiguration konnte nicht geschrieben werden: ${describeError(err)}`);
      return;
    }

    this.ready = false;
    this.rtcSessions.clear();
    this.state.setService('media', 'starting');
    const child = spawn(this.config.media.go2rtcBin, ['-c', this.configPath], {
      cwd: this.runDir,
      // A clean environment: the hub's own secrets (master key …) must not leak into the child.
      env: { ...childBaseEnv(this.runDir), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const relay = (line: string) => {
      if (!line.trim()) return;
      let level = 'info';
      let message = line;
      try {
        const parsed = JSON.parse(line) as { level?: string; message?: string; error?: string };
        level = parsed.level ?? 'info';
        message = [parsed.message, parsed.error].filter(Boolean).join(': ') || line;
      } catch {
        /* plain text line */
      }
      if (level === 'error' || level === 'fatal' || level === 'panic') this.log.warn({ src: 'go2rtc' }, message);
      else if (level === 'warn') this.log.info({ src: 'go2rtc' }, message);
      else this.log.debug({ src: 'go2rtc' }, message);
    };
    createInterface({ input: child.stdout! }).on('line', relay);
    createInterface({ input: child.stderr! }).on('line', relay);

    child.once('error', (err) => {
      if (this.child === child) this.child = null;
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      this.binaryMissing = missing;
      this.fail(
        missing
          ? `go2rtc wurde nicht gefunden („${this.config.media.go2rtcBin}“). Live-Video ist nicht verfügbar.`
          : `go2rtc konnte nicht gestartet werden: ${describeError(err)}`,
      );
      this.scheduleRestart(missing ? 5 * 60_000 : undefined);
    });

    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.stopHealth();
      if (this.stopping) return;
      if (this.specs.length === 0) {
        this.state.setService('media', 'unconfigured');
        return;
      }
      // go2rtc catches SIGTERM and exits with code 0, so the signal alone does not tell whether we asked for it.
      if (this.expectedExit === child || signal === 'SIGTERM' || signal === 'SIGKILL') {
        this.expectedExit = null;
        this.spawnChild();
        return;
      }
      this.fail(`go2rtc wurde unerwartet beendet (Code ${code ?? signal}). Neustart läuft.`);
      this.scheduleRestart();
    });

    void this.waitUntilReady(child);
  }

  private async waitUntilReady(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (this.child === child && Date.now() < deadline) {
      try {
        const info = await this.api.json<{ version?: string }>('/api', { timeoutMs: 1500 });
        if (this.child !== child) return;
        this.version = info.version ?? null;
        this.ready = true;
        this.restartDelay = 1000;
        this.healthFailures = 0;
        this.lastError = null;
        this.state.setService('media', 'ok');
        this.log.info({ version: this.version, streams: this.specs.length }, 'go2rtc ready');
        this.startHealth();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (this.child === child) {
      this.fail('go2rtc antwortet nicht. Neustart läuft.');
      this.killChild();
    }
  }

  private startHealth(): void {
    this.stopHealth();
    this.healthTimer = setInterval(() => {
      void this.api.json('/api', { timeoutMs: 4000 }).then(
        () => {
          this.healthFailures = 0;
          this.state.setService('media', 'ok');
        },
        () => {
          if (++this.healthFailures >= 3) {
            this.fail('go2rtc reagiert nicht mehr. Neustart läuft.');
            this.killChild();
          }
        },
      );
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private fail(message: string): void {
    this.ready = false;
    this.lastError = message;
    this.state.setService('media', 'offline', message);
    this.log.warn(message);
  }

  private scheduleRestart(delay?: number): void {
    if (this.stopping || this.restartTimer) return;
    const wait = delay ?? this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, wait);
    this.restartTimer.unref();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) return;
    this.expectedExit = child;
    this.stopHealth();
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopHealth();
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    this.child = null;
    this.ready = false;
    this.api.destroy();
    try {
      rmSync(this.runDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Opens the signalling/MSE WebSocket of a stream (hub-internal). */
  openSocket(streamName: string): WebSocket {
    const path = `/api/ws?src=${encodeURIComponent(streamName)}`;
    const options = { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 5000 };
    if (!this.apiAuth) return new WebSocket(`ws+unix://${this.socketPath}:${path}`, options);
    const basic = Buffer.from(`${this.apiAuth.username}:${this.apiAuth.password}`).toString('base64');
    return new WebSocket(`ws://127.0.0.1:${this.apiPort}${path}`, { ...options, headers: { Authorization: `Basic ${basic}` } });
  }

  /** A current JPEG frame of a stream, or null when it cannot be produced. */
  async snapshot(streamName: string): Promise<Buffer | null> {
    if (!this.ready || !this.hasStream(streamName)) return null;
    try {
      const response = await this.api.request(`/api/frame.jpeg?src=${encodeURIComponent(streamName)}`, { timeoutMs: 12_000 });
      if (response.status !== 200 || response.body.length < 100) return null;
      return response.body;
    } catch {
      return null;
    }
  }

  diagnostics(): { running: boolean; version: string | null; streams: number; candidates: string[]; error: string | null; binaryMissing: boolean } {
    return {
      running: this.ready,
      version: this.version,
      streams: this.specs.length,
      candidates: this.config.media.candidates,
      error: this.lastError,
      binaryMissing: this.binaryMissing,
    };
  }
}
