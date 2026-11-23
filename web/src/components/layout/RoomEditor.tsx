import { EyeOff, Link2, Merge, Pencil, Plus, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { moveRoom, orderDevices, renameRoom, resetRoom, roomChanged, roomKey, setDevice, sortByLayout, type Entity } from '@home-hub/shared';
import { buildRooms } from '../../hooks/entities.ts';
import { editableLayout, layoutContext, saveLayout, shownAreas } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { entityIcon } from '../entities/icons.ts';
import { toast } from '../toast.tsx';
import { Badge, Button, ConfirmDialog, Field, IconButton, Notice, Row, RowGroup, Select, Sheet, TextInput } from '../ui.tsx';
import { DeviceEditor } from './DeviceEditor.tsx';
import { RoomContacts } from './RoomContacts.tsx';
import { SortableList } from './SortableList.tsx';

const NEW_AREA = '\u0000new';

/** All devices (hidden ones too) of a room, in the household's order. */
export function useRoomDevices(room: string | null): Entity[] {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const layout = useHub((state) => state.layout);
  return useMemo(() => {
    if (!room) return [];
    const key = roomKey(room);
    const list = [...Object.values(entities), ...Object.values(hidden)].filter((entity) => entity.room !== null && roomKey(entity.room) === key && !('isGroup' in entity && entity.isGroup));
    return sortByLayout(list, layout.order[key]);
  }, [entities, hidden, layout, room]);
}

/** Picks devices of other rooms (or without room) and brings them into this one. */
function BringDevices({ room, open, onClose }: { room: string; open: boolean; onClose(): void }) {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const others = [...Object.values(entities), ...Object.values(hidden)]
    .filter((entity) => (entity.room === null || roomKey(entity.room) !== roomKey(room)) && !('isGroup' in entity && entity.isGroup))
    .filter((entity) => q === '' || `${entity.name} ${entity.room ?? ''}`.toLowerCase().includes(q));
  const groups = new Map<string, Entity[]>();
  for (const entity of others) groups.set(entity.room ?? 'Ohne Raum', [...(groups.get(entity.room ?? 'Ohne Raum') ?? []), entity]);
  const bring = async (entity: Entity) => {
    if (await saveLayout(setDevice(useHub.getState().layout, entity, { room }), `„${entity.name}“ nach „${room}“ verschoben`)) toast.success(`${entity.name} ist jetzt in ${room}`);
  };
  return (
    <Sheet open={open} onClose={onClose} title={`Gerät nach „${room}“ holen`}>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-3.5 size-5 text-faint" aria-hidden />
        <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gerät oder Raum suchen" aria-label="Gerät oder Raum suchen" className="pl-11" />
      </div>
      <div className="flex flex-col gap-4">
        {[...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'de'))
          .map(([name, list]) => (
            <div key={name}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{name}</p>
              <RowGroup>
                {list.map((entity) => (
                  <Row key={entity.id} icon={entityIcon(entity)} title={entity.name} trailing={<Plus className="size-4.5 text-faint" aria-hidden />} onClick={() => void bring(entity)} />
                ))}
              </RowGroup>
            </div>
          ))}
        {others.length === 0 && <p className="text-sm text-muted">Keine passenden Geräte.</p>}
      </div>
    </Sheet>
  );
}

function Editor({ room, onClose, onRenamed }: { room: string; onClose(): void; onRenamed?(name: string): void }) {
  const layout = useHub((state) => state.layout);
  const devices = useRoomDevices(room);
  const areas = shownAreas();
  const currentArea = areas.find((area) => area.rooms.some((entry) => roomKey(entry) === roomKey(room)))?.name ?? '';
  const otherRooms = areas.flatMap((area) => area.rooms).filter((entry) => roomKey(entry) !== roomKey(room));
  const [name, setName] = useState(room);
  const [area, setArea] = useState(currentArea);
  const [newArea, setNewArea] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [bringing, setBringing] = useState(false);
  const [contacts, setContacts] = useState(false);
  const [saving, setSaving] = useState(false);
  const changed = roomChanged(layout, layoutContext(), room);
  const existing = otherRooms.find((entry) => roomKey(entry) === roomKey(name.trim()));

  const save = async (allowMerge = false) => {
    const target = name.trim() || room;
    if (existing && !allowMerge) return setConfirmMerge(existing);
    setSaving(true);
    let next = editableLayout();
    const wantedArea = area === NEW_AREA ? newArea.trim() : area;
    if (target !== room) next = renameRoom(next, layoutContext(), room, existing ?? target);
    if (wantedArea && wantedArea !== currentArea && !existing) next = moveRoom(next, target, wantedArea);
    const ok = await saveLayout(next, target !== room ? `Raum „${room}“ heißt jetzt „${existing ?? target}“` : `Raum „${room}“ geändert`);
    setSaving(false);
    if (!ok) return;
    if (target !== room) onRenamed?.(existing ?? target);
    onClose();
  };
  const merge = async (target: string) => {
    const next = renameRoom(editableLayout(), layoutContext(), room, target);
    if (await saveLayout(next, `Raum „${room}“ mit „${target}“ zusammengeführt`)) {
      onRenamed?.(target);
      onClose();
    }
  };
  const reset = async () => {
    if (await saveLayout(resetRoom(layout, layoutContext(), room), `Raum „${room}“ zurückgesetzt`)) onClose();
  };
  const reorder = (ids: string[]) => void saveLayout(orderDevices(layout, room, devices.map((entity) => entity.id), ids), `Reihenfolge in „${room}“ geändert`);

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title="Raum bearbeiten"
        subtitle={room}
        footer={
          <div className="flex items-center gap-2">
            {changed && (
              <Button variant="ghost" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
                Zurücksetzen
              </Button>
            )}
            <Button variant="primary" loading={saving} onClick={() => void save()} className="ml-auto">
              Speichern
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Name" hint={existing ? `„${existing}“ gibt es schon – beim Speichern werden beide Räume zu einem.` : undefined}>
            <TextInput value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className="flex flex-col gap-2">
            <Field label="Bereich">
              <Select value={area} onChange={(event) => setArea(event.target.value)}>
                {!currentArea && <option value="">Automatisch</option>}
                {areas
                  .filter((entry) => entry.name)
                  .map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                <option value={NEW_AREA}>Neuer Bereich …</option>
              </Select>
            </Field>
            {area === NEW_AREA && <TextInput aria-label="Name des neuen Bereichs" placeholder="z. B. Dachgeschoss" maxLength={60} value={newArea} onChange={(event) => setNewArea(event.target.value)} />}
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-muted">Geräte in diesem Raum</p>
            {devices.length > 0 ? (
              <div className="overflow-hidden rounded-tile bg-sunken">
                <SortableList
                  items={devices.map((entity) => ({ id: entity.id, label: entity.name }))}
                  onReorder={reorder}
                  render={(item) => {
                    const entity = devices.find((entry) => entry.id === item.id)!;
                    const Icon = entityIcon(entity);
                    return (
                      <div className="flex items-center gap-2.5 py-1.5 pr-1.5">
                        <Icon className="size-4.5 shrink-0 text-muted" aria-hidden />
                        <span className={entity.hidden ? 'min-w-0 flex-1 truncate text-muted' : 'min-w-0 flex-1 truncate'}>{entity.name}</span>
                        {entity.hidden && (
                          <Badge>
                            <EyeOff className="mr-1 inline size-3.5" aria-hidden />
                            ausgeblendet
                          </Badge>
                        )}
                        <IconButton icon={Pencil} size="sm" label={`${entity.name} bearbeiten`} onClick={() => setEditing(entity.id)} />
                      </div>
                    );
                  }}
                />
              </div>
            ) : (
              <Notice>Noch keine Geräte. Hol welche aus anderen Räumen hierher.</Notice>
            )}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" icon={Plus} onClick={() => setBringing(true)}>
                Gerät hierher holen
              </Button>
              <Button size="sm" icon={Link2} onClick={() => setContacts(true)}>
                Fenster & Türen zuordnen
              </Button>
            </div>
          </div>

          {otherRooms.length > 0 && (
            <div className="flex flex-col gap-2">
              <Field label="Mit einem anderen Raum zusammenführen" hint="Alle Geräte kommen in den gewählten Raum; dieser Raum verschwindet.">
                <Select value={mergeInto} onChange={(event) => setMergeInto(event.target.value)}>
                  <option value="">Raum wählen …</option>
                  {otherRooms.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button size="sm" icon={Merge} disabled={!mergeInto} onClick={() => setConfirmMerge(mergeInto)} className="self-start">
                Zusammenführen
              </Button>
            </div>
          )}
        </div>
      </Sheet>
      <BringDevices room={room} open={bringing} onClose={() => setBringing(false)} />
      <RoomContacts room={room} open={contacts} onClose={() => setContacts(false)} />
      <DeviceEditor entityId={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={confirmMerge !== null}
        onClose={() => setConfirmMerge(null)}
        title={`„${room}“ und „${confirmMerge ?? ''}“ zusammenführen?`}
        text={`Die Geräte aus „${room}“ kommen nach „${confirmMerge ?? ''}“. Mit „Zurücksetzen“ bei „${confirmMerge ?? ''}“ lässt sich das rückgängig machen.`}
        confirmLabel="Zusammenführen"
        onConfirm={() => (confirmMerge ? merge(confirmMerge) : undefined)}
      />
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={`„${room}“ zurücksetzen?`}
        text="Name, Geräte und Reihenfolge werden wieder so, wie der Hub sie erkannt hat. Ein selbst angelegter Raum verschwindet, seine Geräte kommen zurück in ihre Räume."
        confirmLabel="Zurücksetzen"
        onConfirm={() => reset()}
      />
    </>
  );
}

/** Name, area, devices and order of one room; merging and resetting (administrators). */
export function RoomEditor({ room, onClose, onRenamed }: { room: string | null; onClose(): void; onRenamed?(name: string): void }) {
  if (!room) return null;
  return <Editor key={room} room={room} onClose={onClose} onRenamed={onRenamed} />;
}

/** All rooms of the house, for pickers. */
export function useAllRoomNames(): string[] {
  const entities = useHub((state) => state.entities);
  const players = useHub((state) => state.music.players);
  const layout = useHub((state) => state.layout);
  return useMemo(() => buildRooms(Object.values(entities), players, layout).map((room) => room.name), [entities, players, layout]);
}
