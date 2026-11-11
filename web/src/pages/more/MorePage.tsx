import { ChevronRight, Thermometer, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ProfileCard, SettingsList } from '../../components/more/SettingsList.tsx';
import { PageHeader, Row, RowGroup, Section } from '../../components/ui.tsx';
import { useEntities } from '../../hooks/entities.ts';
import { plural } from '../../lib/format.ts';

export function MorePage() {
  const navigate = useNavigate();
  const scenes = useEntities('action');
  const clocks = useEntities('clock');
  const climate = useEntities('climate');
  const chevron = <ChevronRight className="size-4.5 text-faint" aria-hidden />;
  return (
    <>
      <PageHeader title="Mehr" />
      <ProfileCard />
      <Section title="Zuhause">
        <RowGroup>
          <Row
            icon={Workflow}
            tone="accent"
            title="Automationen"
            subtitle={`${plural(scenes.length, 'Szene', 'Szenen')} · ${plural(clocks.length, 'Zeitschaltuhr', 'Zeitschaltuhren')}`}
            trailing={chevron}
            onClick={() => navigate('/mehr/automationen')}
          />
          <Row icon={Thermometer} tone="warm" title="Haus & Klima" subtitle={climate.length > 0 ? `${plural(climate.length, 'Raum', 'Räume')} mit Heizung` : 'Klima, Wetter, Energie'} trailing={chevron} onClick={() => navigate('/mehr/haus')} />
        </RowGroup>
      </Section>
      <SettingsList />
    </>
  );
}
