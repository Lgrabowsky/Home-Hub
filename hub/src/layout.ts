import { z } from 'zod';
import { EMPTY_LAYOUT, LAYOUT_LIMITS, type HouseLayout } from '@home-hub/shared';
import { HttpError } from './http/errors.ts';
import type { Logger } from './log.ts';
import type { SettingsStore } from './settings.ts';
import type { StateStore } from './state.ts';

/**
 * The household's own arrangement of the house (names, rooms, areas, order,
 * lights of the cameras), stored on the hub and applied to every device before
 * the apps see it — so all apps, the time switches and the audit log use the
 * same names. Only what differs from the automatic arrangement is stored.
 */

const name = z.string().trim().min(1).max(LAYOUT_LIMITS.name);
const id = z.string().min(1).max(200);
const record = <T extends z.ZodTypeAny>(value: T) =>
  z.record(z.string().min(1).max(200), value).refine((entries) => Object.keys(entries).length <= LAYOUT_LIMITS.entries, 'Zu viele Einträge.');

export const layoutSchema: z.ZodType<HouseLayout> = z.object({
  floors: z
    .array(z.object({ name, rooms: z.array(name).max(LAYOUT_LIMITS.roomsPerFloor) }))
    .max(LAYOUT_LIMITS.floors)
    .refine((floors) => new Set(floors.map((floor) => floor.name)).size === floors.length, 'Zwei Bereiche heißen gleich.')
    .nullable(),
  rooms: record(name),
  devices: record(
    z.object({
      name: name.optional(),
      // '' = no room.
      room: z.string().trim().max(LAYOUT_LIMITS.name).optional(),
      hidden: z.boolean().optional(),
    }),
  ),
  order: record(z.array(id).max(LAYOUT_LIMITS.entries)),
  cameraLights: record(z.array(id).max(LAYOUT_LIMITS.cameraLights)),
  pageOrder: record(z.array(id).max(LAYOUT_LIMITS.entries)).optional(),
}) as z.ZodType<HouseLayout>;

const KEY = 'layout';

export class LayoutService {
  private layout: HouseLayout = EMPTY_LAYOUT;

  constructor(private readonly deps: { settings: SettingsStore; state: StateStore; log: Logger }) {}

  /**
   * Loads the stored layout. Storeys set in the general settings (earlier
   * versions, the demo) are the starting point while the household has not
   * arranged its own areas — and what "Alles zurücksetzen" returns to.
   */
  load(): void {
    const stored = this.deps.settings.getInternal<unknown>(KEY);
    const parsed = stored === null ? null : layoutSchema.safeParse(stored);
    if (parsed && !parsed.success) this.deps.log.warn('stored house layout is not valid, starting from the automatic arrangement');
    this.layout = parsed?.success ? parsed.data : EMPTY_LAYOUT;
    this.apply();
  }

  private apply(): void {
    this.deps.state.setHouseLayout(this.layout, this.deps.settings.get('general').floors);
  }

  get(): HouseLayout {
    return this.layout;
  }

  set(input: unknown): HouseLayout {
    const parsed = layoutSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, 'bad_request', issue?.message ?? 'Ungültige Anordnung.');
    }
    this.layout = parsed.data;
    this.deps.settings.setInternal(KEY, this.layout);
    this.apply();
    return this.layout;
  }
}
