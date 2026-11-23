import { create } from 'zustand';
import { useFloors } from '../../hooks/entities.ts';
import { cx } from '../ui.tsx';

/**
 * Which storey the room and function pages show. Kept on this device: the tablet on the wall
 * downstairs may well show the ground floor while the phone shows the whole house.
 */
interface FloorFilterStore {
  selected: string | null;
  select(floor: string | null): void;
}

const KEY = 'hh-floor';

function load(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const useStore = create<FloorFilterStore>((set) => ({
  selected: load(),
  select(floor) {
    set({ selected: floor });
    try {
      if (floor) window.localStorage.setItem(KEY, floor);
      else window.localStorage.removeItem(KEY);
    } catch {
      /* private window: only for this visit */
    }
  },
}));

export interface FloorFilterState {
  /** The chosen storey, null = all. A storey that no longer exists counts as "all". */
  selected: string | null;
  floors: string[];
  select(floor: string | null): void;
}

export function useFloorFilter(): FloorFilterState {
  const names = useFloors()
    .map((floor) => floor.name)
    .filter(Boolean);
  const selected = useStore((state) => state.selected);
  const select = useStore((state) => state.select);
  return { selected: selected && names.includes(selected) ? selected : null, floors: names, select };
}

/** "Alle · Erdgeschoss · Obergeschoss · Außen" — only shown when the house has more than one storey. */
export function FloorFilter({ state, className }: { state: FloorFilterState; className?: string }) {
  if (state.floors.length < 2) return null;
  const options: { value: string | null; label: string }[] = [{ value: null, label: 'Alle' }, ...state.floors.map((name) => ({ value: name, label: name }))];
  return (
    <div role="tablist" aria-label="Stockwerk" className={cx('no-scrollbar -mx-4 mb-6 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0', className)}>
      {options.map((option) => {
        const active = option.value === state.selected;
        return (
          <button
            key={option.label}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => state.select(option.value)}
            className={cx('h-9 shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-medium transition', active ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
