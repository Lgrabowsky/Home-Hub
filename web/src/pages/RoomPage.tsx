import { ChevronDown, ChevronUp, Home, Music2, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BlindEntity, Entity, EntityKind, LightEntity } from '@home-hub/shared';
import { ClimateGlyph } from '../components/home/glyphs.tsx';
import { EntityTile } from '../components/entities/EntityTile.tsx';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { Tile } from '../components/Tile.tsx';
import { Button, EmptyState, IconButton, PageHeader, Section, TileGrid } from '../components/ui.tsx';
import { useFloors, useRooms } from '../hooks/entities.ts';
import { blind, sendCommand } from '../lib/actions.ts';
import { formatNumber } from '../lib/format.ts';
import { useHub } from '../store/hub.ts';
import { useCan } from '../store/session.ts';

const SECTIONS: { title: string; kinds: EntityKind[]; permission?: 'security.view' }[] = [
  { title: 'Licht', kinds: ['light'] },
  { title: 'Jalousien', kinds: ['blind'] },
  { title: 'Klima', kinds: ['climate'] },
  { title: 'Geräte', kinds: ['switch'] },
  { title: 'Szenen & Zeitschaltuhren', kinds: ['action', 'clock'] },
  { title: 'Fenster & Türen', kinds: ['contact'], permission: 'security.view' },
  { title: 'Kameras & Türstationen', kinds: ['camera', 'door'] },
  { title: 'Messwerte', kinds: ['sensor'] },
];

export function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const rooms = useRooms();
  const floors = useFloors();
  const room = rooms.find((entry) => entry.id === roomId);
  const groups = useHub((state) => state.music.groups);
  const canControl = useCan('home.control');
  const [details, setDetails] = useState<string | null>(null);

  const sections = useMemo(() => {
    if (!room) return [];
    return SECTIONS.map((section) => ({
      ...section,
      entities: room.entities.filter((entity: Entity) => section.kinds.includes(entity.kind)),
    })).filter((section) => section.entities.length > 0);
  }, [room]);

  if (!room) {
    return (
      <>
        <PageHeader title="Raum" back="/raeume" />
        <EmptyState icon={Home} title="Diesen Raum gibt es nicht (mehr)" action={<Button onClick={() => navigate('/raeume')}>Zu den Räumen</Button>} />
      </>
    );
  }

  const lightsOn = room.entities.filter((entity): entity is LightEntity => entity.kind === 'light' && entity.on && entity.available);
  const blinds = room.entities.filter((entity): entity is BlindEntity => entity.kind === 'blind' && entity.available);
  const floor = floors.find((entry) => entry.rooms.some((candidate) => candidate.id === room.id))?.name;

  return (
    <>
      <PageHeader title={room.name} back="/raeume" subtitle={floor || undefined} />

      {(room.temperature !== null || lightsOn.length > 0 || blinds.length > 1) && (
        <div className="panel mb-7 flex flex-wrap items-center gap-x-5 gap-y-4 rounded-tile p-5">
          {room.temperature !== null && (
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <ClimateGlyph heating={room.heating} cooling={false} />
              <div>
                <p className="text-[34px] font-semibold leading-none tracking-tight tabular-nums">
                  {formatNumber(room.temperature)}
                  <span className="ml-0.5 align-top text-lg font-medium text-muted">°C</span>
                </p>
                <p className="mt-1 text-sm text-muted">{room.target !== null ? `${room.heating ? 'heizt auf' : 'Wunsch'} ${formatNumber(room.target)} °C` : 'Raumtemperatur'}</p>
              </div>
            </div>
          )}
          {canControl && (
            <div className="flex gap-2">
              {lightsOn.length > 0 && (
                <Button icon={Power} onClick={() => lightsOn.forEach((entity) => void sendCommand(entity, { action: 'turn_off' }, { on: false }))}>
                  Licht aus
                </Button>
              )}
              {blinds.length > 1 && (
                <>
                  <IconButton icon={ChevronUp} variant="filled" label="Alle Jalousien im Raum hochfahren" onClick={() => blinds.forEach((entity) => void blind.up(entity))} />
                  <IconButton icon={ChevronDown} variant="filled" label="Alle Jalousien im Raum herunterfahren" onClick={() => blinds.forEach((entity) => void blind.down(entity))} />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {sections.map((section) => (
        <Section key={section.title} title={section.title}>
          <TileGrid>
            {section.entities.map((entity) => (
              <EntityTile key={entity.id} entity={entity} onDetails={setDetails} />
            ))}
          </TileGrid>
        </Section>
      ))}

      {room.players.length > 0 && (
        <Section title="Musik">
          <TileGrid>
            {room.players.map((player) => {
              const group = groups.find((entry) => entry.id === player.groupId);
              const playing = group?.state === 'playing';
              return (
                <Tile
                  key={player.id}
                  icon={Music2}
                  tone="music"
                  title={player.name}
                  active={playing}
                  unavailable={!player.available}
                  subtitle={playing ? (group?.track?.title ?? 'Spielt') : 'Pausiert'}
                  pressLabel={`Musik in ${player.name} öffnen`}
                  onPress={() => navigate(`/musik?raum=${encodeURIComponent(player.id)}`)}
                />
              );
            })}
          </TileGrid>
        </Section>
      )}

      {sections.length === 0 && room.players.length === 0 && <EmptyState icon={Home} title="In diesem Raum gibt es noch keine Geräte" />}

      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
