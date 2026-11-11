import { ChevronRight, Flame, Home, Snowflake, Wind } from 'lucide-react';
import { useState } from 'react';
import { EntityTile, entityStateText } from '../../components/entities/EntityTile.tsx';
import { sensorIcon } from '../../components/entities/icons.ts';
import { climateModeLabel, EntitySheet } from '../../components/entities/sheets.tsx';
import { Card, cx, EmptyState, PageHeader, Section, TileGrid } from '../../components/ui.tsx';
import { useEntities } from '../../hooks/entities.ts';
import { formatPercent, formatTemperature } from '../../lib/format.ts';

/** Climate of every room, weather, energy — the "how is the house doing" view. */
export function HousePage() {
  const climate = useEntities('climate');
  const sensors = useEntities('sensor');
  const switches = useEntities('switch');
  const [details, setDetails] = useState<string | null>(null);

  const weather = sensors.filter((sensor) => sensor.id.startsWith('gekko:meteo/'));
  const energy = sensors.filter((sensor) => sensor.sensorType === 'power' || sensor.sensorType === 'energy');
  const other = sensors.filter((sensor) => !weather.includes(sensor) && !energy.includes(sensor));
  const rooms = [...climate].sort((a, b) => (a.room ?? a.name).localeCompare(b.room ?? b.name, 'de'));
  const temps = rooms.map((room) => room.temperature).filter((value): value is number => value !== null);
  const heating = rooms.filter((room) => room.heating).length;

  if (climate.length === 0 && sensors.length === 0 && switches.length === 0) {
    return (
      <>
        <PageHeader title="Haus & Klima" back="/mehr" />
        <EmptyState icon={Home} title="Noch keine Messwerte" text="Temperaturen, Wetter und Energie deiner Gebäudesteuerung erscheinen hier." />
      </>
    );
  }

  const valueTiles = (list: typeof sensors) => (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
      {list.map((sensor) => {
        const Icon = sensorIcon(sensor);
        return (
          <Card key={sensor.id} className={cx('p-3.5', !sensor.available && 'opacity-60')}>
            <Icon className="size-5 text-muted" aria-hidden />
            <p className="mt-2 text-xl font-semibold tabular-nums">{entityStateText(sensor)}</p>
            <p className="truncate text-[13px] text-muted">{sensor.name}</p>
          </Card>
        );
      })}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Haus & Klima"
        back="/mehr"
        subtitle={temps.length > 0 ? `Ø ${formatTemperature(temps.reduce((a, b) => a + b, 0) / temps.length)} · ${heating === 0 ? 'keine Heizung aktiv' : heating === 1 ? '1 Raum heizt' : `${heating} Räume heizen`}` : undefined}
      />

      {rooms.length > 0 && (
        <Section title="Klima">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                disabled={!room.available}
                onClick={() => setDetails(room.id)}
                className={cx('flex items-center gap-3.5 rounded-tile bg-surface p-4 text-left shadow-tile transition hover:bg-raised active:scale-[0.99]', !room.available && 'opacity-60')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{room.room ?? room.name}</span>
                  <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                    {room.target !== null && <span className="tabular-nums">Soll {formatTemperature(room.target)}</span>}
                    <span>{climateModeLabel(room.mode)}</span>
                    {room.humidity !== null && <span className="tabular-nums">{formatPercent(room.humidity)} Feuchte</span>}
                  </span>
                  {room.windowOpen && (
                    <span className="mt-0.5 flex items-center gap-1 text-[13px] font-medium text-warn">
                      <Wind className="size-3.5" aria-hidden /> Fenster offen
                    </span>
                  )}
                </span>
                {room.heating && <Flame className="size-4.5 shrink-0 text-warm" aria-label="heizt" />}
                {room.cooling && <Snowflake className="size-4.5 shrink-0 text-cool" aria-label="kühlt" />}
                <span className="shrink-0 text-2xl font-bold tabular-nums tracking-tight">{room.available ? formatTemperature(room.temperature) : '–'}</span>
                <ChevronRight className="size-4.5 shrink-0 text-faint" aria-hidden />
              </button>
            ))}
          </div>
        </Section>
      )}

      {weather.length > 0 && <Section title="Wetter">{valueTiles(weather)}</Section>}
      {energy.length > 0 && <Section title="Energie">{valueTiles(energy)}</Section>}
      {other.length > 0 && <Section title="Weitere Messwerte">{valueTiles(other)}</Section>}

      {switches.length > 0 && (
        <Section title="Geräte">
          <TileGrid>
            {switches.map((entity) => (
              <EntityTile key={entity.id} entity={entity} onDetails={setDetails} showRoom />
            ))}
          </TileGrid>
        </Section>
      )}
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}
