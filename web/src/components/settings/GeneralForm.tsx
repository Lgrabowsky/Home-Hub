import { LayoutGrid, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Card, Field, Notice, RowGroup, Section, TextInput } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { NumberInput, SwitchRow } from './parts.tsx';

/** A coordinate in decimal degrees; empty = not set. A comma works as decimal separator. */
function CoordinateInput({ value, onChange }: { value: number | null; onChange(next: number | null): void }) {
  const [text, setText] = useState(value === null ? '' : String(value).replace('.', ','));
  return (
    <TextInput
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const raw = event.target.value.trim().replace(',', '.');
        if (raw === '') onChange(null);
        else if (Number.isFinite(Number(raw))) onChange(Number(raw));
      }}
    />
  );
}

export function GeneralForm({ value, onChange }: FormProps<'general'>) {
  return (
    <>
      <Section title="Dein Zuhause">
        <Card className="p-4">
          <Field label="Name" hint="Steht oben in der App und auf der Anmeldeseite.">
            <TextInput value={value.hubName} maxLength={40} onChange={(event) => onChange({ ...value, hubName: event.target.value })} />
          </Field>
        </Card>
      </Section>

      <Section title="Ort & Zeit">
        <Card className="grid gap-4 p-4 sm:grid-cols-3">
          <Field label="Zeitzone" hint="Für die Zeitschaltuhren des Hubs.">
            <TextInput value={value.timeZone} maxLength={60} list="hh-time-zones" onChange={(event) => onChange({ ...value, timeZone: event.target.value })} />
          </Field>
          <Field label="Breitengrad" hint="z. B. 47,51 – für Sonnenauf- und -untergang.">
            <CoordinateInput value={value.latitude} onChange={(latitude) => onChange({ ...value, latitude })} />
          </Field>
          <Field label="Längengrad" hint="z. B. 12,23 – aus einer Karten-App.">
            <CoordinateInput value={value.longitude} onChange={(longitude) => onChange({ ...value, longitude })} />
          </Field>
          <datalist id="hh-time-zones">
            {['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Rome', 'Europe/London', 'UTC'].map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </Card>
      </Section>

      <Section title="Stockwerke und Räume">
        <Notice icon={LayoutGrid}>
          Bereiche (z. B. Erdgeschoss, Treppenhaus), Räume und die Namen der Geräte bearbeitest du jetzt direkt in der App: <Link to="/raeume" className="font-medium text-accent hover:underline">Räume › Bearbeiten</Link>.
        </Notice>
      </Section>

      <Section title="Anmeldung">
        <RowGroup>
          <SwitchRow
            title="Zwei-Faktor-Anmeldung für alle verlangen"
            subtitle="Zusätzlich zum Passwort braucht jede Person einen Code aus einer Authenticator-App."
            checked={value.requireTotp}
            onChange={(requireTotp) => onChange({ ...value, requireTotp })}
          />
          <div className="p-4">
            <Field label="Angemeldet bleiben (Tage)" hint="Wird ein Gerät so lange nicht benutzt, muss man sich dort neu anmelden.">
              <NumberInput value={value.sessionDays} min={1} max={365} fallback={30} onChange={(sessionDays) => onChange({ ...value, sessionDays })} className="max-w-32" />
            </Field>
          </div>
        </RowGroup>
        {!value.requireTotp && (
          <Notice tone="warn" icon={ShieldAlert} className="mt-3">
            Ohne zweiten Faktor genügt ein erratenes oder gestohlenes Passwort, um Kameras zu sehen und Türen zu öffnen. Lass die Zwei-Faktor-Anmeldung an, wenn dein Zuhause aus dem Internet erreichbar ist.
          </Notice>
        )}
      </Section>
    </>
  );
}
