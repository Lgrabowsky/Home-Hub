import { ShieldAlert } from 'lucide-react';
import { Card, Field, Notice, RowGroup, Section, TextInput } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { NumberInput, SwitchRow } from './parts.tsx';

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
