import { createHash } from 'node:crypto';
import type { MyGekkoSettings } from '@home-hub/shared';

/**
 * Memory of rejected logins.
 *
 * The controller answers wrong credentials with 403 and locks the account for
 * ten minutes after repeated attempts; every failed call also raises an alarm
 * pop-up on its display. So a login that was just rejected must not be tried
 * again — not by the poll loop, not by a restarted integration (the admin
 * saved the settings once more) and not by the "test connection" button.
 *
 * The memory lives in the process and is shared by all of them; the running
 * integration additionally persists its own block so that a restart loop of
 * the hub cannot hammer the controller either.
 */

type Credentials = Pick<MyGekkoSettings, 'mode' | 'host' | 'username' | 'password' | 'gekkoId'>;

interface Rejection {
  at: number;
  credentials: string;
}

/** With corrected credentials one more attempt is allowed; after that the account rests. */
const MAX_REJECTIONS_PER_WINDOW = 2;

const rejections = new Map<string, Rejection[]>();

function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function address(settings: Credentials): string {
  return settings.mode === 'cloud' ? settings.gekkoId.trim().toLowerCase() : settings.host.trim().toLowerCase();
}

/** Identifies the controller (not the login) — what stored knowledge about its elements belongs to. */
export function controllerKey(settings: Credentials): string {
  return digest(['controller', settings.mode, address(settings)]);
}

/** Identifies the account on the controller. */
export function accountKey(settings: Credentials): string {
  return digest(['account', settings.mode, address(settings), settings.username]);
}

/** Identifies one exact set of credentials, without revealing them. */
export function credentialsKey(settings: Credentials): string {
  return digest(['credentials', settings.mode, address(settings), settings.username, settings.password]);
}

function recent(settings: Credentials, now: number, windowMs: number): Rejection[] {
  const key = accountKey(settings);
  const list = (rejections.get(key) ?? [])
    // A rejection "from the future" means the system clock was set back: it counts as fresh (the safe side)
    // instead of being kept for as long as the clock jumped.
    .map((rejection) => (rejection.at > now ? { ...rejection, at: now } : rejection))
    .filter((rejection) => now - rejection.at < windowMs);
  if (list.length > 0) rejections.set(key, list);
  else rejections.delete(key);
  return list;
}

export function noteRejection(settings: Credentials, now: number): void {
  const key = accountKey(settings);
  const list = rejections.get(key) ?? [];
  list.push({ at: now, credentials: credentialsKey(settings) });
  rejections.set(key, list.slice(-8));
}

/** Timestamp until which these credentials must not be sent to the controller; null when a login may be tried. */
export function loginBlockedUntil(settings: Credentials, now: number, windowMs: number): number | null {
  const list = recent(settings, now, windowMs);
  const credentials = credentialsKey(settings);
  const same = list.filter((rejection) => rejection.credentials === credentials);
  const last = same[same.length - 1];
  if (last) return last.at + windowMs;
  if (list.length >= MAX_REJECTIONS_PER_WINDOW) {
    // The next attempt is due when the oldest of the last N rejections leaves the window.
    return list[list.length - MAX_REJECTIONS_PER_WINDOW]!.at + windowMs;
  }
  return null;
}

/** True when exactly these credentials were rejected within the window (and not just other attempts on the same account). */
export function wereRejected(settings: Credentials, now: number, windowMs: number): boolean {
  const credentials = credentialsKey(settings);
  return recent(settings, now, windowMs).some((rejection) => rejection.credentials === credentials);
}

/** For tests: start with a clean memory. */
export function forgetRejections(): void {
  rejections.clear();
}
