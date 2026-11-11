/** German formatting helpers. */

const NUMBER = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const TIME = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const SHORT_DATE = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatNumber(value: number, digits = 1): string {
  return digits === 1 ? NUMBER.format(value) : new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(value);
}

export function formatTemperature(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} °C`;
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${Math.round(value)} %`;
}

export function formatTime(ts: number): string {
  return TIME.format(ts);
}

export function formatDateTime(ts: number): string {
  return DATE_TIME.format(ts);
}

export function formatDate(ts: number): string {
  return SHORT_DATE.format(ts);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Heute", "Gestern" or "Montag, 3. November" — for grouping lists by day. */
export function formatDay(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return 'Heute';
  if (days === 1) return 'Gestern';
  return DAY.format(ts);
}

/** "gerade eben", "vor 5 Min.", "vor 2 Std.", "gestern, 14:32", "03.11.2026". */
export function formatAgo(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return 'gerade eben';
  if (seconds < 3600) return `vor ${Math.max(1, Math.round(seconds / 60))} Min.`;
  if (seconds < 6 * 3600) return `vor ${Math.round(seconds / 3600)} Std.`;
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return `heute, ${formatTime(ts)}`;
  if (days === 1) return `gestern, ${formatTime(ts)}`;
  return formatDate(ts);
}

/** Seconds → "3:07" / "1:02:45". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '–:––';
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** "Guten Morgen" etc., by time of day. */
export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Gute Nacht';
  if (hour < 11) return 'Guten Morgen';
  if (hour < 18) return 'Guten Tag';
  return 'Guten Abend';
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
