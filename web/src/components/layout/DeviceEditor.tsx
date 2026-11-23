import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { addRoom, recognisedNameOf, recognisedRoomOf, resetDevice, setDevice, shownRoom, withFloors, type Entity, type HouseLayout } from '@home-hub/shared';
import { saveLayout, shownAreas } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { Button, Field, Select, Sheet, TextInput, Toggle } from '../ui.tsx';

/** A room for a device: an existing one, none, or one created on the spot. */
export type RoomChoice = { kind: 'room'; room: string | null } | { kind: 'new'; name: string; area: string };

const NONE = '\u0000none';
const NEW = '\u0000new';

/** Rooms by area, with "no room" and "new room …". */
export function RoomField({ label = 'Raum', value, onChange, hint }: { label?: string; value: RoomChoice; onChange(next: RoomChoice): void; hint?: string }) {
  const areas = shownAreas();
  const named = areas.filter((area) => area.name);
  const selected = value.kind === 'new' ? NEW : value.room === null ? NONE : value.room;
  return (
    <div className="flex flex-col gap-2.5">
      <Field label={label} hint={hint}>
        <Select
          value={selected}
          onChange={(event) => {
            const next = event.target.value;
            if (next === NEW) onChange({ kind: 'new', name: '', area: named[0]?.name ?? 'Räume' });
            else onChange({ kind: 'room', room: next === NONE ? null : next });
          }}
        >
          {areas.map((area) => (
            <optgroup key={area.name || 'räume'} label={area.name || 'Räume'}>
              {area.rooms.map((room) => (
                <option key={room} value={room}>
                  {room}
                </option>
              ))}
            </optgroup>
          ))}
          <optgroup label="Sonst">
            {/* A room that has no devices yet (or a name typed earlier) stays selectable. */}
            {value.kind === 'room' && value.room !== null && !areas.some((area) => area.rooms.includes(value.room!)) && <option value={value.room}>{value.room}</option>}
            <option value={NONE}>Ohne Raum</option>
            <option value={NEW}>Neuer Raum …</option>
          </optgroup>
        </Select>
      </Field>
      {value.kind === 'new' && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <TextInput aria-label="Name des neuen Raums" placeholder="z. B. Treppenhaus" maxLength={60} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
          {named.length > 0 && (
            <Select aria-label="Bereich des neuen Raums" value={value.area} onChange={(event) => onChange({ ...value, area: event.target.value })} className="w-40">
              {named.map((area) => (
                <option key={area.name} value={area.name}>
                  {area.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

/** Puts a device into the chosen room (creating the room first when it is new). */
export function withRoom(layout: HouseLayout, entity: Entity, choice: RoomChoice): HouseLayout {
  if (choice.kind === 'room') return setDevice(layout, entity, { room: choice.room });
  const name = choice.name.trim();
  if (!name) return layout;
  const next = addRoom(withFloors(layout, shownAreas()), choice.area, name);
  return setDevice(next, entity, { room: name });
}

function Editor({ entity, onClose }: { entity: Entity; onClose(): void }) {
  const layout = useHub((state) => state.layout);
  const [name, setName] = useState(entity.name);
  const [room, setRoom] = useState<RoomChoice>({ kind: 'room', room: entity.room });
  const [shown, setShown] = useState(!entity.hidden);
  const [saving, setSaving] = useState(false);
  const reported = recognisedNameOf(entity);
  const recognised = recognisedRoomOf(entity);
  const automaticRoom = recognised === null ? null : shownRoom(recognised, layout);
  const own = layout.devices[entity.id];

  const save = async () => {
    setSaving(true);
    let next = setDevice(layout, entity, { name, hidden: !shown });
    next = withRoom(next, entity, room);
    const ok = await saveLayout(next, `Gerät „${name.trim() || reported}“ geändert`);
    setSaving(false);
    if (ok) onClose();
  };
  const reset = async () => {
    if (await saveLayout(resetDevice(layout, entity.id), `Gerät „${reported}“ zurückgesetzt`)) onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Gerät bearbeiten"
      subtitle={reported !== entity.name ? `Vom Gerät: ${reported}` : undefined}
      footer={
        <div className="flex items-center gap-2">
          {own && (
            <Button variant="ghost" icon={RotateCcw} onClick={() => void reset()}>
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
        <Field label="Name" hint={reported !== name.trim() && name.trim() ? `Das Gerät selbst heißt „${reported}“.` : undefined}>
          <TextInput value={name} maxLength={60} placeholder={reported} onChange={(event) => setName(event.target.value)} />
        </Field>
        <RoomField value={room} onChange={setRoom} hint={own?.room !== undefined ? `Automatisch: ${automaticRoom ?? 'ohne Raum'}` : undefined} />
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">In der App zeigen</p>
            <p className="text-sm text-muted">Ausgeblendete Geräte schalten Zeitschaltuhren weiterhin.</p>
          </div>
          <Toggle checked={shown} label="In der App zeigen" onChange={setShown} />
        </div>
      </div>
    </Sheet>
  );
}

/** Own name, room and visibility of one device (administrators). */
export function DeviceEditor({ entityId, onClose }: { entityId: string | null; onClose(): void }) {
  const entity = useHub((state) => (entityId ? (state.entities[entityId] ?? state.hidden[entityId]) : undefined));
  if (!entityId || !entity) return null;
  return <Editor key={entityId} entity={entity} onClose={onClose} />;
}
