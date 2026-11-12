import { Check, ChevronDown, Copy, Download, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { get } from '../../lib/api.ts';
import { toast } from '../toast.tsx';
import type { ContactEntity } from '@home-hub/shared';
import { useHub } from '../../store/hub.ts';
import { contactIcon } from '../entities/icons.ts';
import { Badge, Button, Card, Field, Notice, Row, RowGroup, Section, Segmented, TextInput } from '../ui.tsx';
import { ContactsEditor } from './ContactsEditor.tsx';
import type { FormProps } from './meta.ts';
import { HowTo, SecretInput, SwitchRow } from './parts.tsx';

export function MyGekkoForm({ value, saved, onChange }: FormProps<'mygekko'>) {
  const health = useHub((state) => state.services.mygekko);
  const connected = health?.status === 'ok' || health?.status === 'degraded';
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const storedSecret = saved.password !== '' && saved.mode === value.mode;

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="myGEKKO verwenden" subtitle="Licht, Jalousien, Heizung, Szenen und Kontakte in der App anzeigen und bedienen." checked={value.enabled} onChange={(enabled) => set({ enabled })} />
        </RowGroup>
      </Section>

      <Section title="Verbindung">
        <Segmented
          className="mb-4 w-full sm:w-auto"
          value={value.mode}
          onChange={(mode) => set({ mode, password: mode === saved.mode && saved.password !== '' ? saved.password : '' })}
          options={[
            { value: 'local', label: 'Im Heimnetz' },
            { value: 'cloud', label: 'Über myGEKKO Plus' },
          ]}
        />
        {value.mode === 'local' ? (
          <>
            <HowTo
              title="Am myGEKKO vorbereiten"
              steps={[
                <>In den Einstellungen des myGEKKO unter „Netzwerk“ die lokale Abfrage („Lokale QueryAPI“) einschalten.</>,
                <>Dort einen Benutzer mit Passwort anlegen, der lesen und schalten darf – am besten einen eigenen nur für den Hub.</>,
                <>Adresse, Benutzer und Passwort hier eintragen und die Verbindung testen.</>,
              ]}
            />
            <Card className="space-y-4 p-4">
              <Field label="Adresse" hint="IP-Adresse oder Name des myGEKKO in deinem Heimnetz, z. B. 192.168.1.50.">
                <TextInput value={value.host} onChange={(event) => set({ host: event.target.value })} placeholder="192.168.1.50" autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" />
              </Field>
              <Field label="Benutzername" hint="Der Benutzer, den du am myGEKKO für die lokale Abfrage angelegt hast.">
                <TextInput value={value.username} onChange={(event) => set({ username: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
              </Field>
              <Field label="Passwort">
                <SecretInput value={value.password} stored={storedSecret} onChange={(password) => set({ password })} />
              </Field>
            </Card>
          </>
        ) : (
          <>
            <HowTo
              title="Zugang über myGEKKO Plus"
              steps={[
                <>Im myGEKKO-Plus-Portal (live.my-gekko.com) anmelden und in den erweiterten Einstellungen einen API-Schlüssel für deinen myGEKKO erzeugen.</>,
                <>Benutzername, API-Schlüssel und die myGEKKO-ID hier eintragen.</>,
              ]}
            >
              <p className="mt-1.5 text-muted">Dieser Weg läuft über die Server von myGEKKO und reagiert langsamer. Im Heimnetz ist die direkte Verbindung die bessere Wahl.</p>
            </HowTo>
            <Card className="space-y-4 p-4">
              <Field label="Benutzername" hint="Die E-Mail-Adresse deines myGEKKO-Plus-Kontos.">
                <TextInput value={value.username} onChange={(event) => set({ username: event.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" inputMode="email" />
              </Field>
              <Field label="API-Schlüssel">
                <SecretInput value={value.password} stored={storedSecret} onChange={(password) => set({ password })} />
              </Field>
              <Field label="myGEKKO-ID" hint="Steht im Portal bei deinem Gerät.">
                <TextInput value={value.gekkoId} onChange={(event) => set({ gekkoId: event.target.value })} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
              </Field>
            </Card>
          </>
        )}
      </Section>

      <Section title="Fenster- & Türkontakte">
        <Notice icon={Info} className="mb-4">
          Kontakte werden automatisch erkannt – anlernen musst du nichts. Ob in der Alarmüberwachung („Hülle“) etwas offen ist, zeigt die App immer sofort. Welches Fenster genau, gibt die Schnittstelle des myGEKKO nicht direkt
          preis; der Hub findet es selbst überall dort, wo der myGEKKO einen Kontakt einzeln führt (Raumregler, Zutrittstüren, Logiken, Trends). Kontakte ohne sprechenden Namen erscheinen, sobald sie zweimal geöffnet wurden.
        </Notice>
        <AutoContacts explicitIds={value.contacts.map((contact) => contact.id)} enabled={value.autoContacts && saved.enabled} />
        {connected && saved.enabled && <RawExport />}
        <RowGroup className="mb-4">
          <SwitchRow
            title="Kontakte automatisch erkennen"
            subtitle="Raumregler mit Fensterkontakt, Zutrittstüren, Logiken mit passendem Namen und Werte, die mit der Hülle auf- und zugehen."
            checked={value.autoContacts}
            onChange={(autoContacts) => set({ autoContacts })}
          />
          {value.autoContacts && (
            <div className="space-y-4 p-4">
              <Field label="Alarmzone der Kontakte" hint="Name der Zone, in der die Fenster- und Türkontakte stecken, z. B. „Hülle“. Daran erkennt der Hub, welche Werte Kontakte sind.">
                <TextInput value={value.contactZone} onChange={(event) => set({ contactZone: event.target.value })} maxLength={60} className="max-w-xs" />
              </Field>
              <Field label="Stichwörter für Kontakte" hint="Logiken, deren Name oder Seite eines dieser Wörter enthält, gelten sofort als Kontakt. Mit Komma trennen.">
                <TextInput value={value.contactKeywords} onChange={(event) => set({ contactKeywords: event.target.value })} maxLength={300} autoCapitalize="none" />
              </Field>
              <Field label="Stichwörter für Türen" hint="Enthält der Name eines davon, wird der Kontakt als Tür statt als Fenster angezeigt.">
                <TextInput value={value.doorKeywords} onChange={(event) => set({ doorKeywords: event.target.value })} maxLength={300} autoCapitalize="none" />
              </Field>
            </div>
          )}
        </RowGroup>
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-1 text-sm font-medium text-accent">
            <ChevronDown className="size-4 shrink-0 transition group-open:rotate-180" aria-hidden />
            Von Hand zuordnen – nur falls ein Kontakt fehlt oder anders heißen soll
          </summary>
          <div className="pt-2">
            <ContactsEditor value={value.contacts} onChange={(contacts) => set({ contacts })} connected={connected && saved.enabled} defaultZone={value.contactZone} />
          </div>
        </details>
      </Section>
    </>
  );
}

/** What the hub found by itself, live. */
function AutoContacts({ explicitIds, enabled }: { explicitIds: string[]; enabled: boolean }) {
  const entities = useHub((state) => state.entities);
  const found = useMemo(
    () =>
      Object.values(entities)
        .filter((entity): entity is ContactEntity => entity.kind === 'contact' && entity.service === 'mygekko' && !explicitIds.includes(entity.id.slice('gekko:contact/'.length)))
        .sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name, 'de', { numeric: true })),
    [entities, explicitIds],
  );
  if (!enabled) return null;
  return (
    <div className="mb-4">
      <h3 className="mb-2.5 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Automatisch erkannt ({found.length})</h3>
      {found.length === 0 ? (
        <p className="px-1 text-sm text-muted">Noch keiner. Sobald der myGEKKO verbunden ist und Kontakte meldet, erscheinen sie hier.</p>
      ) : (
        <RowGroup>
          {found.map((contact) => (
            <Row
              key={contact.id}
              icon={contactIcon(contact)}
              tone={contact.available ? (contact.open ? 'warn' : 'ok') : 'neutral'}
              title={contact.name}
              subtitle={[contact.room, contact.zone].filter(Boolean).join(' · ') || undefined}
              trailing={contact.available ? <Badge tone={contact.open ? 'warn' : 'ok'}>{contact.open ? 'Offen' : 'Geschlossen'}</Badge> : 'Nicht erreichbar'}
            />
          ))}
        </RowGroup>
      )}
    </div>
  );
}

/**
 * Everything the myGEKKO reports through its interface, as a file: to check whether the contacts show up
 * anywhere — and to send it along when asking for help. No passwords are in it.
 */
function RawExport() {
  const [busy, setBusy] = useState<'download' | 'copy' | null>(null);
  const [copied, setCopied] = useState(false);
  const load = async () => JSON.stringify(await get<unknown>('/api/admin/mygekko/raw'), null, 2);
  const download = async () => {
    setBusy('download');
    try {
      const text = await load();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `mygekko-datenauszug-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(await load());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mb-4 rounded-tile bg-surface p-4 shadow-tile">
      <p className="font-medium">Was meldet mein myGEKKO?</p>
      <p className="mt-1 text-sm text-muted">
        Alle Werte, die der myGEKKO über seine Schnittstelle meldet – zum Nachsehen, ob die Kontakte irgendwo einzeln vorkommen, oder zum Weitergeben bei der Fehlersuche. Passwörter sind nicht enthalten, Raum- und
        Gerätenamen schon.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={Download} loading={busy === 'download'} onClick={() => void download()}>
          Herunterladen
        </Button>
        <Button size="sm" icon={copied ? Check : Copy} loading={busy === 'copy'} onClick={() => void copy()}>
          {copied ? 'Kopiert' : 'Kopieren'}
        </Button>
      </div>
    </div>
  );
}
