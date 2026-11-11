import { Cctv, ChevronDown, DoorClosed, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { SECRET_SET, type DoorBirdDeviceSettings, type ReolinkDeviceSettings, type TestResult } from '@home-hub/shared';
import { errorMessage } from '../../lib/api.ts';
import { useHub } from '../../store/hub.ts';
import { Badge, Button, Card, ConfirmDialog, cx, EmptyState, Field, Row, RowGroup, Section, Segmented, Sheet, TextInput, Toggle } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { HowTo, isHost, NumberInput, SecretInput, SwitchRow, TestOutcome, uniqueId } from './parts.tsx';

interface BaseDevice {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  room: string;
}

/** What is wrong with a device as entered; null when it can be handed to the hub. */
function problems(device: BaseDevice): { name?: string; host?: string; username?: string; password?: string } | null {
  const found: ReturnType<typeof problems> = {};
  if (device.name.trim() === '') found.name = 'Bitte gib dem Gerät einen Namen.';
  if (device.host.trim() === '') found.host = 'Bitte trage die Adresse ein.';
  else if (!isHost(device.host)) found.host = 'Nur die IP-Adresse oder den Namen eintragen, ohne http://.';
  if (device.username.trim() === '') found.username = 'Bitte trage den Benutzernamen ein.';
  if (device.password === '') found.password = 'Bitte trage das Passwort ein.';
  return Object.keys(found).length > 0 ? found : null;
}

// --- List ------------------------------------------------------------------------------------------

function DeviceList<D extends BaseDevice>({
  devices,
  savedIds,
  entityPrefix,
  enabled,
  icon,
  emptyTitle,
  emptyText,
  addLabel,
  onAdd,
  onEdit,
}: {
  devices: D[];
  savedIds: Set<string>;
  entityPrefix: 'door' | 'cam';
  enabled: boolean;
  icon: LucideIcon;
  emptyTitle: string;
  emptyText: string;
  addLabel: string;
  onAdd(): void;
  onEdit(index: number): void;
}) {
  const entities = useHub((state) => state.entities);
  const add = (
    <Button icon={Plus} variant={devices.length === 0 ? 'primary' : 'secondary'} onClick={onAdd}>
      {addLabel}
    </Button>
  );
  if (devices.length === 0) {
    return (
      <Card>
        <EmptyState icon={icon} title={emptyTitle} text={emptyText} action={add} />
      </Card>
    );
  }
  return (
    <>
      <RowGroup>
        {devices.map((device, index) => {
          const entity = entities[`${entityPrefix}:${device.id}`];
          const isSaved = savedIds.has(device.id);
          return (
            <Row
              key={device.id}
              icon={icon}
              tone={entity?.available ? 'ok' : 'neutral'}
              title={device.name}
              subtitle={[device.host, device.room].filter(Boolean).join(' · ')}
              trailing={
                !isSaved ? (
                  <Badge tone="accent">Neu</Badge>
                ) : !enabled ? null : entity ? (
                  <Badge tone={entity.available ? 'ok' : 'danger'}>{entity.available ? 'Verbunden' : 'Nicht erreichbar'}</Badge>
                ) : (
                  <Badge>Wird verbunden …</Badge>
                )
              }
              onClick={() => onEdit(index)}
            />
          );
        })}
      </RowGroup>
      <div className="mt-3">{add}</div>
    </>
  );
}

// --- Sheet frame shared by both device kinds ------------------------------------------------------------

function DeviceSheet<D extends BaseDevice>({
  device,
  isNew,
  kindLabel,
  onClose,
  onApply,
  onRemove,
  runTest,
  children,
}: {
  device: D | null;
  isNew: boolean;
  kindLabel: string;
  onClose(): void;
  onApply(device: D): void;
  onRemove(): void;
  runTest(device: D): Promise<TestResult>;
  children(args: { draft: D; set(changes: Partial<D>): void; errors: NonNullable<ReturnType<typeof problems>>; storedPassword: boolean }): ReactNode;
}) {
  const [draft, setDraft] = useState<D | null>(device);
  const [touched, setTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setDraft(device);
    setTouched(false);
    setResult(null);
  }, [device]);
  if (!draft || !device) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;

  const found = problems(draft);
  const errors = touched && found ? found : {};
  const test = async () => {
    setTouched(true);
    if (found) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await runTest(draft));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err), details: [] });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? `${kindLabel} hinzufügen` : device.name}
      footer={
        <div className="space-y-2">
          {result && <TestOutcome result={result} onDismiss={() => setResult(null)} />}
          <div className="flex gap-2">
            {!isNew && <Button variant="danger" icon={Trash2} aria-label="Entfernen" onClick={() => setConfirmRemove(true)} />}
            <Button className="flex-1" loading={testing} onClick={() => void test()}>
              Verbindung testen
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => {
                setTouched(true);
                if (!found) onApply({ ...draft, name: draft.name.trim(), host: draft.host.trim(), username: draft.username.trim(), room: draft.room.trim() });
              }}
            >
              Übernehmen
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {children({ draft, set: (changes) => setDraft({ ...draft, ...changes }), errors, storedPassword: !isNew && device.password === SECRET_SET })}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`${device.name} entfernen?`}
        text="Das Gerät verschwindet aus der App, sobald du die Einstellungen speicherst. Die Zugangsdaten werden dann gelöscht."
        confirmLabel="Entfernen"
        danger
        onConfirm={onRemove}
      />
    </Sheet>
  );
}

function CommonFields<D extends BaseDevice>({ draft, set, errors, storedPassword, hostHint, userHint }: { draft: D; set(changes: Partial<BaseDevice>): void; errors: NonNullable<ReturnType<typeof problems>>; storedPassword: boolean; hostHint: string; userHint: string }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" error={errors.name}>
          <TextInput value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="z. B. Haustür" maxLength={60} />
        </Field>
        <Field label="Raum / Bereich">
          <TextInput value={draft.room} onChange={(event) => set({ room: event.target.value })} placeholder="z. B. Eingang" maxLength={60} />
        </Field>
      </div>
      <Field label="Adresse" hint={hostHint} error={errors.host}>
        <TextInput value={draft.host} onChange={(event) => set({ host: event.target.value })} placeholder="192.168.1.60" autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" />
      </Field>
      <Field label="Benutzername" hint={userHint} error={errors.username}>
        <TextInput value={draft.username} onChange={(event) => set({ username: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Passwort" error={errors.password}>
        <SecretInput value={draft.password} stored={storedPassword} onChange={(password) => set({ password })} />
      </Field>
    </>
  );
}

/** Index of the device being edited; `devices.length` means "a new one". */
function useEditing<D extends BaseDevice>(devices: D[], blank: () => D) {
  const [state, setState] = useState<{ index: number; device: D } | null>(null);
  return {
    device: state?.device ?? null,
    isNew: state !== null && state.index >= devices.length,
    index: state?.index ?? -1,
    add: () => setState({ index: devices.length, device: blank() }),
    edit: (index: number) => {
      const device = devices[index];
      if (device) setState({ index, device });
    },
    close: () => setState(null),
  };
}

// --- DoorBird --------------------------------------------------------------------------------------

function RelayEditor({ device, set }: { device: DoorBirdDeviceSettings; set(changes: Partial<DoorBirdDeviceSettings>): void }) {
  const entity = useHub((state) => state.entities[`door:${device.id}`]);
  const live = entity?.kind === 'door' ? entity.relays : [];
  const ids = [...new Set([...live.map((relay) => relay.id), ...device.hiddenRelays, ...Object.keys(device.relayNames)])].sort();
  if (ids.length === 0) return <p className="text-sm text-muted">Die Türöffner erscheinen hier, sobald die Türstation verbunden ist.</p>;
  return (
    <ul className="space-y-2">
      {ids.map((id) => {
        const hidden = device.hiddenRelays.includes(id);
        return (
          <li key={id} className="flex items-center gap-3">
            <TextInput
              value={device.relayNames[id] ?? ''}
              onChange={(event) => {
                const relayNames = { ...device.relayNames };
                if (event.target.value === '') delete relayNames[id];
                else relayNames[id] = event.target.value;
                set({ relayNames });
              }}
              placeholder={id.includes('@') ? `Zusatzrelais ${id.split('@')[1]}` : `Türöffner ${id}`}
              aria-label={`Name für Türöffner ${id}`}
              maxLength={40}
              className={cx('bg-surface', hidden && 'opacity-50')}
            />
            <Toggle checked={!hidden} label={`Türöffner ${id} in der App anbieten`} onChange={(shown) => set({ hiddenRelays: shown ? device.hiddenRelays.filter((other) => other !== id) : [...device.hiddenRelays, id] })} />
          </li>
        );
      })}
    </ul>
  );
}

export function DoorBirdForm({ value, saved, onChange, test }: FormProps<'doorbird'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const editing = useEditing<DoorBirdDeviceSettings>(value.devices, () => ({ id: '', name: '', host: '', username: '', password: '', room: '', relayNames: {}, hiddenRelays: [] }));
  const withId = (device: DoorBirdDeviceSettings) => (device.id ? device : { ...device, id: uniqueId(device.name, value.devices.map((other) => other.id), 'tuer') });

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="DoorBird verwenden" subtitle="Klingeln, Live-Bild, Gegensprechen und Türöffner in der App." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="ok" />
        </RowGroup>
      </Section>

      <Section title="Türstationen">
        <HowTo
          title="In der DoorBird-App vorbereiten"
          steps={[
            <>Unter „Administration“ einen eigenen Benutzer für den Hub anlegen.</>,
            <>Ihm diese Rechte geben: „Immer ansehen“, „Verlauf“, „Bewegung“ und „API-Operator“.</>,
            <>Benutzername (z. B. abcdef0001) und Passwort hier eintragen.</>,
          ]}
        />
        <DeviceList
          devices={value.devices}
          savedIds={new Set(saved.devices.map((device) => device.id))}
          entityPrefix="door"
          enabled={saved.enabled}
          icon={DoorClosed}
          emptyTitle="Noch keine Türstation"
          emptyText="Füge deine Türstation hinzu – du brauchst ihre Adresse im Heimnetz und den Benutzer aus der DoorBird-App."
          addLabel="Türstation hinzufügen"
          onAdd={editing.add}
          onEdit={editing.edit}
        />
      </Section>

      <Section title="Verlauf">
        <Card className="p-4">
          <Field label="Aufbewahren (Tage)" hint="So lange bleiben die Bilder von Klingeln und Bewegungen verschlüsselt auf dem Hub gespeichert. Danach werden sie gelöscht.">
            <NumberInput value={value.retentionDays} min={1} max={3650} fallback={90} onChange={(retentionDays) => set({ retentionDays })} className="max-w-32" />
          </Field>
        </Card>
      </Section>

      <DeviceSheet
        device={editing.device}
        isNew={editing.isNew}
        kindLabel="Türstation"
        onClose={editing.close}
        runTest={(device) => test({ ...value, devices: [withId(device)] })}
        onApply={(device) => {
          const next = withId(device);
          set({ devices: editing.isNew ? [...value.devices, next] : value.devices.map((other, index) => (index === editing.index ? next : other)) });
          editing.close();
        }}
        onRemove={() => {
          set({ devices: value.devices.filter((_, index) => index !== editing.index) });
          editing.close();
        }}
      >
        {({ draft, set: setDevice, errors, storedPassword }) => (
          <>
            <CommonFields draft={draft} set={setDevice} errors={errors} storedPassword={storedPassword} hostHint="IP-Adresse der Türstation im Heimnetz." userHint="Der Benutzer aus der DoorBird-App, z. B. abcdef0001." />
            {!editing.isNew && (
              <div className="rounded-control bg-sunken p-3.5">
                <p className="font-medium">Türöffner</p>
                <p className="mb-3 mt-0.5 text-sm text-muted">Gib ihnen verständliche Namen und blende aus, was niemand aus der App schalten soll.</p>
                <RelayEditor device={draft} set={setDevice} />
              </div>
            )}
          </>
        )}
      </DeviceSheet>
    </>
  );
}

// --- Reolink ---------------------------------------------------------------------------------------

export function ReolinkForm({ value, saved, onChange, test }: FormProps<'reolink'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const editing = useEditing<ReolinkDeviceSettings>(value.devices, () => ({ id: '', name: '', host: '', port: 0, https: false, username: 'admin', password: '', channel: 0, room: '', rtspPort: 554, streamProtocol: 'rtsp' }));
  const withId = (device: ReolinkDeviceSettings) => (device.id ? device : { ...device, id: uniqueId(device.name, value.devices.map((other) => other.id), 'kamera') });
  const [advanced, setAdvanced] = useState(false);

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="Reolink verwenden" subtitle="Live-Bild, Schwenken, Licht und Gegensprechen in der App." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="cool" />
        </RowGroup>
      </Section>

      <Section title="Kameras">
        <HowTo
          title="In der Reolink-App vorbereiten"
          steps={[
            <>In den Einstellungen der Kamera unter „Netzwerk › Erweitert › Server-Einstellungen“ die Dienste „HTTPS“ (oder „HTTP“) und „RTSP“ einschalten.</>,
            <>Am besten einen eigenen Benutzer für den Hub anlegen. Zum Schwenken und für das Licht braucht er Administratorrechte.</>,
            <>Hängen die Kameras an einem Rekorder (NVR), trägst du dessen Adresse ein und wählst je Kamera den Kanal.</>,
          ]}
        />
        <DeviceList
          devices={value.devices}
          savedIds={new Set(saved.devices.map((device) => device.id))}
          entityPrefix="cam"
          enabled={saved.enabled}
          icon={Cctv}
          emptyTitle="Noch keine Kamera"
          emptyText="Füge deine erste Kamera hinzu – du brauchst ihre Adresse im Heimnetz und einen Benutzer der Kamera."
          addLabel="Kamera hinzufügen"
          onAdd={() => {
            setAdvanced(false);
            editing.add();
          }}
          onEdit={(index) => {
            setAdvanced(false);
            editing.edit(index);
          }}
        />
      </Section>

      <DeviceSheet
        device={editing.device}
        isNew={editing.isNew}
        kindLabel="Kamera"
        onClose={editing.close}
        runTest={(device) => test({ ...value, devices: [withId(device)] })}
        onApply={(device) => {
          const next = withId(device);
          set({ devices: editing.isNew ? [...value.devices, next] : value.devices.map((other, index) => (index === editing.index ? next : other)) });
          editing.close();
        }}
        onRemove={() => {
          set({ devices: value.devices.filter((_, index) => index !== editing.index) });
          editing.close();
        }}
      >
        {({ draft, set: setDevice, errors, storedPassword }) => (
          <>
            <CommonFields draft={draft} set={setDevice} errors={errors} storedPassword={storedPassword} hostHint="IP-Adresse der Kamera oder des Rekorders im Heimnetz." userHint="Ein Benutzer der Kamera, z. B. admin." />
            <button type="button" className="flex items-center gap-1 text-sm font-medium text-accent" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              Erweitert
              <ChevronDown className={cx('size-4 transition', advanced && 'rotate-180')} aria-hidden />
            </button>
            {advanced && (
              <div className="space-y-4 rounded-control bg-sunken p-3.5">
                <Field label="Kanal" hint="Nur bei einem Rekorder: die Nummer der Kamera, beginnend bei 0. Einzelne Kameras haben immer 0.">
                  <NumberInput value={draft.channel} min={0} max={63} onChange={(channel) => setDevice({ channel })} className="max-w-24 bg-surface" />
                </Field>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Videoübertragung</p>
                  <Segmented
                    className="w-full"
                    value={draft.streamProtocol}
                    onChange={(streamProtocol) => setDevice({ streamProtocol })}
                    options={[
                      { value: 'rtsp', label: 'RTSP' },
                      { value: 'flv', label: 'FLV' },
                    ]}
                  />
                  <p className="mt-1.5 text-sm text-faint">{draft.streamProtocol === 'rtsp' ? 'Standard – ermöglicht Gegensprechen.' : 'Läuft bei manchen Modellen stabiler, aber ohne Gegensprechen.'}</p>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Verschlüsselt verbinden (HTTPS)</p>
                    <p className="text-sm text-faint">Einschalten, wenn an der Kamera nur HTTPS aktiv ist.</p>
                  </div>
                  <Toggle checked={draft.https} label="Verschlüsselt verbinden (HTTPS)" onChange={(https) => setDevice({ https })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Port" hint="0 = Standard">
                    <NumberInput value={draft.port} min={0} max={65535} onChange={(port) => setDevice({ port })} className="bg-surface" />
                  </Field>
                  <Field label="RTSP-Port" hint="Standard: 554">
                    <NumberInput value={draft.rtspPort} min={1} max={65535} fallback={554} onChange={(rtspPort) => setDevice({ rtspPort })} className="bg-surface" />
                  </Field>
                </div>
              </div>
            )}
          </>
        )}
      </DeviceSheet>
    </>
  );
}
