import { Lightbulb, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { setLightWatchExcluded, type LightEntity } from '@home-hub/shared';
import { EmptyState, Notice, PageHeader, Row, RowGroup, TextInput, Toggle } from '../../../components/ui.tsx';
import { saveLayout } from '../../../lib/layout.ts';
import { useHub } from '../../../store/hub.ts';

/**
 * Which lights the lighting watch ("Status Beleuchtung" on the security page) counts. Lights that
 * are meant to stay on — an outside light on a time switch, the aquarium — are left out here.
 */
export function LightWatchPage() {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const excluded = useHub((state) => state.layout.lightWatchExcluded);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const out = useMemo(() => new Set(excluded ?? []), [excluded]);

  const byRoom = useMemo(() => {
    const lights = [...Object.values(entities), ...Object.values(hidden)].filter((entity): entity is LightEntity => entity.kind === 'light' && !entity.isGroup);
    const groups = new Map<string, LightEntity[]>();
    for (const light of lights) {
      if (q && !`${light.name} ${light.room ?? ''}`.toLowerCase().includes(q)) continue;
      const room = light.room ?? 'Ohne Raum';
      groups.set(room, [...(groups.get(room) ?? []), light]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'de'))
      .map(([room, list]) => [room, list.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))] as const);
  }, [entities, hidden, q]);

  const toggle = (light: LightEntity, watched: boolean) => {
    const next = watched ? [...out].filter((id) => id !== light.id) : [...out, light.id];
    void saveLayout(setLightWatchExcluded(useHub.getState().layout, next), watched ? `„${light.name}“ wird wieder überwacht` : `„${light.name}“ von der Licht-Überwachung ausgenommen`);
  };

  return (
    <>
      <PageHeader title="Licht-Überwachung" subtitle="Welche Lichter dabei zählen" back="/einstellungen" />
      <Notice className="mb-5">
        Unter <strong>Sicherheit</strong> zeigt „Status Beleuchtung“, welche Lichter noch an sind, und schaltet sie aus. Lichter, die ruhig an bleiben dürfen (z. B. Außenlicht mit Zeitschaltuhr), nimmst du hier aus – sie erscheinen dort nicht mehr.
        Gilt für alle im Haushalt.
      </Notice>
      {out.size > 0 && <p className="mb-3 px-1 text-sm text-muted">{out.size === 1 ? '1 Licht ist ausgenommen.' : `${out.size} Lichter sind ausgenommen.`}</p>}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3.5 top-3.5 size-5 text-faint" aria-hidden />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Licht oder Raum suchen" aria-label="Licht oder Raum suchen" className="pl-11" />
      </div>
      {byRoom.length === 0 ? (
        <EmptyState icon={Lightbulb} title={q ? 'Nichts gefunden' : 'Keine Lichter'} />
      ) : (
        <div className="flex flex-col gap-4">
          {byRoom.map(([room, lights]) => (
            <div key={room}>
              <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-faint">{room}</p>
              <RowGroup>
                {lights.map((light) => {
                  const watched = !out.has(light.id);
                  return (
                    <Row
                      key={light.id}
                      icon={Lightbulb}
                      tone={watched ? 'warm' : 'neutral'}
                      title={light.name}
                      subtitle={watched ? 'Wird überwacht' : 'Ausgenommen'}
                      trailing={<Toggle checked={watched} label={`${light.name} überwachen`} onChange={(next) => toggle(light, next)} tone="warm" />}
                    />
                  );
                })}
              </RowGroup>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
