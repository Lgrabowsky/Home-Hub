import type { MediaConfig, StreamQuality } from '@home-hub/shared';
import { ApiError, get, post, wsBaseUrl } from './api.ts';

/**
 * Live video and intercom audio.
 *
 * The hub relays a WebSocket to its private video service (go2rtc). Over that
 * socket the player negotiates WebRTC (lowest latency, media flows directly
 * and encrypted between browser and hub) and, at the same time, starts
 * fragmented MP4 over the socket itself (MSE). MSE usually shows a picture
 * first and works through any HTTPS path; as soon as WebRTC is connected the
 * player switches to it. If WebRTC cannot connect (e.g. the media port is not
 * reachable from the current network) the stream simply stays on MSE.
 *
 * The logic follows go2rtc's reference player (www/video-rtc.js).
 */

export type LivePhase = 'idle' | 'connecting' | 'playing' | 'failed';

export interface LiveStatus {
  phase: LivePhase;
  mode: 'webrtc' | 'mse' | null;
  /** German text for the user when something is wrong. */
  message: string | null;
  /** The quality actually in use (falls back from main to sub when the device's format cannot be played). */
  quality: StreamQuality;
  /** The stream carries sound. */
  hasAudio: boolean;
}

const MSE_CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
const START_TIMEOUT_MS = 15_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000];

type MediaSourceCtor = typeof MediaSource;

function mediaSourceCtor(): { ctor: MediaSourceCtor; managed: boolean } | null {
  const managed = (window as unknown as { ManagedMediaSource?: MediaSourceCtor }).ManagedMediaSource;
  if (managed) return { ctor: managed, managed: true };
  if ('MediaSource' in window) return { ctor: MediaSource, managed: false };
  return null;
}

let configCache: { at: number; value: Promise<MediaConfig> } | null = null;

function mediaConfig(): Promise<MediaConfig> {
  if (!configCache || Date.now() - configCache.at > 30_000) {
    const value = get<MediaConfig>('/api/media/config');
    configCache = { at: Date.now(), value };
    value.catch(() => {
      configCache = null;
    });
  }
  return configCache.value;
}

async function openMediaSocket(entityId: string, quality: StreamQuality | 'talk'): Promise<WebSocket> {
  const { ticket } = await post<{ ticket: string }>('/api/auth/ticket', { scope: 'media' }, { timeoutMs: 8000 });
  const socket = new WebSocket(
    `${wsBaseUrl()}/api/media/ws?entity=${encodeURIComponent(entityId)}&q=${quality}&ticket=${encodeURIComponent(ticket)}`,
  );
  socket.binaryType = 'arraybuffer';
  return socket;
}

interface SocketMessage {
  type: string;
  value?: string;
}

export interface LiveOptions {
  entityId: string;
  quality: StreamQuality;
  onStatus(status: LiveStatus): void;
}

export class LiveStream {
  private socket: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private quality: StreamQuality;
  private status: LiveStatus;
  private mseCodecs = '';
  private mseFailed = false;
  private rtcFailed = false;
  private usingRtc = false;
  private objectUrl: string | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: LiveOptions,
  ) {
    this.quality = options.quality;
    this.status = { phase: 'idle', mode: null, message: null, quality: this.quality, hasAudio: false };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.quality = this.options.quality;
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.teardown();
    this.update({ phase: 'idle', mode: null, message: null });
  }

  /** Streams are paused while the page is hidden: no bandwidth and no camera sessions are wasted. */
  private readonly onVisibility = (): void => {
    if (this.stopped) return;
    if (document.visibilityState === 'hidden') {
      this.teardown();
      this.update({ phase: 'connecting', mode: null, message: null });
    } else if (!this.socket && !this.pc) {
      this.attempt = 0;
      void this.connect();
    }
  };

  private update(partial: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...partial, quality: this.quality };
    this.options.onStatus(this.status);
  }

  private teardown(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.retryTimer = null;
    this.startTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    const pc = this.pc;
    this.pc = null;
    pc?.close();
    this.usingRtc = false;
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    try {
      this.video.load();
    } catch {
      /* the element may already be detached */
    }
  }

  private retry(message: string | null): void {
    if (this.stopped) return;
    this.teardown();
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
    this.attempt++;
    // Stay quiet for the first attempts: short hiccups should not alarm anyone.
    this.update({ phase: this.attempt > 2 ? 'failed' : 'connecting', mode: null, message: this.attempt > 2 ? message : null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped || document.visibilityState === 'hidden') return;
    const generation = ++this.generation;
    this.mseCodecs = '';
    this.mseFailed = false;
    this.rtcFailed = false;
    this.usingRtc = false;
    this.update({ phase: 'connecting', mode: null, message: null, hasAudio: false });

    let config: MediaConfig;
    let socket: WebSocket;
    try {
      config = await mediaConfig();
      if (generation !== this.generation) return;
      if (!config.available) {
        this.retry('Der Video-Dienst des Hubs läuft gerade nicht.');
        return;
      }
      socket = await openMediaSocket(this.options.entityId, this.quality);
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof ApiError && err.status === 403) {
        this.teardown();
        this.update({ phase: 'failed', message: 'Für diesen Stream fehlt dir die Berechtigung.' });
        return;
      }
      this.retry('Der Hub ist gerade nicht erreichbar.');
      return;
    }
    if (generation !== this.generation) {
      socket.close();
      return;
    }
    this.socket = socket;

    let onBinary: ((data: ArrayBuffer) => void) | null = null;
    let onMse: ((codecs: string) => void) | null = null;

    this.startTimer = setTimeout(() => {
      if (generation === this.generation && this.status.phase !== 'playing') this.retry('Kein Bild von diesem Gerät.');
    }, START_TIMEOUT_MS);

    socket.onopen = () => {
      if (generation !== this.generation) return;
      const mse = this.startMse(socket, generation);
      onBinary = mse?.onBinary ?? null;
      onMse = mse?.onCodecs ?? null;
      if (!mse) this.mseFailed = true;
      if ('RTCPeerConnection' in window) this.startRtc(socket, config, generation);
      else this.rtcFailed = true;
      if (this.mseFailed && this.rtcFailed) this.retry('Dieser Browser kann keine Live-Videos abspielen.');
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      if (typeof event.data !== 'string') {
        onBinary?.(event.data as ArrayBuffer);
        return;
      }
      let message: SocketMessage;
      try {
        message = JSON.parse(event.data) as SocketMessage;
      } catch {
        return;
      }
      const value = message.value ?? '';
      switch (message.type) {
        case 'mse':
          onMse?.(value);
          break;
        case 'webrtc/answer':
          this.pc?.setRemoteDescription({ type: 'answer', sdp: value }).catch(() => {
            this.rtcFailed = true;
          });
          break;
        case 'webrtc/candidate':
          if (value) this.pc?.addIceCandidate({ candidate: value, sdpMid: '0' }).catch(() => {});
          break;
        case 'error':
          this.onServerError(value);
          break;
      }
    };

    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = null;
      // After the switch to WebRTC the socket is no longer needed (we close it ourselves).
      if (this.usingRtc) return;
      if (event.code === 4403) {
        this.teardown();
        this.update({ phase: 'failed', message: this.status.message ?? 'Dieser Stream ist nicht verfügbar.' });
        return;
      }
      this.retry(this.status.message ?? 'Die Verbindung zum Video wurde unterbrochen.');
    };
  }

  private onServerError(text: string): void {
    // go2rtc prefixes its errors with the request they belong to ("mse: …", "webrtc/offer: …");
    // everything else is a ready-to-show German message from the hub itself.
    if (text.startsWith('mse')) this.mseFailed = true;
    else if (text.startsWith('webrtc')) {
      this.rtcFailed = true;
      this.pc?.close();
      this.pc = null;
    } else {
      this.status = { ...this.status, message: text };
      return;
    }
    if (!(this.mseFailed && this.rtcFailed)) return;
    if (this.quality === 'main') {
      // Typically an H.265 main stream the browser cannot decode: the sub stream is always H.264.
      this.quality = 'sub';
      this.teardown();
      void this.connect();
    } else {
      this.retry('Das Videoformat dieses Geräts kann hier nicht abgespielt werden.');
    }
  }

  private markPlaying(mode: 'webrtc' | 'mse', hasAudio: boolean): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.attempt = 0;
    this.update({ phase: 'playing', mode, message: null, hasAudio });
  }

  private play(): void {
    this.video.play().catch(() => {
      // Autoplay with sound is blocked until the user interacts: start muted instead.
      if (!this.video.muted) {
        this.video.muted = true;
        this.video.play().catch(() => {});
      }
    });
  }

  // --- MSE ------------------------------------------------------------------------------

  private startMse(socket: WebSocket, generation: number): { onBinary(data: ArrayBuffer): void; onCodecs(codecs: string): void } | null {
    const source = mediaSourceCtor();
    if (!source) return null;
    const supported = MSE_CODECS.filter((codec) => source.ctor.isTypeSupported(`video/mp4; codecs="${codec}"`)).join();
    const ms = new source.ctor();

    ms.addEventListener(
      'sourceopen',
      () => {
        if (generation !== this.generation) return;
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'mse', value: supported }));
      },
      { once: true },
    );

    if (source.managed) {
      (this.video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
      this.video.srcObject = ms as unknown as MediaProvider;
    } else {
      this.objectUrl = URL.createObjectURL(ms);
      this.video.src = this.objectUrl;
    }
    this.play();

    let buffer: SourceBuffer | null = null;
    const pending = new Uint8Array(2 * 1024 * 1024);
    let pendingLength = 0;
    let announced = false;

    const onCodecs = (codecs: string) => {
      if (generation !== this.generation || buffer) return;
      this.mseCodecs = codecs;
      try {
        buffer = ms.addSourceBuffer(codecs);
      } catch {
        this.mseFailed = true;
        return;
      }
      buffer.mode = 'segments';
      buffer.addEventListener('updateend', () => {
        const sb = buffer;
        if (!sb || generation !== this.generation || this.usingRtc) return;
        if (!sb.updating && pendingLength > 0) {
          try {
            sb.appendBuffer(pending.slice(0, pendingLength));
            pendingLength = 0;
          } catch {
            /* quota or state error: the next chunk tries again */
          }
        }
        if (sb.updating || !sb.buffered.length) return;
        // Keep ~5 s buffered and stay at the live edge.
        const end = sb.buffered.end(sb.buffered.length - 1);
        const start = end - 5;
        const first = sb.buffered.start(0);
        if (start > first) {
          try {
            sb.remove(first, start);
            ms.setLiveSeekableRange(start, end);
          } catch {
            /* not critical */
          }
        }
        if (this.video.currentTime < start) this.video.currentTime = start;
        const gap = end - this.video.currentTime;
        this.video.playbackRate = gap > 0.1 ? Math.min(gap, 4) : 0.1;
        if (!announced && this.video.readyState >= 2) {
          announced = true;
          this.markPlaying('mse', /mp4a|flac|opus/.test(codecs));
        }
      });
    };

    const onBinary = (data: ArrayBuffer) => {
      const sb = buffer;
      if (!sb || this.usingRtc) return;
      if (sb.updating || pendingLength > 0) {
        const bytes = new Uint8Array(data);
        if (pendingLength + bytes.byteLength > pending.byteLength) {
          pendingLength = 0; // hopelessly behind: drop and resync with the next key frame
          return;
        }
        pending.set(bytes, pendingLength);
        pendingLength += bytes.byteLength;
      } else {
        try {
          sb.appendBuffer(data);
        } catch {
          /* see above */
        }
      }
    };

    return { onBinary, onCodecs };
  }

  // --- WebRTC ---------------------------------------------------------------------------

  private startRtc(socket: WebSocket, config: MediaConfig, generation: number): void {
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: config.iceServers });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.onicecandidate = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'webrtc/candidate', value: event.candidate ? event.candidate.candidate : '' }));
    };

    pc.onconnectionstatechange = () => {
      if (generation !== this.generation || this.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        const tracks = pc
          .getTransceivers()
          .filter((transceiver) => transceiver.currentDirection === 'recvonly')
          .map((transceiver) => transceiver.receiver.track);
        if (tracks.length === 0) return;
        // Probe in a detached element first, so the visible player keeps showing MSE until WebRTC really delivers frames.
        const probe = document.createElement('video');
        probe.muted = true;
        probe.addEventListener('loadeddata', () => this.adoptRtc(pc, new MediaStream(tracks), probe, generation), { once: true });
        probe.srcObject = new MediaStream(tracks);
        void probe.play().catch(() => {});
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (this.usingRtc) {
          this.retry('Die Verbindung zum Video wurde unterbrochen.');
        } else {
          // WebRTC did not make it (media port unreachable from here): MSE carries on.
          this.rtcFailed = true;
          pc.close();
          this.pc = null;
          if (this.mseFailed) this.retry('Keine Verbindung zum Video möglich.');
        }
      }
    };

    void pc
      .createOffer()
      .then((offer) => pc.setLocalDescription(offer).then(() => offer))
      .then((offer) => {
        if (generation === this.generation && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp ?? '' }));
        }
      })
      .catch(() => {
        this.rtcFailed = true;
      });
  }

  private adoptRtc(pc: RTCPeerConnection, stream: MediaStream, probe: HTMLVideoElement, generation: number): void {
    probe.srcObject = null;
    if (generation !== this.generation || this.pc !== pc) return;
    const hasVideo = stream.getVideoTracks().length > 0;
    const hasAudio = stream.getAudioTracks().length > 0;
    // Same ranking as go2rtc's player: video+audio > video only; MSE wins only if it has something WebRTC lacks.
    let rtcScore = 0;
    let mseScore = 0;
    if (hasVideo) rtcScore += pc.remoteDescription?.sdp.includes('H265/90000') ? 0x240 : 0x220;
    if (hasAudio) rtcScore += 0x102;
    if (this.mseCodecs.includes('hvc1.')) mseScore += 0x230;
    if (this.mseCodecs.includes('avc1.')) mseScore += 0x210;
    if (/mp4a\.|flac|opus/.test(this.mseCodecs)) mseScore += 0x101;

    if (rtcScore < mseScore) {
      pc.close();
      this.pc = null;
      this.rtcFailed = true;
      return;
    }
    this.usingRtc = true;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.video.removeAttribute('src');
    this.video.playbackRate = 1;
    this.video.srcObject = stream;
    this.play();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.markPlaying('webrtc', hasAudio);
  }
}

// --- Talking (microphone → device speaker) ---------------------------------------------

export type TalkState = 'idle' | 'connecting' | 'live';

export class TalkError extends Error {}

/**
 * One-way audio from this device's microphone to a camera or door station.
 * Uses the dedicated talk stream of the device, which only exists for the
 * moment someone speaks (a permanently open talk channel would block the
 * device's own speaker / doorbell on some models).
 */
export class TalkSession {
  private pc: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private stopped = false;

  constructor(
    private readonly entityId: string,
    private readonly onState: (state: TalkState) => void,
  ) {}

  /** Resolves once the audio path is established. Rejects with a `TalkError` (German message). */
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !('RTCPeerConnection' in window)) {
      throw new TalkError('Gegensprechen funktioniert nur über eine sichere Verbindung (https).');
    }
    this.onState('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.stop();
      const name = err instanceof DOMException ? err.name : '';
      throw new TalkError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Der Zugriff auf das Mikrofon wurde nicht erlaubt.'
          : name === 'NotFoundError'
            ? 'Es wurde kein Mikrofon gefunden.'
            : 'Das Mikrofon kann nicht verwendet werden.',
      );
    }
    if (this.stopped) {
      this.stop();
      return;
    }

    let config: MediaConfig;
    let socket: WebSocket;
    try {
      config = await mediaConfig();
      socket = await openMediaSocket(this.entityId, 'talk');
    } catch (err) {
      this.stop();
      throw new TalkError(err instanceof ApiError && err.status === 403 ? 'Dafür fehlt dir die Berechtigung.' : 'Der Hub ist gerade nicht erreichbar.');
    }
    this.socket = socket;

    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: config.iceServers });
    this.pc = pc;
    for (const track of this.stream.getAudioTracks()) pc.addTransceiver(track, { direction: 'sendonly' });

    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        this.stop();
        reject(new TalkError(message));
      };
      const timer = setTimeout(() => fail('Die Sprechverbindung kam nicht zustande.'), 12_000);

      pc.onicecandidate = (event) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'webrtc/candidate', value: event.candidate ? event.candidate.candidate : '' }));
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          clearTimeout(timer);
          // Signalling is done; the audio flows over the peer connection.
          socket.close();
          this.socket = null;
          this.onState('live');
          resolve();
        } else if (pc.connectionState === 'failed') {
          clearTimeout(timer);
          fail('Die Sprechverbindung kam nicht zustande. Ist der Medien-Port des Hubs von hier erreichbar?');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
          if (!this.stopped) this.stop();
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: SocketMessage;
        try {
          message = JSON.parse(event.data) as SocketMessage;
        } catch {
          return;
        }
        const value = message.value ?? '';
        if (message.type === 'webrtc/answer') {
          pc.setRemoteDescription({ type: 'answer', sdp: value }).catch(() => fail('Die Sprechverbindung kam nicht zustande.'));
        } else if (message.type === 'webrtc/candidate') {
          if (value) pc.addIceCandidate({ candidate: value, sdpMid: '0' }).catch(() => {});
        } else if (message.type === 'error') {
          clearTimeout(timer);
          // The device offers no talk channel (or it is busy).
          fail(
            value.startsWith('webrtc')
              ? 'Dieses Gerät nimmt gerade keine Sprache an (kein Rückkanal verfügbar oder bereits belegt).'
              : value || 'Die Sprechverbindung kam nicht zustande.',
          );
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        fail('Der Hub ist gerade nicht erreichbar.');
      };
      socket.onopen = () => {
        void pc
          .createOffer()
          .then((offer) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer) => socket.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp ?? '' })))
          .catch(() => fail('Die Sprechverbindung kam nicht zustande.'));
      };
    });
  }

  stop(): void {
    this.stopped = true;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    this.onState('idle');
  }
}
