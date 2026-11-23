import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, Moon, Play, Plus, Sun, Sunrise, Sunset, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ClimateEntity, ClockEntity, Entity, EntityCommand, HubTimer, HubTimerInput, TimerAt, TimersResponse } from '@home-hub/shared';
import { CLOCK_MODE_TEXT } from '../../components/entities/EntityTile.tsx';
import { entityIcon } from '../../components/entities/icons.ts';
import { EntitySheet } from '../../components/entities/sheets.tsx';
import { toast } from '../../components/toast.tsx';
import { Button, ConfirmDialog, cx, Field, IconButton, Notice, Row, RowGroup, Section, Segmented, Sheet, TextInput, Toggle } from '../../components/ui.tsx';
import { useAllEntities } from '../../hooks/entities.ts';
import { del, errorMessage, get, post, put } from '../../lib/api.ts';
import { formatNumber } from '../../lib/format.ts';

// --- words --------------------------------------------------------------------------------------

const DAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function describeDays(days: number[]): string {
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '1,2,3,4,5,6,7') return 'Täglich';
  if (set === '1,2,3,4,5') return 'Mo–Fr';
  if (set === '6,7') return 'Sa, So';
  if (days.length === 0) return 'Kein Tag gewählt';
  return days.map((day) => DAY_SHORT[day]).join(', ');
}

export function describeAt(at: TimerAt): string {
  if (at.kind === 'time') return `${at.time} Uhr`;
  const event = at.kind === 'sunrise' ? 'Sonnenaufgang' : 'Sonnenuntergang';
  if (at.offset === 0) return event;
  return `${Math.abs(at.offset)} Min. ${at.offset < 0 ? 'vor' : 'nach'} ${event}`;
}

const CLIMATE_MODE_WORDS: Partial<Record<ClimateEntity['mode'], string>> = { comfort: 'Komfort', reduced: 'Absenkung', off: 'Aus', standby: 'Standby', manual: 'Manuell' };

export function describeCommand(command: EntityCommand): string {
  switch (command.action) {
    case 'turn_on':
      return 'Ein';
    case 'turn_off':
      return 'Aus';
    case 'toggle':
      return 'Umschalten';
    case 'set_brightness':
      return `Helligkeit ${command.value} %`;
    case 'up':
      return 'Hoch';
    case 'down':
      return 'Runter';
    case 'stop':
      return 'Anhalten';
    case 'set_position':
      return `Position ${command.value} %`;
    case 'set_target':
      return `Soll ${formatNumber(command.value)} °C`;
    case 'set_mode':
      return CLIMATE_MODE_WORDS[command.value] ?? command.value;
    case 'run':
      return 'Starten';
    case 'set_clock_mode':
      return `Modus: ${CLOCK_MODE_TEXT[command.value]}`;
    default:
      return command.action;
  }
}

function describeNext(at: number | null): string | null {
  if (at === null) return null;
  const date = new Date(at);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `heute ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `morgen ${time}`;
  return `${date.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
}

/** Which commands a device offers in a time switch. */
function commandChoices(entity: Entity): { label: string; command: EntityCommand }[] {
  switch (entity.kind) {
    case 'light':
      return [
        { label: 'Ein', command: { action: 'turn_on' } },
        { label: 'Aus', command: { action: 'turn_off' } },
        ...(entity.features.dim ? [25, 50, 75].map((value) => ({ label: `${value} %`, command: { action: 'set_brightness', value } as EntityCommand })) : []),
      ];
    case 'switch':
      return [
        { label: 'Ein', command: { action: 'turn_on' } },
        { label: 'Aus', command: { action: 'turn_off' } },
      ];
    case 'blind':
      return [
        { label: 'Hoch', command: { action: 'up' } },
        { label: 'Runter', command: { action: 'down' } },
        ...(entity.features.position ? [50, 75].map((value) => ({ label: `${value} % zu`, command: { action: 'set_position', value } as EntityCommand })) : []),
      ];
    case 'climate':
      return [
        ...(entity.features.target ? [18, 20, 21, 22].map((value) => ({ label: `${value} °C`, command: { action: 'set_target', value } as EntityCommand })) : []),
        ...(entity.features.mode
          ? (['comfort', 'reduced', 'off'] as const).map((value) => ({ label: CLIMATE_MODE_WORDS[value]!, command: { action: 'set_mode', value } as EntityCommand }))
          : []),
      ];
    case 'action':
      return [{ label: 'Starten', command: { action: 'run' } }];
    case 'clock':
      return entity.features.modes.map((value) => ({ label: CLOCK_MODE_TEXT[value], command: { action: 'set_clock_mode', value } as EntityCommand }));
    default:
      return [];
  }
}

const TIMER_KINDS = new Set(['light', 'switch', 'blind', 'climate', 'action', 'clock']);

// --- list ---------------------------------------------------------------------------------------

export function useTimers() {
  return useQuery({ queryKey: ['timers'], queryFn: () => get<TimersResponse>('/api/timers'), refetchInterval: 60_000 });
}

/** The hub's time switches and the controller's clocks, for the "Aktionen" page. */
export function TimersSection({ canControl }: { canControl: boolean }) {
  const query = useTimers();
  const queryClient = useQueryClient();
  const all = useAllEntities();
  const clocks = all.filter((entity): entity is ClockEntity => entity.kind === 'clock');
  const [editing, setEditing] = useState<HubTimer | 'new' | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const entities = useMemo(() => new Map(all.map((entity) => [entity.id, entity])), [all]);

  const data = query.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['timers'] });
  const toggle = async (timer: HubTimer) => {
    try {
      await put(`/api/timers/${timer.id}`, { name: timer.name, enabled: !timer.enabled, days: timer.days, at: timer.at, actions: timer.actions });
      refresh();
    } catch (err) {
      toast.fromError(err);
    }
  };

  return (
    <>
      <Section
        title="Zeitschaltuhren"
        action={
          data?.canEdit && (
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setEditing('new')}>
              Neu
            </Button>
          )
        }
      >
        {query.isError && <Notice tone="danger">{errorMessage(query.error)}</Notice>}
        {data && data.timers.length === 0 && (
          <p className="px-1 text-sm text-muted">
            Zeitschaltuhren des Hubs schalten Licht, Jalousien, Heizung, Geräte und Szenen zu festen Zeiten oder mit der Sonne – an den Tagen, die du wählst.
            {data.canEdit ? ' Lege mit „Neu“ die erste an.' : ''}
          </p>
        )}
        {data && data.timers.length > 0 && (
          <RowGroup>
            {data.timers.map((timer) => {
              const next = describeNext(timer.nextRunAt);
              const targets = timer.actions
                .map((action) => entities.get(action.entityId)?.name)
                .filter(Boolean)
                .slice(0, 2)
                .join(', ');
              return (
                <Row
                  key={timer.id}
                  icon={timer.at.kind === 'sunrise' ? Sunrise : timer.at.kind === 'sunset' ? Sunset : CalendarClock}
                  tone={timer.enabled ? 'accent' : 'neutral'}
                  title={timer.name}
                  subtitle={
                    <>
                      {describeDays(timer.days)} · {describeAt(timer.at)}
                      {targets ? ` · ${targets}${timer.actions.length > 2 ? ' …' : ''}` : ''}
                      {timer.enabled && next ? <span className="block text-faint">Nächstes Mal {next}</span> : null}
                      {timer.lastOk === false && timer.lastResult ? <span className="block text-danger">{timer.lastResult}</span> : null}
                    </>
                  }
                  trailing={
                    <span className="flex items-center gap-1.5">
                      <Toggle checked={timer.enabled} disabled={!data.canEdit} label={`${timer.name} ${timer.enabled ? 'pausieren' : 'aktivieren'}`} onChange={() => void toggle(timer)} />
                      {data.canEdit && (
                        <IconButton icon={ChevronRight} size="sm" label={`${timer.name} bearbeiten`} onClick={() => setEditing(timer)} />
                      )}
                    </span>
                  }
                />
              );
            })}
          </RowGroup>
        )}
        {data && !data.located && data.timers.some((timer) => timer.at.kind !== 'time') && (
          <Notice className="mt-3" icon={Sun}>
            Für Sonnenauf- und -untergang ist der Standort des Hauses noch nicht eingestellt (Einstellungen › Geräte & Dienste › Allgemein). Bis dahin rechnet der Hub mit der Mitte Deutschlands.
          </Notice>
        )}
        <p className="mt-2 px-1 text-xs text-faint">Zeitschaltuhren des Hubs schalten, solange der Hub läuft.</p>
      </Section>

      {clocks.length > 0 && (
        <Section title="Zeitschaltuhren am myGEKKO">
          <RowGroup>
            {clocks.map((clock) => (
              <Row
                key={clock.id}
                icon={CalendarClock}
                tone={clock.mode === 'off' || clock.enabled === false ? 'neutral' : 'accent'}
                className={clock.available ? undefined : 'opacity-60'}
                title={clock.name}
                subtitle={!clock.available ? 'Nicht erreichbar' : [clock.room, clock.mode ? CLOCK_MODE_TEXT[clock.mode] : clock.enabled === false ? 'Pausiert' : 'Aktiv'].filter(Boolean).join(' · ')}
                trailing={<ChevronRight className="size-4.5 text-faint" aria-hidden />}
                onClick={() => setDetails(clock.id)}
              />
            ))}
          </RowGroup>
          <p className="mt-2 px-1 text-xs text-faint">Die Schaltzeiten dieser Uhren werden am myGEKKO eingestellt; hier wählst du Aus, Ein oder Automatik.</p>
        </Section>
      )}

      {editing && <TimerEditor key={editing === 'new' ? 'new' : editing.id} timer={editing === 'new' ? null : editing} canControl={canControl} onClose={() => setEditing(null)} onSaved={refresh} />}
      <EntitySheet entityId={details} onClose={() => setDetails(null)} />
    </>
  );
}

// --- editor -------------------------------------------------------------------------------------

const EMPTY: HubTimerInput = { name: '', enabled: true, days: [1, 2, 3, 4, 5, 6, 7], at: { kind: 'time', time: '07:00' }, actions: [] };

function TimerEditor({ timer, canControl, onClose, onSaved }: { timer: HubTimer | null; canControl: boolean; onClose(): void; onSaved(): void }) {
  const [draft, setDraft] = useState<HubTimerInput>(timer ? { name: timer.name, enabled: timer.enabled, days: timer.days, at: timer.at, actions: timer.actions } : EMPTY);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = useAllEntities();
  const entities = useMemo(() => new Map(all.map((entity) => [entity.id, entity])), [all]);

  const set = (patch: Partial<HubTimerInput>) => setDraft((current) => ({ ...current, ...patch }));
  const toggleDay = (day: number) => set({ days: draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort((a, b) => a - b) });
  const kind = draft.at.kind;
  const offset = draft.at.kind === 'time' ? 0 : draft.at.offset;

  const save = async () => {
    setError(null);
    const name = draft.name.trim() || (draft.actions[0] ? `${entities.get(draft.actions[0].entityId)?.name ?? 'Zeitschaltuhr'} · ${describeAt(draft.at)}` : '');
    if (!name) return setError('Bitte einen Namen eingeben.');
    if (draft.days.length === 0) return setError('Bitte mindestens einen Tag wählen.');
    if (draft.actions.length === 0) return setError('Bitte mindestens eine Aktion hinzufügen.');
    setSaving(true);
    try {
      const body = { ...draft, name };
      if (timer) await put(`/api/timers/${timer.id}`, body);
      else await post('/api/timers', body);
      toast.success('Zeitschaltuhr gespeichert');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!timer) return;
    try {
      const { timer: result } = await post<{ timer: HubTimer }>(`/api/timers/${timer.id}/run`);
      if (result.lastOk) toast.success('Ausgeführt');
      else toast.error(result.lastResult ?? 'Das hat nicht geklappt.');
      onSaved();
    } catch (err) {
      toast.fromError(err);
    }
  };

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={timer ? 'Zeitschaltuhr bearbeiten' : 'Neue Zeitschaltuhr'}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {timer && <IconButton icon={Trash2} label="Zeitschaltuhr löschen" onClick={() => setRemoving(true)} className="text-danger" />}
            {timer && canControl && (
              <Button size="sm" variant="ghost" icon={Play} onClick={() => void runNow()}>
                Jetzt ausführen
              </Button>
            )}
            <Button variant="primary" loading={saving} onClick={() => void save()} className="ml-auto">
              Speichern
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Name">
            <TextInput value={draft.name} maxLength={60} placeholder="z. B. Jalousien morgens hoch" onChange={(event) => set({ name: event.target.value })} />
          </Field>

          <div>
            <p className="mb-1.5 text-sm font-medium text-muted">Wann</p>
            <Segmented<TimerAt['kind']>
              value={kind}
              onChange={(next) => set({ at: next === 'time' ? { kind: 'time', time: draft.at.kind === 'time' ? draft.at.time : '07:00' } : { kind: next, offset } })}
              options={[
                { value: 'time', label: 'Uhrzeit' },
                { value: 'sunrise', label: 'Sonnenaufgang' },
                { value: 'sunset', label: 'Sonnenuntergang' },
              ]}
              className="w-full [&>button]:flex-1"
            />
            {draft.at.kind === 'time' ? (
              <TextInput type="time" aria-label="Uhrzeit" value={draft.at.time} onChange={(event) => event.target.value && set({ at: { kind: 'time', time: event.target.value.slice(0, 5) } })} className="mt-2.5 max-w-40 tabular-nums" />
            ) : (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Segmented<string>
                  value={String(offset)}
                  onChange={(value) => set({ at: { kind: draft.at.kind as 'sunrise' | 'sunset', offset: Number(value) } })}
                  options={['-60', '-30', '0', '15', '30', '60'].map((value) => ({ value, label: value === '0' ? 'genau' : `${Number(value) > 0 ? '+' : '−'}${Math.abs(Number(value))} Min.` }))}
                />
                <span className="text-sm text-muted">{describeAt(draft.at)}</span>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-muted">An diesen Tagen</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Wochentage">
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={draft.days.includes(day)}
                  onClick={() => toggleDay(day)}
                  className={cx('size-11 rounded-full text-sm font-semibold transition', draft.days.includes(day) ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg')}
                >
                  {DAY_SHORT[day]}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-sm">
              {(
                [
                  ['Täglich', [1, 2, 3, 4, 5, 6, 7]],
                  ['Werktags', [1, 2, 3, 4, 5]],
                  ['Wochenende', [6, 7]],
                ] as const
              ).map(([label, days]) => (
                <button key={label} type="button" onClick={() => set({ days: [...days] })} className="rounded-full px-2.5 py-1 text-accent hover:bg-accent/10">
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-muted">Das passiert</p>
            {draft.actions.length > 0 && (
              <RowGroup className="mb-2.5">
                {draft.actions.map((action, index) => {
                  const entity = entities.get(action.entityId);
                  const choices = entity ? commandChoices(entity) : [];
                  return (
                    <div key={`${action.entityId}-${index}`} className="flex flex-col gap-2 px-3.5 py-3">
                      <div className="flex items-center gap-2.5">
                        {entity ? (() => {
                          const Icon = entityIcon(entity);
                          return <Icon className="size-4.5 shrink-0 text-muted" aria-hidden />;
                        })() : null}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {entity ? `${entity.name}${entity.room && !entity.name.includes(entity.room) ? ` · ${entity.room}` : ''}` : 'Gerät fehlt'}
                        </span>
                        <IconButton icon={X} size="sm" label="Aktion entfernen" onClick={() => set({ actions: draft.actions.filter((_, i) => i !== index) })} />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {choices.map((choice) => {
                          const active = JSON.stringify(choice.command) === JSON.stringify(action.command);
                          return (
                            <button
                              key={choice.label}
                              type="button"
                              aria-pressed={active}
                              onClick={() => set({ actions: draft.actions.map((a, i) => (i === index ? { ...a, command: choice.command } : a)) })}
                              className={cx('h-8 rounded-full px-3 text-[13px] font-medium transition', active ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg')}
                            >
                              {choice.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </RowGroup>
            )}
            {draft.actions.length < 20 && (
              <Button size="sm" icon={Plus} onClick={() => setPicking(true)}>
                Aktion hinzufügen
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Aktiv</span>
            <Toggle checked={draft.enabled} label="Zeitschaltuhr aktiv" onChange={(enabled) => set({ enabled })} />
          </div>

          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Sheet>

      <DevicePicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(entity) => {
          const first = commandChoices(entity)[0];
          if (first) set({ actions: [...draft.actions, { entityId: entity.id, command: first.command }] });
          setPicking(false);
        }}
      />

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Zeitschaltuhr löschen?"
        text={timer ? `„${timer.name}“ wird gelöscht.` : undefined}
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          if (!timer) return;
          try {
            await del(`/api/timers/${timer.id}`);
            onSaved();
            onClose();
          } catch (err) {
            toast.fromError(err);
          }
        }}
      />
    </>
  );
}

function DevicePicker({ open, onClose, onPick }: { open: boolean; onClose(): void; onPick(entity: Entity): void }) {
  const all = useAllEntities();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const candidates = all.filter((entity) => TIMER_KINDS.has(entity.kind) && commandChoices(entity).length > 0 && (q === '' || `${entity.name} ${entity.room ?? ''}`.toLowerCase().includes(q)));
  const byRoom = new Map<string, Entity[]>();
  for (const entity of candidates) byRoom.set(entity.room ?? 'Ganzes Haus', [...(byRoom.get(entity.room ?? 'Ganzes Haus') ?? []), entity]);
  return (
    <Sheet open={open} onClose={onClose} title="Gerät wählen">
      <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gerät oder Raum suchen" aria-label="Gerät oder Raum suchen" className="mb-3" />
      <div className="flex flex-col gap-4">
        {[...byRoom.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'de'))
          .map(([room, list]) => (
            <div key={room}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">{room}</p>
              <RowGroup>
                {list.map((entity) => (
                  <Row key={entity.id} icon={entityIcon(entity)} title={entity.name} trailing={<Plus className="size-4.5 text-faint" aria-hidden />} onClick={() => onPick(entity)} />
                ))}
              </RowGroup>
            </div>
          ))}
        {candidates.length === 0 && <p className="text-sm text-muted">Keine passenden Geräte.</p>}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-faint">
        <Moon className="size-3.5" aria-hidden /> Türen, Tore und Kameras schaltet keine Zeitschaltuhr – aus Sicherheitsgründen.
      </p>
    </Sheet>
  );
}
