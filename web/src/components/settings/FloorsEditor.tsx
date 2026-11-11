import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import type { Floor } from '@home-hub/shared';
import { groupByFloor, useRooms } from '../../hooks/entities.ts';
import { Button, Card, cx, IconButton, TextInput } from '../ui.tsx';

const SUGGESTIONS = ['Untergeschoss', 'Erdgeschoss', 'Obergeschoss', 'Dachgeschoss', 'Außen'];

/**
 * Which room is on which storey. The app groups the rooms by this; rooms that
 * are not assigned are recognised from their names ("OG Bad") or listed apart.
 */
export function FloorsEditor({ floors, onChange }: { floors: Floor[]; onChange(next: Floor[]): void }) {
  const rooms = useRooms();
  const names = useMemo(() => rooms.map((room) => room.name), [rooms]);
  const fold = (text: string) => text.trim().toLowerCase();

  const assign = (floorIndex: number, room: string) => {
    const already = floors[floorIndex]!.rooms.some((entry) => fold(entry) === fold(room));
    onChange(
      floors.map((floor, index) => ({
        ...floor,
        rooms: index === floorIndex && !already ? [...floor.rooms, room] : floor.rooms.filter((entry) => fold(entry) !== fold(room)),
      })),
    );
  };
  const move = (index: number, delta: number) => {
    const next = [...floors];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };
  const start = () => {
    // A first suggestion from the room names, so nobody starts from nothing.
    const guess = groupByFloor(
      names.map((name) => ({ name })),
      [],
    ).filter((group) => group.name && group.name !== 'Weitere Räume');
    onChange(guess.length > 0 ? guess.map((group) => ({ name: group.name, rooms: group.rooms.map((room) => room.name) })) : [{ name: 'Erdgeschoss', rooms: [] }]);
  };
  const unassigned = names.filter((name) => !floors.some((floor) => floor.rooms.some((entry) => fold(entry) === fold(name))));

  return (
    <div className="space-y-2.5">
      {floors.length > 0 && <p className="px-1 text-sm text-muted">Tippe einen Raum an, um ihn dem Stockwerk zuzuordnen. Durchgestrichene Räume liegen schon auf einem anderen.</p>}
      {floors.length === 0 && (
        <Card className="p-4">
          <p className="text-sm text-muted">Noch keine Stockwerke festgelegt. Die App erkennt Stockwerke dann nur an Raumnamen wie „EG Küche“ oder „OG Bad“.</p>
          <Button size="sm" icon={Plus} className="mt-3" onClick={start}>
            Stockwerke anlegen
          </Button>
        </Card>
      )}
      {floors.map((floor, index) => (
        <Card key={index} className="p-4">
          <div className="flex items-center gap-1.5">
            <TextInput
              aria-label={`Name von Stockwerk ${index + 1}`}
              value={floor.name}
              maxLength={40}
              placeholder="z. B. Erdgeschoss"
              onChange={(event) => onChange(floors.map((entry, position) => (position === index ? { ...entry, name: event.target.value } : entry)))}
            />
            <IconButton icon={ArrowUp} size="sm" label="Nach oben" disabled={index === 0} onClick={() => move(index, -1)} />
            <IconButton icon={ArrowDown} size="sm" label="Nach unten" disabled={index === floors.length - 1} onClick={() => move(index, 1)} />
            <IconButton icon={Trash2} size="sm" label={`Stockwerk ${floor.name || index + 1} entfernen`} onClick={() => onChange(floors.filter((_, position) => position !== index))} />
          </div>
          {names.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={`Räume in ${floor.name || `Stockwerk ${index + 1}`}`}>
              {names.map((name) => {
                const here = floor.rooms.some((entry) => fold(entry) === fold(name));
                const elsewhere = !here && floors.some((other, position) => position !== index && other.rooms.some((entry) => fold(entry) === fold(name)));
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={here}
                    onClick={() => assign(index, name)}
                    className={cx(
                      'h-9 rounded-full px-3.5 text-sm transition active:scale-[0.97]',
                      here ? 'bg-accent/20 font-medium text-accent' : elsewhere ? 'bg-sunken text-faint line-through decoration-faint/60' : 'bg-sunken text-muted hover:text-fg',
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">Räume erscheinen hier, sobald Geräte verbunden sind.</p>
          )}
        </Card>
      ))}
      {floors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1">
          <Button
            size="sm"
            icon={Plus}
            disabled={floors.length >= 20}
            onClick={() => onChange([...floors, { name: SUGGESTIONS.find((name) => !floors.some((floor) => floor.name === name)) ?? '', rooms: [] }])}
          >
            Stockwerk hinzufügen
          </Button>
          {unassigned.length > 0 && <span className="text-sm text-muted">Noch ohne Stockwerk: {unassigned.join(', ')}</span>}
        </div>
      )}
    </div>
  );
}
