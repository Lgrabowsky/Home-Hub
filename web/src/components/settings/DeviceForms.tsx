import { Cctv, Check, ChevronDown, DoorClosed, Plus, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { SECRET_SET, type CameraSupport, type DoorBirdDeviceSettings, type ReolinkDeviceSettings, type TestResult } from '@home-hub/shared';
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
  kindOf,
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
  /** Shown first in the subtitle, e.g. the make of a camera. */
  kindOf?(device: D): string;
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
              subtitle={[kindOf?.(device), device.host, device.room].filter(Boolean).join(' · ')}
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

/** Fields that do not change how the hub reaches a device: editing them keeps a test result valid. */
const UNTESTED_FIELDS = new Set(['name', 'room', 'ptz', 'talk', 'relayNames', 'hiddenRelays']);

function DeviceSheet<D extends BaseDevice>({
  device,
  isNew,
  kindLabel,
  onClose,
  onApply,
  onRemove,
  runTest,
  onTested,
  checkBeforeAdding = false,
  children,
}: {
  device: D | null;
  isNew: boolean;
  kindLabel: string;
  onClose(): void;
  onApply(device: D): void;
  onRemove(): void;
  runTest(device: D): Promise<TestResult>;
  /** Adjusts the draft to what a test found (e.g. switches off what the device cannot). */
  onTested?(result: TestResult, draft: D): D;
  /** A new device is tested by itself on "Übernehmen". */
  checkBeforeAdding?: boolean;
  children(args: {
    draft: D;
    set(changes: Partial<D>): void;
    errors: NonNullable<ReturnType<typeof problems>>;
    storedPassword: boolean;
    /** The last test result, as long as nothing that matters for the connection was changed since. */
    tested: TestResult | null;
  }): ReactNode;
}) {
  const [draft, setDraft] = useState<D | null>(device);
  const [touched, setTouched] = useState(false);
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  // The result still describes the device as entered.
  const [fresh, setFresh] = useState(false);
  // A new device failed its automatic check: "Übernehmen" now adds it anyway.
  const [anyway, setAnyway] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    setDraft(device);
    setTouched(false);
    setResult(null);
    setFresh(false);
    setAnyway(false);
  }, [device]);
  if (!draft || !device) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;

  const found = problems(draft);
  const errors = touched && found ? found : {};
  const test = async (): Promise<{ result: TestResult; draft: D } | null> => {
    setTouched(true);
    if (found) return null;
    setTesting(true);
    setResult(null);
    let outcome: TestResult;
    try {
      outcome = await runTest(draft);
    } catch (err) {
      outcome = { ok: false, message: errorMessage(err), details: [] };
    }
    const next = onTested ? onTested(outcome, draft) : draft;
    setDraft(next);
    setResult(outcome);
    setFresh(true);
    setTesting(false);
    return { result: outcome, draft: next };
  };
  const apply = async () => {
    setTouched(true);
    if (found) return;
    let next = draft;
    if (isNew && checkBeforeAdding && !(fresh && result?.ok) && !anyway) {
      setAdding(true);
      const outcome = await test();
      setAdding(false);
      if (!outcome) return;
      if (!outcome.result.ok) {
        // Stays open with the result; a second tap adds the device as it is.
        setAnyway(true);
        return;
      }
      next = outcome.draft;
    }
    onApply({ ...next, name: next.name.trim(), host: next.host.trim(), username: next.username.trim(), room: next.room.trim() });
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
            <Button className="flex-1" loading={testing && !adding} disabled={adding} onClick={() => void test()}>
              Verbindung testen
            </Button>
            <Button variant="primary" className="flex-1" loading={adding} disabled={testing && !adding} onClick={() => void apply()}>
              {anyway ? 'Trotzdem übernehmen' : 'Übernehmen'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {children({
          draft,
          set: (changes) => {
            setDraft({ ...draft, ...changes });
            if (Object.keys(changes).some((key) => !UNTESTED_FIELDS.has(key))) {
              setFresh(false);
              setAnyway(false);
            }
          },
          errors,
          storedPassword: !isNew && device.password === SECRET_SET,
          tested: fresh ? result : null,
        })}
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

// --- Cameras (Reolink, Hikvision, ONVIF) ------------------------------------------------------------

const CONNECTION_LABEL: Record<ReolinkDeviceSettings['connection'], string> = { api: 'Reolink', hikvision: 'Hikvision', onvif: 'ONVIF + RTSP' };

const CONNECTION_TEXT: Record<ReolinkDeviceSettings['connection'], string> = {
  api: 'Reolink-Kameras und -Rekorder: alle Funktionen inklusive Licht und Sirene. Braucht HTTP oder HTTPS an der Kamera.',
  hikvision:
    'Hikvision-Kameras und -Rekorder über ihre Weboberfläche (ISAPI): Live-Bild, Ton, Schwenken, Zoom, gespeicherte Positionen und Gegensprechen. Licht und Sirene gehen so nicht.',
  onvif: 'Für Reolink-Kameras ohne HTTP/HTTPS (z. B. E1 Pro) und Kameras anderer Hersteller: Live-Bild, Ton, Schwenken und gespeicherte Positionen über ONVIF (8000) und RTSP (554). Licht und Sirene gehen so nicht.',
};

const CAMERA_FEATURES = [
  { key: 'ptz', title: 'Schwenken & Zoom', text: 'Steuerkreuz, Zoom und gespeicherte Positionen auf der Kameraseite.' },
  { key: 'talk', title: 'Gegensprechen', text: 'Sprechtaste auf der Kameraseite.' },
] as const;

/**
 * What the app offers for this camera. Whether the camera can do it comes from the last connection
 * test or, for a camera the hub already reaches, from the hub; what it cannot do stays switched off.
 */
function CameraFeatures({
  draft,
  set,
  tested,
  checked,
}: {
  draft: ReolinkDeviceSettings;
  set(changes: Partial<ReolinkDeviceSettings>): void;
  tested: TestResult | null;
  /** Found by an earlier test in this form (cameras not saved yet). */
  checked: CameraSupport | undefined;
}) {
  const entity = useHub((state) => (draft.id ? (state.entities[`cam:${draft.id}`] ?? state.hidden[`cam:${draft.id}`]) : undefined));
  const fromHub = entity?.kind === 'camera' ? entity.supports : undefined;
  const known = (tested?.ok && tested.supports) || checked || fromHub || null;
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Funktionen in der App</p>
      <div className="divide-y divide-line/70 rounded-control bg-sunken">
        {CAMERA_FEATURES.map((feature) => {
          const supported = known ? known[feature.key] : null;
          return (
            <div key={feature.key} className="flex items-center justify-between gap-3 px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{feature.title}</p>
                <p className="text-sm text-faint">{feature.text}</p>
                <p className={cx('mt-0.5 flex items-center gap-1 text-sm', supported === true ? 'text-ok' : supported === false ? 'text-warn' : 'text-faint')}>
                  {supported === true ? <Check className="size-4 shrink-0" aria-hidden /> : supported === false ? <X className="size-4 shrink-0" aria-hidden /> : null}
                  {supported === true ? 'Die Kamera unterstützt das.' : supported === false ? 'Die Kamera unterstützt das nicht.' : 'Wird beim Verbindungstest geprüft.'}
                </p>
              </div>
              <Toggle checked={draft[feature.key] && supported !== false} disabled={supported === false} label={feature.title} onChange={(on) => set({ [feature.key]: on })} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** After a test: what the camera cannot do is switched off; what it can keeps the household's choice. */
function adoptSupport(result: TestResult, device: ReolinkDeviceSettings): ReolinkDeviceSettings {
  if (!result.ok || !result.supports) return device;
  return { ...device, ptz: device.ptz && result.supports.ptz, talk: device.talk && result.supports.talk };
}

/** Which camera a test talked to (the same camera keeps its result while name or room change). */
const cameraKey = (device: ReolinkDeviceSettings) => [device.connection, device.host.trim(), device.port, device.https, device.channel, device.onvifPort, device.rtspPort].join('|');

export function ReolinkForm({ value, saved, onChange, test }: FormProps<'reolink'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const editing = useEditing<ReolinkDeviceSettings>(value.devices, () => ({ id: '', name: '', host: '', port: 0, https: false, username: 'admin', password: '', channel: 0, room: '', rtspPort: 554, streamProtocol: 'rtsp', connection: 'api', onvifPort: 8000, ptz: true, talk: true }));
  const withId = (device: ReolinkDeviceSettings) => (device.id ? device : { ...device, id: uniqueId(device.name, value.devices.map((other) => other.id), 'kamera') });
  const [advanced, setAdvanced] = useState(false);
  const [checked, setChecked] = useState<Record<string, CameraSupport>>({});

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="Kameras verwenden" subtitle="Reolink, Hikvision und Kameras mit ONVIF: Live-Bild, Schwenken und Gegensprechen in der App." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="cool" />
        </RowGroup>
      </Section>

      <Section title="Kameras">
        <HowTo
          title="Reolink vorbereiten"
          steps={[
            <>In der Reolink-App in den Einstellungen der Kamera unter „Netzwerk › Erweitert › Server-Einstellungen“ die Dienste „HTTPS“ (oder „HTTP“) und „RTSP“ einschalten.</>,
            <>Gibt es dort kein HTTP/HTTPS, sondern nur „Basisdienste“, „RTSP“ und „ONVIF“ (z. B. E1 Pro und andere E1-Modelle): „RTSP“ und „ONVIF“ einschalten und bei der Kamera die Verbindungsart „ONVIF + RTSP“ wählen.</>,
            <>Am besten einen eigenen Benutzer für den Hub anlegen. Zum Schwenken und für das Licht braucht er Administratorrechte.</>,
            <>Hängen die Kameras an einem Rekorder (NVR), trägst du dessen Adresse ein und wählst je Kamera den Kanal.</>,
          ]}
        />
        <HowTo
          title="Hikvision vorbereiten"
          steps={[
            <>Die Weboberfläche der Kamera im Browser öffnen (ihre IP-Adresse) und unter „Konfiguration › System › Benutzerverwaltung“ einen eigenen Benutzer für den Hub anlegen, z. B. als „Bediener“ mit den Rechten „Live-Ansicht“, „PTZ-Steuerung“ und „Zweiwege-Audio“.</>,
            <>Für Ton im Live-Bild unter „Video/Audio › Video“ beim Haupt- und beim Substream den Stream-Typ „Video&Audio“ wählen. Für das Gegensprechen unter „Video/Audio › Audio“ die Audiokodierung „G.711ulaw“ einstellen.</>,
            <>HTTP (Port 80) und RTSP (Port 554) sind ab Werk an („Netzwerk › Grundeinstellungen › Port“). Gegensprechen braucht HTTP.</>,
            <>Wichtig: Hikvision sperrt nach einigen falschen Passwörtern die Anmeldung für bis zu 30 Minuten – auch das Live-Bild. Benutzername und Passwort deshalb genau eintragen.</>,
            <>Hängt die Kamera an einem Hikvision-Rekorder, kannst du auch dessen Adresse eintragen und unter „Erweitert“ die Kamera (D1, D2 …) wählen – Gegensprechen geht dann aber nur direkt mit der Kamera.</>,
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
          kindOf={(device) => CONNECTION_LABEL[device.connection]}
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
        onTested={(result, device) => {
          const supports = result.ok ? result.supports : undefined;
          if (supports) setChecked((known) => ({ ...known, [cameraKey(device)]: supports }));
          return adoptSupport(result, device);
        }}
        checkBeforeAdding
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
        {({ draft, set: setDevice, errors, storedPassword, tested }) => (
          <>
            <CommonFields draft={draft} set={setDevice} errors={errors} storedPassword={storedPassword} hostHint="IP-Adresse der Kamera oder des Rekorders im Heimnetz." userHint="Ein Benutzer der Kamera, z. B. admin." />
            <div>
              <p className="mb-1.5 text-sm font-medium">Verbindungsart</p>
              <Segmented
                className="w-full"
                value={draft.connection}
                onChange={(connection) => setDevice({ connection })}
                options={(['api', 'hikvision', 'onvif'] as const).map((value) => ({ value, label: CONNECTION_LABEL[value] }))}
              />
              <p className="mt-1.5 text-sm text-faint">{CONNECTION_TEXT[draft.connection]}</p>
            </div>
            <CameraFeatures draft={draft} set={setDevice} tested={tested} checked={checked[cameraKey(draft)]} />
            <button type="button" className="flex items-center gap-1 text-sm font-medium text-accent" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
              Erweitert
              <ChevronDown className={cx('size-4 transition', advanced && 'rotate-180')} aria-hidden />
            </button>
            {advanced && draft.connection === 'onvif' && (
              <div className="grid grid-cols-2 gap-3 rounded-control bg-sunken p-3.5">
                <Field label="ONVIF-Port" hint="Standard: 8000">
                  <NumberInput value={draft.onvifPort} min={1} max={65535} fallback={8000} onChange={(onvifPort) => setDevice({ onvifPort })} className="bg-surface" />
                </Field>
                <Field label="RTSP-Port" hint="Standard: 554">
                  <NumberInput value={draft.rtspPort} min={1} max={65535} fallback={554} onChange={(rtspPort) => setDevice({ rtspPort })} className="bg-surface" />
                </Field>
              </div>
            )}
            {advanced && draft.connection !== 'onvif' && (
              <div className="space-y-4 rounded-control bg-sunken p-3.5">
                {draft.connection === 'hikvision' ? (
                  <Field label="Kamera am Rekorder" hint="Nur bei einem Rekorder: die Nummer der Kamera (D1 = 1, D2 = 2 …). Einzelne Kameras haben immer 1.">
                    <NumberInput value={draft.channel + 1} min={1} max={64} fallback={1} onChange={(camera) => setDevice({ channel: camera - 1 })} className="max-w-24 bg-surface" />
                  </Field>
                ) : (
                  <Field label="Kanal" hint="Nur bei einem Rekorder: die Nummer der Kamera, beginnend bei 0. Einzelne Kameras haben immer 0.">
                    <NumberInput value={draft.channel} min={0} max={63} onChange={(channel) => setDevice({ channel })} className="max-w-24 bg-surface" />
                  </Field>
                )}
                {draft.connection === 'api' && (
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
                )}
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Verschlüsselt verbinden (HTTPS)</p>
                    <p className="text-sm text-faint">{draft.connection === 'hikvision' ? 'Die Steuerung läuft dann über HTTPS. Gegensprechen braucht trotzdem HTTP (Port 80).' : 'Einschalten, wenn an der Kamera nur HTTPS aktiv ist.'}</p>
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
