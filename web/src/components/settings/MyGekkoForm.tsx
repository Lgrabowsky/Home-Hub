import { Info } from 'lucide-react';
import { useHub } from '../../store/hub.ts';
import { Card, Field, Notice, RowGroup, Section, Segmented, TextInput } from '../ui.tsx';
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
          Der myGEKKO meldet seine Alarmüberwachung („Hülle“) nach außen nur als Ganzes: „etwas ist offen“. Damit du jedes Fenster und jede Tür einzeln siehst, muss der Kontakt am myGEKKO als eigenes Element lesbar sein – als
          Raumregler mit Fensterkontakt, als Zutrittstür oder als Logik je Kontakt. Der Hub zeigt alles an, was er so findet; den Rest lernst du unten an.
        </Notice>
        <RowGroup className="mb-4">
          <SwitchRow
            title="Kontakte automatisch erkennen"
            subtitle="Raumregler mit Fensterkontakt, Zutrittstüren und Logiken mit passendem Namen werden von selbst zu Kontakten."
            checked={value.autoContacts}
            onChange={(autoContacts) => set({ autoContacts })}
          />
          {value.autoContacts && (
            <div className="space-y-4 p-4">
              <Field label="Stichwörter für Kontakte" hint="Logiken, deren Name oder Seite eines dieser Wörter enthält, gelten als Kontakt. Mit Komma trennen.">
                <TextInput value={value.contactKeywords} onChange={(event) => set({ contactKeywords: event.target.value })} maxLength={300} autoCapitalize="none" />
              </Field>
              <Field label="Stichwörter für Türen" hint="Enthält der Name eines davon, wird der Kontakt als Tür statt als Fenster angezeigt.">
                <TextInput value={value.doorKeywords} onChange={(event) => set({ doorKeywords: event.target.value })} maxLength={300} autoCapitalize="none" />
              </Field>
              <Field label="Zone" hint="Unter diesem Namen werden die automatisch gefundenen Kontakte zusammengefasst.">
                <TextInput value={value.contactZone} onChange={(event) => set({ contactZone: event.target.value })} maxLength={60} className="max-w-xs" />
              </Field>
            </div>
          )}
        </RowGroup>
        <h3 className="mb-2.5 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Eigene Kontakte</h3>
        <ContactsEditor value={value.contacts} onChange={(contacts) => set({ contacts })} connected={connected && saved.enabled} defaultZone={value.contactZone} />
      </Section>
    </>
  );
}
