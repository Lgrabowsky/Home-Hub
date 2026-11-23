import { z } from 'zod';
import { sunCrossings, type EntityCommand, type EntityKind, type HubTimer, type HubTimerInput } from '@home-hub/shared';
import { commandSchema } from '../http/commands.ts';
import { HttpError, notFound } from '../http/errors.ts';
import type { IntegrationManager } from '../integrations/manager.ts';
import type { Logger } from '../log.ts';
import { randomId } from '../security/crypto.ts';
import type { SettingsStore } from '../settings.ts';
import type { StateStore } from '../state.ts';

/**
 * Time switches run by the hub itself: at a time of day or relative to
 * sunrise / sunset, on chosen weekdays, they send commands to devices.
 *
 * The building controller's own clocks only let the Query API switch them
 * off, on or to automatic; their switching times are kept on the controller.
 * These ones can be edited in the app — and they only run while the hub runs.
 *
 * Times are wall-clock times in the house's time zone (general settings), so
 * a 07:00 switch stays at 07:00 across daylight saving changes.
 */

const STORE_KEY = 'timers';
/** The middle of Germany, when no location is configured. */
const FALLBACK_LOCATION = { latitude: 51.16, longitude: 10.45 };
/** A switch that was due while the hub was busy or restarting still fires within this window. */
const CATCH_UP_MS = 10 * 60_000;
const TICK_MS = 20_000;

/** Devices a time switch may operate — never doors, cameras or anything security related. */
const TIMER_KINDS: readonly EntityKind[] = ['light', 'blind', 'switch', 'climate', 'action', 'clock'];

type Stored = Omit<HubTimer, 'nextRunAt'>;

export const timerSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt.').max(60),
  enabled: z.boolean().default(true),
  days: z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  at: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('time'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Bitte eine Uhrzeit wie 07:30 angeben.') }),
    z.object({ kind: z.enum(['sunrise', 'sunset']), offset: z.number().int().min(-240).max(240) }),
  ]),
  actions: z
    .array(z.object({ entityId: z.string().min(1).max(200), command: commandSchema }))
    .min(1, 'Bitte mindestens eine Aktion wählen.')
    .max(20, 'Höchstens 20 Aktionen.'),
});

// --- time zone arithmetic ---------------------------------------------------------------------

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(instant: number, timeZone: string): LocalDate & { hour: number; minute: number; second: number } {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, format);
  }
  const out: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(instant))) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute!, second: out.second! };
}

/** Offset of the time zone from UTC at an instant, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time happens in the time zone (the later one when the clocks go back). */
export function zonedTime(date: LocalDate, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export function localDate(instant: number, timeZone: string): LocalDate {
  const { year, month, day } = parts(instant, timeZone);
  return { year, month, day };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 1 = Monday … 7 = Sunday. */
function weekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

export interface Place {
  timeZone: string;
  latitude: number;
  longitude: number;
  located: boolean;
}

/** Sunrise and sunset on a local date at the place. */
export function sunOn(date: LocalDate, place: Place): { rise: number | null; set: number | null } {
  const start = zonedTime(date, 0, 0, place.timeZone);
  const end = zonedTime(addDays(date, 1), 0, 0, place.timeZone);
  return sunCrossings(start, end, place.latitude, place.longitude);
}

/** When the switch fires on a local date, null when it does not fire that day. */
export function occurrenceOn(timer: Pick<HubTimer, 'days' | 'at'>, date: LocalDate, place: Place): number | null {
  if (!timer.days.includes(weekday(date))) return null;
  if (timer.at.kind === 'time') {
    const [hour, minute] = timer.at.time.split(':').map(Number) as [number, number];
    return zonedTime(date, hour, minute, place.timeZone);
  }
  const sun = sunOn(date, place);
  const base = timer.at.kind === 'sunrise' ? sun.rise : sun.set;
  return base === null ? null : base + timer.at.offset * 60_000;
}

export function nextOccurrence(timer: Pick<HubTimer, 'days' | 'at' | 'enabled'>, after: number, place: Place): number | null {
  if (!timer.enabled || timer.days.length === 0) return null;
  const today = localDate(after, place.timeZone);
  for (let i = -1; i <= 8; i++) {
    const at = occurrenceOn(timer, addDays(today, i), place);
    if (at !== null && at > after) return at;
  }
  return null;
}

// --- the service --------------------------------------------------------------------------------

export class TimerService {
  private timers: Stored[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      settings: SettingsStore;
      integrations: Pick<IntegrationManager, 'entityCommand'>;
      state: StateStore;
      log: Logger;
    },
  ) {
    const stored = deps.settings.getInternal<Stored[]>(STORE_KEY);
    this.timers = Array.isArray(stored) ? stored : [];
  }

  place(): Place {
    const general = this.deps.settings.get('general');
    const located = general.latitude !== null && general.longitude !== null;
    return {
      timeZone: general.timeZone,
      latitude: general.latitude ?? FALLBACK_LOCATION.latitude,
      longitude: general.longitude ?? FALLBACK_LOCATION.longitude,
      located,
    };
  }

  list(now = Date.now()): HubTimer[] {
    const place = this.place();
    return this.timers.map((timer) => ({ ...timer, nextRunAt: nextOccurrence(timer, now, place) }));
  }

  get(id: string): HubTimer {
    const timer = this.list().find((entry) => entry.id === id);
    if (!timer) throw notFound('Diese Zeitschaltuhr gibt es nicht (mehr).');
    return timer;
  }

  private validate(input: unknown): HubTimerInput {
    const parsed = timerSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, 'bad_request', issue?.message ?? 'Ungültige Zeitschaltuhr.');
    }
    const value = parsed.data as HubTimerInput;
    for (const action of value.actions) {
      const entity = this.deps.state.get(action.entityId);
      if (!entity) throw new HttpError(400, 'bad_request', 'Ein gewähltes Gerät gibt es nicht (mehr).');
      if (!TIMER_KINDS.includes(entity.kind)) throw new HttpError(400, 'bad_request', `„${entity.name}“ kann nicht von einer Zeitschaltuhr geschaltet werden.`);
    }
    return value;
  }

  create(input: unknown, by: string | null): HubTimer {
    if (this.timers.length >= 100) throw new HttpError(400, 'bad_request', 'Es gibt schon 100 Zeitschaltuhren.');
    const value = this.validate(input);
    // Counted from now: a new switch does not fire for a time earlier today.
    const timer: Stored = { id: randomId(9), ...value, lastRunAt: Date.now(), lastResult: null, lastOk: null, updatedBy: by };
    this.timers = [...this.timers, timer];
    this.save();
    return this.get(timer.id);
  }

  update(id: string, input: unknown, by: string | null): HubTimer {
    const current = this.timers.find((timer) => timer.id === id);
    if (!current) throw notFound('Diese Zeitschaltuhr gibt es nicht (mehr).');
    const value = this.validate(input);
    // A change of the time must not make the switch fire for a moment that already passed.
    const lastRunAt = current.lastRunAt ?? Date.now();
    this.timers = this.timers.map((timer) => (timer.id === id ? { ...timer, ...value, lastRunAt: Math.max(lastRunAt, Date.now()), updatedBy: by } : timer));
    this.save();
    return this.get(id);
  }

  remove(id: string): Stored {
    const current = this.timers.find((timer) => timer.id === id);
    if (!current) throw notFound('Diese Zeitschaltuhr gibt es nicht (mehr).');
    this.timers = this.timers.filter((timer) => timer.id !== id);
    this.save();
    return current;
  }

  /** Runs the actions now ("Jetzt ausführen"); the schedule is not affected. */
  async runNow(id: string): Promise<HubTimer> {
    const timer = this.timers.find((entry) => entry.id === id);
    if (!timer) throw notFound('Diese Zeitschaltuhr gibt es nicht (mehr).');
    await this.execute(timer, Date.now(), false);
    return this.get(id);
  }

  /** Demo mode: two examples to look at. */
  seedDemo(): void {
    if (this.timers.length > 0) return;
    this.timers = [
      {
        id: 'demo-morgens',
        name: 'Jalousien am Morgen hoch',
        enabled: true,
        days: [1, 2, 3, 4, 5],
        at: { kind: 'time', time: '07:00' },
        actions: [{ entityId: 'gekko:blinds/group0', command: { action: 'up' } }],
        lastRunAt: Date.now(),
        lastResult: null,
        lastOk: null,
        updatedBy: null,
      },
      {
        id: 'demo-abends',
        name: 'Terrassenlicht zum Sonnenuntergang',
        enabled: true,
        days: [1, 2, 3, 4, 5, 6, 7],
        at: { kind: 'sunset', offset: 15 },
        actions: [{ entityId: 'gekko:lights/item12', command: { action: 'turn_on' } }],
        lastRunAt: Date.now(),
        lastResult: null,
        lastOk: null,
        updatedBy: null,
      },
    ];
    this.save();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fires what is due. Exposed for tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const place = this.place();
      const today = localDate(now, place.timeZone);
      for (const timer of [...this.timers]) {
        if (!timer.enabled) continue;
        for (const date of [addDays(today, -1), today]) {
          const at = occurrenceOn(timer, date, place);
          if (at === null || at > now || now - at > CATCH_UP_MS) continue;
          if (timer.lastRunAt !== null && timer.lastRunAt >= at) continue;
          await this.execute(timer, now, true);
          break;
        }
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'time switch check failed');
    } finally {
      this.running = false;
    }
  }

  private async execute(timer: Stored, now: number, scheduled: boolean): Promise<void> {
    const problems: string[] = [];
    for (const action of timer.actions) {
      const entity = this.deps.state.get(action.entityId);
      if (!entity) {
        problems.push('ein Gerät fehlt');
        continue;
      }
      try {
        await this.deps.integrations.entityCommand(action.entityId, action.command as EntityCommand);
      } catch (err) {
        problems.push(`${entity.name}: ${err instanceof Error ? err.message : 'Fehler'}`);
      }
    }
    const result = problems.length === 0 ? 'Ausgeführt' : problems.join(' · ').slice(0, 300);
    this.timers = this.timers.map((entry) => (entry.id === timer.id ? { ...entry, lastRunAt: scheduled ? now : entry.lastRunAt, lastResult: result, lastOk: problems.length === 0 } : entry));
    this.save();
    this.deps.log.info({ timer: timer.name, scheduled, ok: problems.length === 0 }, 'time switch fired');
  }

  private save(): void {
    this.deps.settings.setInternal(STORE_KEY, this.timers);
  }
}
