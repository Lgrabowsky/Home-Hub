import { Lightbulb, Power, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { alarmPurpose, type AlarmEntity, type AlarmPurpose, type LightEntity } from '@home-hub/shared';
import { sendCommand } from '../../lib/actions.ts';
import { useHub } from '../../store/hub.ts';
import { useCan, useIsAdmin } from '../../store/session.ts';
import { EntitySheet } from '../entities/sheets.tsx';
import { EntityRow } from '../home/rows.tsx';
import { Badge, Button, Row, Sheet } from '../ui.tsx';

/** What a zone of the alarm system watches (hubs before 0.7 do not say: recognised from its name). */
export function purposeOf(alarm: AlarmEntity): AlarmPurpose {
  return alarm.purpose ?? alarmPurpose(`${alarm.name} ${alarm.system}`);
}

/** Lights that are on, without the ones the lighting watch leaves out. */
export function useWatchedLightsOn(): LightEntity[] {
  const entities = useHub((state) => state.entities);
  const excluded = useHub((state) => state.layout.lightWatchExcluded);
  return useMemo(() => {
    const out = new Set(excluded ?? []);
    return Object.values(entities)
      .filter((entity): entity is LightEntity => entity.kind === 'light' && !entity.isGroup && entity.on && entity.available && !out.has(entity.id))
      .sort((a, b) => (a.room ?? '').localeCompare(b.room ?? '', 'de') || a.name.localeCompare(b.name, 'de', { numeric: true }));
  }, [entities, excluded]);
}

/** The lights grouped by room, in the order they come (already sorted by room). */
function byRoom(lights: LightEntity[]): [string, LightEntity[]][] {
  const groups = new Map<string, LightEntity[]>();
  for (const light of lights) {
    const room = light.room ?? 'Ohne Raum';
    groups.set(room, [...(groups.get(room) ?? []), light]);
  }
  return [...groups.entries()];
}

/** "Decke (Küche)": a light's name with its room, unless the name says it already. */
export function lightWithRoom(light: LightEntity): string {
  if (!light.room || light.name.toLowerCase().includes(light.room.toLowerCase())) return light.name;
  return `${light.name} (${light.room})`;
}

/**
 * Only the lights that are on, by room — switched off one by one, and (where `allOff` allows it) all
 * at once. The start page's status tile leaves "all at once" out on purpose.
 */
export function LightsOnSheet({ title, open, onClose, lights, allOff = true }: { title: string; open: boolean; onClose(): void; lights: LightEntity[]; allOff?: boolean }) {
  const canControl = useCan('home.control');
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [details, setDetails] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={lights.length === 0 ? 'Alle Lichter sind aus' : `${lights.length} ${lights.length === 1 ? 'Licht ist' : 'Lichter sind'} an`}
      footer={
        allOff && canControl && lights.length > 1 ? (
          <Button block icon={Power} onClick={() => lights.forEach((light) => void sendCommand(light, { action: 'turn_off' }, { on: false }))}>
            Alle ausschalten
          </Button>
        ) : undefined
      }
    >
      {lights.length > 0 ? (
        <div className="flex flex-col gap-4">
          {byRoom(lights).map(([room, list]) => (
            <div key={room}>
              <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-faint">{room}</p>
              <div className="divide-y divide-line/70 overflow-hidden rounded-tile bg-sunken">
                {list.map((light) => (
                  <EntityRow key={light.id} entity={light} room={light.room ?? undefined} onDetails={setDetails} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-control bg-sunken px-4 py-3 text-sm text-muted">
          <Lightbulb className="size-4.5" aria-hidden />
          {allOff ? 'Kein überwachtes Licht ist an.' : 'Kein Licht ist an.'}
        </p>
      )}
      {!allOff && (
        <Button
          size="sm"
          variant="ghost"
          icon={Lightbulb}
          className="mt-3"
          onClick={() => {
            onClose();
            navigate('/licht');
          }}
        >
          Alle Lichter ansehen
        </Button>
      )}
      {allOff && isAdmin && (
        <Button
          size="sm"
          variant="ghost"
          icon={SlidersHorizontal}
          className="mt-3"
          onClick={() => {
            onClose();
            navigate('/einstellungen/lichtueberwachung');
          }}
        >
          Lichter von der Überwachung ausnehmen
        </Button>
      )}
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </Sheet>
  );
}

/**
 * The zone of the alarm system that watches the lights ("Status Beleuchtung"): shown with what the
 * app knows itself — which lights are on, without the ones left out — and opened to switch them off.
 */
export function LightWatchRow({ alarm }: { alarm: AlarmEntity }) {
  const lights = useWatchedLightsOn();
  const [open, setOpen] = useState(false);
  const state = alarm.mode === 'armed' ? 'Scharf' : alarm.mode === 'disarmed' ? 'Unscharf' : 'Status unbekannt';
  const subtitle =
    lights.length === 0
      ? `${state} · alle Lichter aus`
      : `${state} · ${lights.length === 1 ? '1 Licht' : `${lights.length} Lichter`} an: ${lights
          .slice(0, 3)
          .map(lightWithRoom)
          .join(', ')}${lights.length > 3 ? ' …' : ''}`;
  return (
    <>
      <Row
        icon={Lightbulb}
        tone={alarm.triggered ? 'danger' : lights.length > 0 ? 'warm' : 'ok'}
        title={alarm.name}
        subtitle={<span className="whitespace-normal">{subtitle}</span>}
        trailing={<Badge tone={alarm.mode === 'armed' ? 'accent' : 'neutral'}>{alarm.mode === 'armed' ? 'Scharf' : alarm.mode === 'disarmed' ? 'Unscharf' : 'Unbekannt'}</Badge>}
        onClick={() => setOpen(true)}
      />
      <LightsOnSheet title={alarm.name} open={open} onClose={() => setOpen(false)} lights={lights} />
    </>
  );
}
