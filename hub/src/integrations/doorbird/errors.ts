import { HttpError } from '../../http/errors.ts';
import { DeviceHttpError } from '../../util/http.ts';

/**
 * Everything that can go wrong when talking to a door station, reduced to the
 * cases the hub reacts to differently, plus the German texts shown to users.
 */

export type DoorBirdErrorKind =
  /** HTTP 401 on the login check: user name / password wrong or "API-Operator" missing — or the hub is still waiting after such a refusal. */
  | 'auth'
  /** HTTP 423: the device has locked the account after repeated failures. */
  | 'locked'
  /** HTTP 401 for one function although the login itself works. */
  | 'denied'
  /** HTTP 204 or RETURNCODE "204": the user lacks the permission for this function ("watch always", "history" …). */
  | 'permission'
  /** HTTP 503. */
  | 'busy'
  /** HTTP 404 (history: no such picture). */
  | 'not_found'
  /** Any other HTTP status. */
  | 'status'
  /** The answer is not what the API documents. */
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'aborted'
  /** The integration is shutting down. */
  | 'stopped';

export class DoorBirdError extends Error {
  /** HTTP status of the device's answer, when there was one. */
  readonly status: number | undefined;
  /**
   * Whether the device may have carried out the request: `no` when it refused
   * or was never reached, `unknown` when the answer got lost on the way.
   * Decides what the user is told after a failed door opening.
   */
  readonly executed: 'no' | 'unknown';
  /** German one-liner from the transport layer (e.g. "Verbindung abgelehnt …"), for connection tests. */
  readonly reason: string | null;

  constructor(
    readonly kind: DoorBirdErrorKind,
    message: string,
    detail: { status?: number; executed?: 'no' | 'unknown'; reason?: string | null; cause?: unknown } = {},
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'DoorBirdError';
    this.status = detail.status;
    this.executed = detail.executed ?? 'no';
    this.reason = detail.reason ?? null;
  }
}

/** Errors with which the connection was certainly never established. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL']);

/** Error codes of a keep-alive connection the device closed while it sat idle. */
const STALE_CONNECTION = new Set(['ECONNRESET', 'EPIPE']);

function causeCode(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' ? code : '';
}

/** True when a request failed because the reused connection was already closed on the device's side. */
export function isStaleConnection(err: unknown): boolean {
  return err instanceof DeviceHttpError && err.kind === 'network' && STALE_CONNECTION.has(causeCode(err));
}

/** Wraps whatever the HTTP client threw. */
export function fromTransport(err: unknown): DoorBirdError {
  if (err instanceof DoorBirdError) return err;
  if (err instanceof DeviceHttpError) {
    switch (err.kind) {
      case 'timeout':
        return new DoorBirdError('timeout', 'no answer in time', { executed: 'unknown', reason: err.message, cause: err });
      case 'aborted':
        return new DoorBirdError('aborted', 'request cancelled', { executed: 'unknown', cause: err });
      case 'network': {
        const code = causeCode(err);
        return new DoorBirdError('network', code ? `network error ${code}` : 'network error', {
          executed: NEVER_CONNECTED.has(code) ? 'no' : 'unknown',
          reason: err.message,
          cause: err,
        });
      }
      default:
        return new DoorBirdError('protocol', `unexpected answer (${err.kind})`, { status: err.status, executed: 'unknown', reason: err.message, cause: err });
    }
  }
  return new DoorBirdError('network', 'unexpected failure', { executed: 'unknown', cause: err });
}

export type DoorAction = 'snapshot' | 'open' | 'light' | 'history' | 'other';

/** The German sentence for a user who just tried `action` on the door station called `door`. */
export function userMessage(error: DoorBirdError, door: string, action: DoorAction): string {
  switch (error.kind) {
    case 'auth':
      return `Die Türstation „${door}“ lehnt die Anmeldung ab. Bitte Benutzername, Passwort und die Berechtigung „API-Operator“ in der DoorBird-App prüfen.`;
    case 'locked':
      return `Die Türstation „${door}“ hat den Zugang nach mehreren Fehlversuchen vorübergehend gesperrt. Bitte später noch einmal versuchen.`;
    case 'denied':
      return `Die Türstation „${door}“ hat die Anfrage abgelehnt. Bitte die Berechtigungen des Benutzers in der DoorBird-App prüfen.`;
    case 'permission':
      switch (action) {
        case 'snapshot':
          return `„${door}“ liefert gerade kein Bild: Dem Benutzer fehlt in der DoorBird-App die Berechtigung „Immer ansehen“.`;
        case 'open':
          return `„${door}“ hat das Öffnen abgelehnt: Dem Benutzer fehlt in der DoorBird-App die Berechtigung dafür („Immer ansehen“ und das Relais).`;
        case 'light':
          return `„${door}“ hat das Licht nicht eingeschaltet: Dem Benutzer fehlt in der DoorBird-App die Berechtigung „Immer ansehen“.`;
        case 'history':
          return `„${door}“ gibt den Verlauf nicht heraus: Dem Benutzer fehlt in der DoorBird-App die Berechtigung „Verlauf“.`;
        default:
          return `Die Türstation „${door}“ hat die Anfrage abgelehnt: Dem Benutzer fehlt in der DoorBird-App die Berechtigung dafür.`;
      }
    case 'busy':
      return `„${door}“ ist gerade beschäftigt. Bitte gleich noch einmal versuchen.`;
    case 'stopped':
    case 'aborted':
      return `Die Verbindung zu „${door}“ wird gerade neu aufgebaut. Bitte gleich noch einmal versuchen.`;
    case 'timeout':
    case 'network':
      if (action === 'open') {
        return error.executed === 'no'
          ? `„${door}“ ist nicht erreichbar – die Tür wurde nicht geöffnet.`
          : `„${door}“ hat nicht geantwortet. Ob die Tür geöffnet wurde, ist unklar – bitte nachsehen.`;
      }
      return `„${door}“ ist gerade nicht erreichbar.`;
    default:
      if (action === 'open' && error.executed === 'unknown') {
        return `„${door}“ hat unerwartet geantwortet. Ob die Tür geöffnet wurde, ist unklar – bitte nachsehen.`;
      }
      return `Die Türstation „${door}“ hat unerwartet geantwortet.`;
  }
}

const HTTP_CODES: Partial<Record<DoorBirdErrorKind, string>> = {
  auth: 'device_auth',
  locked: 'device_locked',
  denied: 'device_permission',
  permission: 'device_permission',
  busy: 'device_busy',
};

/** What the API answers when a request to the door station failed (always 503: the hub itself is fine). */
export function toHttpError(err: unknown, door: string, action: DoorAction): HttpError {
  if (err instanceof HttpError) return err;
  const error = fromTransport(err);
  return new HttpError(503, HTTP_CODES[error.kind] ?? 'unavailable', userMessage(error, door, action));
}
