import { CalendarClock, Search, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EntityTile } from '../../components/entities/EntityTile.tsx';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { EmptyState, PageHeader, Row, RowGroup, Section, TextInput, TileGrid, Toggle } from '../../components/ui.tsx';
import { useEntities } from '../../hooks/entities.ts';
import { toggleClock } from '../../lib/actions.ts';
import { useCan } from '../../store/session.ts';

/** The building controller's scenes and timers. */
export function AutomationsPage() {
  const scenes = useEntities('action');
  const clocks = useEntities('clock');
  const canControl = useCan('home.control');
  const [details, setDetails] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const map = new Map<string, typeof scenes>();
    for (const scene of scenes) {
      if (term && !scene.name.toLowerCase().includes(term)) continue;
      const key = scene.room ?? '';
      map.set(key, [...(map.get(key) ?? []), scene]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'de'));
  }, [scenes, filter]);

  if (scenes.length === 0 && clocks.length === 0) {
    return (
      <>
        <PageHeader title="Automationen" back="/mehr" />
        <EmptyState icon={Workflow} title="Noch keine Automationen" text="Szenen und Zeitschaltuhren, die in deiner Gebäudesteuerung angelegt sind, erscheinen hier automatisch." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Automationen" back="/mehr" />
      {scenes.length > 12 && (
        <div className="relative mb-5">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-faint" aria-hidden />
          <TextInput value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Szene suchen" aria-label="Szene suchen" className="pl-11" />
        </div>
      )}
      {groups.map(([room, entries]) => (
        <Section key={room} title={groups.length > 1 ? room || 'Weitere Szenen' : 'Szenen'}>
          <TileGrid>
            {entries.map((scene) => (
              <EntityTile key={scene.id} entity={scene} onDetails={setDetails} />
            ))}
          </TileGrid>
        </Section>
      ))}
      {scenes.length > 0 && groups.length === 0 && <p className="mb-7 px-1 text-muted">Keine Szene passt zu „{filter}“.</p>}

      {clocks.length > 0 && (
        <Section title="Zeitschaltuhren">
          <RowGroup>
            {clocks.map((clock) => (
              <Row
                key={clock.id}
                icon={CalendarClock}
                tone={clock.enabled === false ? 'neutral' : 'accent'}
                className={clock.available ? undefined : 'opacity-60'}
                title={clock.name}
                subtitle={!clock.available ? 'Nicht erreichbar' : [clock.room, clock.enabled === false ? 'Pausiert' : 'Aktiv'].filter(Boolean).join(' · ')}
                trailing={
                  <Toggle
                    checked={clock.enabled !== false}
                    label={`${clock.name} ${clock.enabled === false ? 'aktivieren' : 'pausieren'}`}
                    disabled={!canControl || !clock.available || !clock.features.toggle}
                    onChange={() => void toggleClock(clock)}
                  />
                }
              />
            ))}
          </RowGroup>
        </Section>
      )}
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
