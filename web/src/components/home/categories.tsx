import { Blinds, LayoutGrid, Lightbulb, PlayCircle, Plug, Thermometer, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import type { BlindEntity, Entity, EntityKind, LightEntity } from '@home-hub/shared';
import { blind, sendCommand } from '../../lib/actions.ts';
import { formatNumber } from '../../lib/format.ts';
import { useHub } from '../../store/hub.ts';
import { cx } from '../ui.tsx';

/** The house's controls, sorted by function — the same menus the building controller has. */
export interface Category {
  id: 'licht' | 'jalousien' | 'klima' | 'geraete' | 'aktionen';
  path: string;
  label: string;
  title: string;
  icon: LucideIcon;
  kinds: EntityKind[];
}

export const CATEGORIES: Category[] = [
  { id: 'licht', path: '/licht', label: 'Licht', title: 'Licht', icon: Lightbulb, kinds: ['light'] },
  { id: 'jalousien', path: '/jalousien', label: 'Jalousien', title: 'Jalousien', icon: Blinds, kinds: ['blind'] },
  { id: 'klima', path: '/klima', label: 'Klima', title: 'Heizung & Klima', icon: Thermometer, kinds: ['climate'] },
  { id: 'geraete', path: '/geraete', label: 'Geräte', title: 'Geräte & Steckdosen', icon: Plug, kinds: ['switch'] },
  { id: 'aktionen', path: '/aktionen', label: 'Aktionen', title: 'Aktionen', icon: PlayCircle, kinds: ['action', 'clock'] },
];

export const HOME_PATHS = ['/raeume', ...CATEGORIES.map((category) => category.path)];

export interface HouseSummary {
  lights: LightEntity[];
  lightsOn: LightEntity[];
  blinds: BlindEntity[];
  blindsClosed: number;
  blindsMoving: number;
  climateCount: number;
  heating: number;
  averageTemperature: number | null;
  switches: number;
  switchesOn: number;
  actions: number;
  activeActions: number;
  /** Controller groups that act on the whole house ("Alle Lichter", "Alle Jalousien"). */
  lightGroup: LightEntity | null;
  blindGroup: BlindEntity | null;
}

/** Counts across the whole house, for the menus and the overview. */
export function useHouseSummary(): HouseSummary {
  const entities = useHub((state) => state.entities);
  return useMemo(() => {
    const all = Object.values(entities).filter((entity) => entity.available);
    const lights = all.filter((entity): entity is LightEntity => entity.kind === 'light' && !entity.isGroup);
    const blinds = all.filter((entity): entity is BlindEntity => entity.kind === 'blind' && !entity.isGroup);
    const climates = all.filter((entity) => entity.kind === 'climate');
    const temperatures = climates.map((entity) => (entity.kind === 'climate' ? entity.temperature : null)).filter((value): value is number => value !== null);
    const switches = all.filter((entity) => entity.kind === 'switch' && !entity.momentary);
    return {
      lights,
      lightsOn: lights.filter((entity) => entity.on),
      blinds,
      blindsClosed: blinds.filter((entity) => (entity.position ?? 0) >= 50).length,
      blindsMoving: blinds.filter((entity) => entity.motion !== 'stopped').length,
      climateCount: climates.length,
      heating: climates.filter((entity) => entity.kind === 'climate' && entity.heating).length,
      averageTemperature: temperatures.length > 0 ? temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length : null,
      switches: switches.length,
      switchesOn: switches.filter((entity) => entity.kind === 'switch' && entity.on).length,
      actions: all.filter((entity) => entity.kind === 'action').length,
      activeActions: all.filter((entity) => entity.kind === 'action' && entity.active).length,
      lightGroup: (all.find((entity) => entity.kind === 'light' && entity.isGroup && entity.room === null) as LightEntity | undefined) ?? null,
      blindGroup: (all.find((entity) => entity.kind === 'blind' && entity.isGroup && entity.room === null) as BlindEntity | undefined) ?? null,
    };
  }, [entities]);
}

/** "Alle aus": through the controller's own group when there is one (one command), otherwise lamp by lamp. */
export function allLightsOff(summary: HouseSummary): void {
  if (summary.lightGroup) void sendCommand(summary.lightGroup, { action: 'turn_off' }, { on: false });
  for (const entity of summary.lightsOn) {
    if (!summary.lightGroup) void sendCommand(entity, { action: 'turn_off' }, { on: false });
    else useHub.getState().patchEntity(entity.id, { on: false } as Partial<Entity>);
  }
}

export function allBlinds(summary: HouseSummary, direction: 'up' | 'down'): void {
  if (summary.blindGroup) {
    void blind[direction](summary.blindGroup);
    for (const entity of summary.blinds) useHub.getState().patchEntity(entity.id, { motion: direction } as Partial<Entity>);
    return;
  }
  for (const entity of summary.blinds) void blind[direction](entity);
}

/** A small number next to a menu entry: what is going on there right now. */
function badge(category: Category['id'], summary: HouseSummary): string | null {
  switch (category) {
    case 'licht':
      return summary.lightsOn.length > 0 ? String(summary.lightsOn.length) : null;
    case 'jalousien':
      return summary.blindsMoving > 0 ? '↕' : null;
    case 'klima':
      return summary.averageTemperature !== null ? `${formatNumber(summary.averageTemperature)}°` : null;
    case 'geraete':
      return summary.switchesOn > 0 ? String(summary.switchesOn) : null;
    case 'aktionen':
      return null;
  }
}

/** The switch between "by room" and "by function" at the top of the house pages. */
export function HomeNav() {
  const summary = useHouseSummary();
  const entities = useHub((state) => state.entities);
  const present = useMemo(() => new Set(Object.values(entities).map((entity) => entity.kind)), [entities]);
  const items = [
    { path: '/raeume', label: 'Räume', icon: LayoutGrid, badge: null as string | null },
    ...CATEGORIES.filter((category) => category.kinds.some((kind) => present.has(kind))).map((category) => ({ path: category.path, label: category.label, icon: category.icon, badge: badge(category.id, summary) })),
  ];
  return (
    <nav aria-label="Bereiche" className="no-scrollbar -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === '/raeume'}
          className={({ isActive }) =>
            cx(
              'flex h-10 shrink-0 items-center gap-2 rounded-full pl-3 pr-4 text-sm font-medium transition active:scale-[0.97]',
              isActive ? 'bg-fg text-bg' : 'panel text-muted hover:text-fg',
            )
          }
        >
          <item.icon className="size-4" aria-hidden />
          {item.label}
          {item.badge && <span className="-mr-1 rounded-full bg-current/15 px-1.5 text-xs tabular-nums opacity-80">{item.badge}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
