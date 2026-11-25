import { Lightbulb } from 'lucide-react';
import { useMemo } from 'react';
import type { LightEntity } from '@home-hub/shared';
import { useHub } from '../../store/hub.ts';
import { Badge, Card, EmptyState, Field, Notice, Row, RowGroup, Section } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { ChipsInput, HowTo, isHost, SecretInput, SwitchRow } from './parts.tsx';

/** Govee lights: locally over the LAN where the light offers it, through Govee's cloud with the API key otherwise. */
export function GoveeForm({ value, saved, onChange }: FormProps<'govee'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  const lights = useMemo(
    () =>
      [...Object.values(entities), ...Object.values(hidden)]
        .filter((entity): entity is LightEntity => entity.kind === 'light' && entity.service === 'govee')
        .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [entities, hidden],
  );

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="Govee verwenden" subtitle="LED-Streifen und Lampen von Govee: Ein/Aus, Helligkeit, Farbe und Weißton." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="warm" />
        </RowGroup>
      </Section>

      <Section title="Verbindung">
        <HowTo
          title="In der Govee-App vorbereiten"
          steps={[
            <>
              <strong>LAN-Steuerung</strong> (empfohlen): In der Govee Home App beim Licht oben rechts das Zahnrad öffnen und „LAN-Steuerung“ einschalten. Dann schaltet der Hub das Licht direkt im Heimnetz – schnell, ohne Cloud und ohne Limit. Nicht jedes Modell
              bietet das.
            </>,
            <>
              <strong>API-Key</strong> für alle übrigen Lichter und für die Namen aus der App: unter „Profil › Einstellungen (Zahnrad) › API-Key beantragen“. Govee schickt ihn per E-Mail.
            </>,
            <>Steht der Raum im Namen des Lichts (z. B. „Wohnzimmer LED-Streifen“), ordnet der Hub es dem Raum zu. Sonst unter „Räume › Bearbeiten“.</>,
          ]}
        />
        <Card className="space-y-4 p-4">
          <Field label="API-Key" hint="Ohne API-Key erscheinen nur Lichter mit LAN-Steuerung, mit ihrer Modellnummer als Namen.">
            <SecretInput value={value.apiKey} stored={saved.apiKey !== ''} onChange={(apiKey) => set({ apiKey: apiKey.trim() })} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </Field>
        </Card>
        <RowGroup className="mt-3">
          <SwitchRow
            title="Im Heimnetz steuern (LAN)"
            subtitle="Lichter mit LAN-Steuerung direkt ansprechen."
            checked={value.lan}
            onChange={(lan) => set({ lan })}
            tone="warm"
          />
        </RowGroup>
        {value.lan && (
          <Card className="mt-3 p-4">
            <Field label="Adressen der Lichter (optional)" hint="Leer lassen: Der Hub sucht selbst. Nur nötig, wenn Lichter in einem anderen Netz (VLAN) hängen und die Suche sie nicht findet.">
              <ChipsInput value={value.lanHosts} onChange={(lanHosts) => set({ lanHosts })} placeholder="192.168.1.50" validate={isHost} />
            </Field>
          </Card>
        )}
        {value.apiKey !== '' && (
          <Notice className="mt-3">
            Lichter ohne LAN-Steuerung werden über die Server von Govee geschaltet. Govee erlaubt 10 000 Anfragen am Tag – der Hub fragt den Zustand solcher Lichter deshalb nur alle paar Minuten ab und fasst schnelle Änderungen (z. B. am Farbrad) zusammen.
          </Notice>
        )}
      </Section>

      <Section title="Lichter">
        {lights.length === 0 ? (
          <Card>
            <EmptyState icon={Lightbulb} title="Noch keine Govee-Lichter" text={saved.enabled ? 'Die Lichter erscheinen hier, sobald der Hub sie gefunden hat. „Verbindung testen“ zeigt, was er sieht.' : 'Einschalten, API-Key eintragen oder LAN-Steuerung nutzen und speichern.'} />
          </Card>
        ) : (
          <RowGroup>
            {lights.map((light) => (
              <Row
                key={light.id}
                icon={Lightbulb}
                tone={light.available ? (light.on ? 'warm' : 'neutral') : 'neutral'}
                title={light.name}
                subtitle={light.room ?? 'Ohne Raum'}
                trailing={<Badge tone={light.available ? 'ok' : 'danger'}>{light.available ? (light.on ? 'An' : 'Aus') : 'Nicht erreichbar'}</Badge>}
              />
            ))}
          </RowGroup>
        )}
        {lights.length > 0 && <p className="mt-2 px-1 text-sm text-faint">Namen und Räume änderst du unter „Räume › Bearbeiten“.</p>}
      </Section>
    </>
  );
}
