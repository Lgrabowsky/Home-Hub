import { Check, Lightbulb, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { setCameraLights, type Entity, type LightEntity } from '@home-hub/shared';
import { saveLayout } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { useIsAdmin } from '../../store/session.ts';
import { EntitySheet } from '../entities/sheets.tsx';
import { EntityRow } from '../home/rows.tsx';
import { Button, cx, RowGroup, Sheet, TextInput } from '../ui.tsx';

const isLight = (entity: Entity | undefined): entity is LightEntity => entity?.kind === 'light';

/** Chooses the lights that belong to a camera (or door station). */
function LightPicker({ cameraId, cameraName, open, onClose }: { cameraId: string; cameraName: string; open: boolean; onClose(): void }) {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const assigned = useHub((state) => state.layout.cameraLights[cameraId]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  // Start from what is assigned whenever the picker opens.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setChosen(assigned ?? []);
      setQuery('');
    }
  }
  const q = query.trim().toLowerCase();
  const byRoom = useMemo(() => {
    const lights = [...Object.values(entities), ...Object.values(hidden)].filter((entity): entity is LightEntity => entity.kind === 'light' && !entity.isGroup);
    const groups = new Map<string, LightEntity[]>();
    for (const light of lights) {
      if (q && !`${light.name} ${light.room ?? ''}`.toLowerCase().includes(q)) continue;
      const room = light.room ?? 'Ohne Raum';
      groups.set(room, [...(groups.get(room) ?? []), light]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'de'));
  }, [entities, hidden, q]);
  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  const save = async () => {
    setSaving(true);
    const ok = await saveLayout(setCameraLights(useHub.getState().layout, cameraId, chosen), `Lichter für „${cameraName}“ gewählt`);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Lichter für diese Kamera"
      subtitle={cameraName}
      footer={
        <Button variant="primary" block loading={saving} onClick={() => void save()}>
          {chosen.length === 0 ? 'Ohne Lichter speichern' : `${chosen.length} ${chosen.length === 1 ? 'Licht' : 'Lichter'} übernehmen`}
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">Die gewählten Lichter erscheinen als Schalter unter dem Kamerabild – damit die Kamera Licht hat.</p>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-3.5 size-5 text-faint" aria-hidden />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Licht oder Raum suchen" aria-label="Licht oder Raum suchen" className="pl-11" />
      </div>
      <div className="flex flex-col gap-4">
        {byRoom.map(([room, lights]) => (
          <div key={room}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{room}</p>
            <RowGroup>
              {lights.map((light) => {
                const on = chosen.includes(light.id);
                return (
                  <button key={light.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(light.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-raised">
                    <Lightbulb className={cx('size-4.5 shrink-0', on ? 'text-warm' : 'text-muted')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">{light.name}</span>
                    <span className={cx('flex size-6 items-center justify-center rounded-full border', on ? 'border-accent bg-accent text-accent-fg' : 'border-line')} aria-hidden>
                      {on && <Check className="size-4" />}
                    </span>
                  </button>
                );
              })}
            </RowGroup>
          </div>
        ))}
        {byRoom.length === 0 && <p className="text-sm text-muted">Keine passenden Lichter.</p>}
      </div>
    </Sheet>
  );
}

/**
 * The lights of a camera's surroundings, as ordinary light switches on its
 * page — switched on to give the camera light. Administrators choose them.
 */
export function CameraLights({ camera }: { camera: Entity }) {
  const isAdmin = useIsAdmin();
  const ids = useHub((state) => state.layout.cameraLights[camera.id]);
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const [picking, setPicking] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const lights = (ids ?? []).map((id) => entities[id] ?? hidden[id]).filter(isLight);
  if (lights.length === 0 && !isAdmin) return null;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 px-0.5">
        <p className="text-sm font-medium text-muted">Licht</p>
        {isAdmin && (
          <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setPicking(true)}>
            {lights.length === 0 ? 'Lichter zuordnen' : 'Ändern'}
          </Button>
        )}
      </div>
      {lights.length > 0 ? (
        <div className="divide-y divide-line/70 overflow-hidden rounded-tile bg-surface shadow-tile">
          {lights.map((light) => (
            <EntityRow key={light.id} entity={light} title={light.name} room={light.room ?? undefined} onDetails={setDetails} />
          ))}
        </div>
      ) : (
        <p className="px-0.5 text-sm text-faint">Noch keine Lichter. Ordne Lichter zu, die du hier direkt schalten möchtest.</p>
      )}
      <LightPicker cameraId={camera.id} cameraName={camera.name} open={picking} onClose={() => setPicking(false)} />
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </div>
  );
}
