import { Home, Music2, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Entity, EntityKind } from '@home-hub/shared';
import { EntityTile } from '../components/entities/EntityTile.tsx';
import { EntitySheet } from '../components/entities/sheets.tsx';
import { Tile } from '../components/Tile.tsx';
import { Button, EmptyState, PageHeader, Section, TileGrid } from '../components/ui.tsx';
import { useRooms } from '../hooks/entities.ts';
import { sendCommand } from '../lib/actions.ts';
import { formatTemperature } from '../lib/format.ts';
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

  const lightsOn = room.entities.filter((entity) => entity.kind === 'light' && entity.on && entity.available);

  return (
    <>
      <PageHeader
        title={room.name}
        back="/raeume"
        subtitle={room.temperature !== null ? formatTemperature(room.temperature) : undefined}
        actions={
          canControl && lightsOn.length > 1 ? (
            <Button
              size="sm"
              icon={Power}
              onClick={() => {
                for (const entity of lightsOn) void sendCommand(entity, { action: 'turn_off' }, { on: false });
              }}
            >
              Licht aus
            </Button>
          ) : undefined
        }
      />

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
