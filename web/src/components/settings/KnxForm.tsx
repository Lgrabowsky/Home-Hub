import { DoorClosed, DoorOpen, Network, Pencil, Plus, Radar, Search, Trash2, Warehouse, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addRoom, knxContactNames, type ContactType, type KnxContactSetting, type KnxInterfaceInfo, type KnxTelegramInfo, type KnxTelegramsResponse } from '@home-hub/shared';
import { errorMessage, get, post } from '../../lib/api.ts';
import { editableLayout, saveLayout } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { RoomField, type RoomChoice } from '../layout/DeviceEditor.tsx';
import { toast } from '../toast.tsx';
import { Badge, Button, Card, cx, Field, Notice, Row, RowGroup, Section, Segmented, Select, Sheet, TextInput, Toggle } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { HowTo, NumberInput, SwitchRow, uniqueId } from './parts.tsx';

const TYPE_LABELS: Record<ContactType, string> = { window: 'Fenster', door: 'Tür', garage: 'Garage', motion: 'Bewegungsmelder', other: 'Sonstiges' };
const TYPE_ICONS: Record<ContactType, LucideIcon> = { window: DoorClosed, door: DoorOpen, garage: Warehouse, motion: Radar, other: DoorClosed };
const GROUP_ADDRESS = /^\s*(\d{1,2})\/(\d)\/(\d{1,3})\s*$/;

function validAddress(text: string): boolean {
  const match = GROUP_ADDRESS.exec(text);
  if (!match) return false;
  const [main, middle, sub] = match.slice(1).map(Number) as [number, number, number];
  return main <= 31 && middle <= 7 && sub <= 255;
}

// --- One contact --------------------------------------------------------------------------------------

/** A room to create together with the contact (it then appears under Räume in that area). */
interface NewRoom {
  name: string;
  area: string;
}

function ContactSheet({
  contact,
  isNew,
  onClose,
  onApply,
  onRemove,
}: {
  contact: KnxContactSetting;
  isNew: boolean;
  onClose(): void;
  onApply(contact: KnxContactSetting, newRoom: NewRoom | null): void;
  onRemove(): void;
}) {
  const [draft, setDraft] = useState(contact);
  const [room, setRoom] = useState<RoomChoice>({ kind: 'room', room: contact.room.trim() || null });
  const [touched, setTouched] = useState(false);
  const set = (changes: Partial<KnxContactSetting>) => setDraft({ ...draft, ...changes });
  const roomName = room.kind === 'room' ? (room.room ?? '') : room.name.trim();
  const automaticName = knxContactNames([{ ...draft, name: '', room: roomName }]).get(draft.id) ?? '';
  const addressError = touched && !validAddress(draft.address) ? 'Erwartet wird eine Gruppenadresse wie 1/2/3.' : null;
  const roomError = touched && room.kind === 'new' && !room.name.trim() ? 'Bitte gib dem neuen Raum einen Namen.' : null;
  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? 'KNX-Kontakt hinzufügen' : draft.name.trim() || automaticName || 'KNX-Kontakt'}
      footer={
        <div className="flex gap-2">
          {!isNew && (
            <Button variant="danger" icon={Trash2} onClick={onRemove}>
              Entfernen
            </Button>
          )}
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              setTouched(true);
              if (!validAddress(draft.address) || (room.kind === 'new' && !room.name.trim())) return;
              onApply({ ...draft, name: draft.name.trim(), room: roomName, address: draft.address.trim() }, room.kind === 'new' ? { name: room.name.trim(), area: room.area } : null);
            }}
          >
            Übernehmen
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RoomField value={room} onChange={setRoom} hint={roomError ?? undefined} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Art">
            <Select value={draft.contactType} onChange={(event) => set({ contactType: event.target.value as ContactType })}>
              {(Object.keys(TYPE_LABELS) as ContactType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name (optional)">
            <TextInput value={draft.name} maxLength={60} placeholder={automaticName} onChange={(event) => set({ name: event.target.value })} />
          </Field>
        </div>
        <p className="-mt-2 text-sm text-faint">Ohne eigenen Namen heißt der Kontakt „{automaticName}“.</p>
        <Field label="Gruppenadresse" error={addressError} hint="Die Adresse, an die der Kontakt (Binäreingang) seinen Zustand sendet.">
          <TextInput value={draft.address} placeholder="1/2/3" inputMode="numeric" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono" onChange={(event) => set({ address: event.target.value })} />
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-control bg-sunken p-3.5">
          <div>
            <p className="font-medium">Umgekehrt</p>
            <p className="text-sm text-muted">Der Kontakt sendet 0 für offen und 1 für zu.</p>
          </div>
          <Toggle checked={draft.invert} label="Umgekehrt" onChange={(invert) => set({ invert })} />
        </div>
      </div>
    </Sheet>
  );
}

// --- Finding contacts on the bus --------------------------------------------------------------------

interface Seen {
  address: string;
  value: number;
  /** The value before the last change (null: only one telegram so far). */
  before: number | null;
  ts: number;
  source: string;
  count: number;
}

/** Listens along: the group addresses that carry a single bit, newest change first. */
function SearchSheet({ open, onClose, known, onPick }: { open: boolean; onClose(): void; known: Set<string>; onPick(address: string, invert: boolean): void }) {
  const [startedAt, setStartedAt] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (open) setStartedAt(Date.now() - 1000);
  }, [open]);
  const query = useQuery({
    queryKey: ['knx-telegrams', startedAt],
    queryFn: () => get<KnxTelegramsResponse>(`/api/admin/knx/telegrams?since=${startedAt}`),
    enabled: open && startedAt > 0,
    refetchInterval: 1000,
  });
  const telegrams: KnxTelegramInfo[] = useMemo(() => query.data?.telegrams ?? [], [query.data]);
  const bits = useMemo(() => {
    const byAddress = new Map<string, Seen>();
    for (const telegram of telegrams) {
      if (telegram.service === 'read' || telegram.value === null || telegram.value > 1) continue;
      const before = byAddress.get(telegram.address);
      byAddress.set(telegram.address, {
        address: telegram.address,
        value: telegram.value,
        before: before ? before.value : null,
        ts: telegram.ts,
        source: telegram.source,
        count: (before?.count ?? 0) + 1,
      });
    }
    return [...byAddress.values()].sort((a, b) => b.ts - a.ts);
  }, [telegrams]);
  const other = telegrams.filter((telegram) => telegram.service !== 'read' && (telegram.value === null || telegram.value > 1)).length;

  return (
    <Sheet open={open} onClose={onClose} wide title="KNX-Kontakt suchen" subtitle="Der Hub hört mit, was auf dem KNX-Bus passiert">
      {query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start gap-3 rounded-control bg-accent/15 px-3.5 py-3">
            <span className="relative mt-1 flex size-3 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex size-3 rounded-full bg-accent" />
            </span>
            <p className="text-sm">
              <span className="font-medium">Öffne jetzt das Fenster oder die Tür</span> und lass sie offen, bis du „Das ist es“ antippst. Die Gruppenadresse, die dabei umspringt, erscheint hier.
            </p>
          </div>
          {query.data && !query.data.connected && <Notice tone="warn">{query.data.message || 'Keine Verbindung zum KNX-Bus.'}</Notice>}

          <section aria-live="polite">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Gehört (Ein/Aus-Werte)</h3>
            {bits.length === 0 ? (
              <p className="rounded-control bg-sunken px-3.5 py-3 text-sm text-muted">{query.isPending ? 'Verbinde …' : 'Noch nichts gehört.'}</p>
            ) : (
              <ul className="space-y-2">
                {bits.map((entry) => {
                  const mapped = known.has(entry.address);
                  return (
                    <li key={entry.address} className={cx('flex items-center gap-3 rounded-control px-3.5 py-2.5', entry.before !== null && entry.before !== entry.value ? 'animate-pop bg-warn/15' : 'bg-sunken')}>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono font-medium">{entry.address}</p>
                        <p className="truncate text-sm text-muted">
                          {entry.before !== null && entry.before !== entry.value ? `${entry.before} → ${entry.value}` : `zuletzt ${entry.value}`} · {entry.count}× · von {entry.source}
                        </p>
                      </div>
                      {mapped ? (
                        <Badge tone="ok">Schon angelegt</Badge>
                      ) : (
                        <Button size="sm" variant="primary" onClick={() => onPick(entry.address, entry.value === 0)} aria-label={`${entry.address}: Das ist es`}>
                          Das ist es
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 text-xs text-faint">„Das ist es“ übernimmt die Adresse. Zeigt sie bei offenem Fenster 0, wird „Umgekehrt“ gleich mit eingeschaltet.</p>
          </section>

          {other > 0 && (
            <section>
              <button type="button" className="text-sm font-medium text-accent hover:underline" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Andere Telegramme ausblenden' : `${other} andere Telegramme (Temperaturen, Dimmwerte …)`}
              </button>
              {showAll && (
                <ul className="mt-2 divide-y divide-line rounded-control bg-sunken font-mono text-[13px]">
                  {telegrams
                    .filter((telegram) => telegram.service !== 'read' && (telegram.value === null || telegram.value > 1))
                    .slice(-30)
                    .reverse()
                    .map((telegram) => (
                      <li key={`${telegram.ts}-${telegram.address}-${telegram.data}`} className="flex gap-3 px-3.5 py-2">
                        <span className="w-20 shrink-0">{telegram.address}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{telegram.data || telegram.value}</span>
                        <span className="text-faint">{telegram.source}</span>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}

// --- Finding the interface --------------------------------------------------------------------------

function InterfaceSearch({ onPick }: { onPick(found: KnxInterfaceInfo): void }) {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<KnxInterfaceInfo[] | null>(null);
  const search = async () => {
    setBusy(true);
    try {
      setFound((await post<{ interfaces: KnxInterfaceInfo[] }>('/api/admin/knx/search')).interfaces);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button size="sm" icon={Search} loading={busy} onClick={() => void search()}>
        Im Netz suchen
      </Button>
      {found && found.length === 0 && <p className="mt-2 text-sm text-muted">Nichts gefunden. Trag die IP-Adresse der KNX IP-Schnittstelle von Hand ein (steht im Router oder in der ETS).</p>}
      {found && found.length > 0 && (
        <RowGroup className="mt-2.5 bg-sunken shadow-none">
          {found.map((entry) => (
            <Row
              key={`${entry.host}:${entry.port}`}
              icon={Network}
              tone="accent"
              title={entry.name}
              subtitle={`${entry.host} · ${entry.address}${entry.routing ? ' · Router' : ''}`}
              trailing={<span className="font-medium text-accent">Übernehmen</span>}
              onClick={() => onPick(entry)}
            />
          ))}
        </RowGroup>
      )}
    </div>
  );
}

// --- The form ------------------------------------------------------------------------------------------

export function KnxForm({ value, saved, onChange, dirty }: FormProps<'knx'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const health = useHub((state) => state.services.knx);
  const [editing, setEditing] = useState<{ contact: KnxContactSetting; isNew: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const known = useMemo(() => new Set(value.contacts.map((contact) => contact.address.trim())), [value.contacts]);
  // Listening needs the connection that is saved and running, not the one in the form.
  const canListen = saved.enabled && health?.status === 'ok' && saved.mode === value.mode && saved.host === value.host && saved.port === value.port;

  const names = useMemo(() => knxContactNames(value.contacts), [value.contacts]);
  const blank = (address = '', invert = false): KnxContactSetting => ({ id: '', address, name: '', room: '', contactType: 'window', invert });
  const apply = (contact: KnxContactSetting, isNew: boolean, newRoom: NewRoom | null) => {
    const others = value.contacts.filter((entry) => entry.id !== contact.id || isNew);
    // Named after the group address: stays the same when the name or room changes later.
    const id = isNew ? uniqueId(`ga ${contact.address}`, others.map((entry) => entry.id), 'kontakt') : contact.id;
    set({ contacts: isNew ? [...value.contacts, { ...contact, id }] : value.contacts.map((entry) => (entry.id === contact.id ? contact : entry)) });
    setEditing(null);
    // A new room goes into its area right away (it shows up under Räume once the contact is saved).
    if (newRoom && newRoom.area) void saveLayout(addRoom(editableLayout(), newRoom.area, newRoom.name), `Raum „${newRoom.name}“ angelegt`);
  };

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="KNX verwenden" subtitle="Fenster- und Türkontakte direkt am KNX-Bus mithören." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="warm" />
        </RowGroup>
      </Section>

      <Section title="Verbindung zum KNX-Bus">
        <HowTo
          title="Was es braucht"
          steps={[
            <>Eine <strong>KNX IP-Schnittstelle</strong> oder einen <strong>KNX IP-Router</strong> im Heimnetz (oft schon vorhanden, z. B. für die ETS oder den myGEKKO).</>,
            <>Schnittstelle: Der Hub belegt eine ihrer Verbindungen („Tunnel“). Sind alle belegt, meldet er das.</>,
            <>Der Hub hört nur mit und fragt Zustände ab – er schaltet nichts auf dem Bus. Mit KNX Secure verschlüsselte Telegramme kann er nicht lesen.</>,
          ]}
        />
        <Card className="space-y-4 p-4">
          <div>
            <p className="mb-1.5 text-sm font-medium">Verbindungsart</p>
            <Segmented
              value={value.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 'tunnel', label: 'IP-Schnittstelle' },
                { value: 'routing', label: 'IP-Router' },
              ]}
            />
            <p className="mt-1.5 text-sm text-faint">{value.mode === 'tunnel' ? 'Tunnel: funktioniert mit jeder KNX IP-Schnittstelle und jedem KNX IP-Router.' : 'Routing: nur mit einem KNX IP-Router. Der Hub hört die Telegramme im Netz mit, ohne eine Verbindung zu belegen.'}</p>
          </div>
          {value.mode === 'tunnel' && (
            <>
              <div className="grid grid-cols-[1fr_6.5rem] gap-3">
                <Field label="Adresse der Schnittstelle">
                  <TextInput value={value.host} placeholder="192.168.1.30" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => set({ host: event.target.value.trim() })} />
                </Field>
                <Field label="Port">
                  <NumberInput value={value.port} min={1} max={65535} fallback={3671} onChange={(port) => set({ port })} />
                </Field>
              </div>
              <InterfaceSearch onPick={(found) => set({ host: found.host, port: found.port })} />
            </>
          )}
        </Card>
      </Section>

      <Section title="Fenster- und Türkontakte">
        {value.contacts.length > 0 ? (
          <RowGroup>
            {value.contacts.map((contact) => {
              const Icon = TYPE_ICONS[contact.contactType];
              return (
                <Row
                  key={contact.id}
                  icon={Icon}
                  title={names.get(contact.id) ?? contact.address}
                  subtitle={[contact.address, contact.room, contact.invert ? 'umgekehrt' : null].filter(Boolean).join(' · ')}
                  trailing={<Pencil className="size-4 text-faint" aria-hidden />}
                  onClick={() => setEditing({ contact, isNew: false })}
                />
              );
            })}
          </RowGroup>
        ) : (
          <p className="px-1 text-sm text-muted">Noch keine Kontakte. Mit „Kontakt suchen“ findest du heraus, welche Gruppenadresse zu welchem Fenster gehört.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button icon={Radar} variant={canListen ? 'primary' : 'secondary'} disabled={!canListen} onClick={() => setSearching(true)}>
            Kontakt suchen
          </Button>
          <Button icon={Plus} variant="ghost" onClick={() => setEditing({ contact: blank(), isNew: true })}>
            Von Hand hinzufügen
          </Button>
        </div>
        {!canListen && (
          <p className="mt-2 px-1 text-sm text-faint">
            {dirty && saved.enabled ? 'Erst speichern – dann hört der Hub über die neue Verbindung mit.' : saved.enabled ? (health?.message ?? 'Der Hub verbindet sich gerade mit dem KNX-Bus …') : 'Zum Suchen KNX einschalten, die Verbindung eintragen und speichern.'}
          </p>
        )}
        {dirty && value.contacts.length !== saved.contacts.length && <Notice className="mt-3">Neue Kontakte erscheinen nach dem Speichern.</Notice>}
      </Section>

      {editing && (
        <ContactSheet
          key={editing.contact.id || 'new'}
          contact={editing.contact}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onApply={(contact, newRoom) => apply(contact, editing.isNew, newRoom)}
          onRemove={() => {
            set({ contacts: value.contacts.filter((entry) => entry.id !== editing.contact.id) });
            setEditing(null);
          }}
        />
      )}
      <SearchSheet
        open={searching}
        onClose={() => setSearching(false)}
        known={known}
        onPick={(address, invert) => {
          setSearching(false);
          setEditing({ contact: blank(address, invert), isNew: true });
        }}
      />
    </>
  );
}
