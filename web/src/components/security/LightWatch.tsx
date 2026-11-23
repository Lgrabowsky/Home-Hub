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

/** Only the lights that are on — switched off one by one or all at once. */
function LightsOnSheet({ title, open, onClose }: { title: string; open: boolean; onClose(): void }) {
  const lights = useWatchedLightsOn();
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
        canControl && lights.length > 1 ? (
          <Button block icon={Power} onClick={() => lights.forEach((light) => void sendCommand(light, { action: 'turn_off' }, { on: false }))}>
            Alle ausschalten
          </Button>
        ) : undefined
      }
    >
      {lights.length > 0 ? (
        <div className="divide-y divide-line/70 overflow-hidden rounded-tile bg-sunken">
          {lights.map((light) => (
            <EntityRow key={light.id} entity={light} title={light.name} room={light.room ?? undefined} onDetails={setDetails} />
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-control bg-sunken px-4 py-3 text-sm text-muted">
          <Lightbulb className="size-4.5" aria-hidden />
          Kein überwachtes Licht ist an.
        </p>
      )}
      {isAdmin && (
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
          .map((light) => light.name)
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
      <LightsOnSheet title={alarm.name} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
