import { Box, ChevronRight, Thermometer, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { DemoPanel } from '../../components/more/DemoPanel.tsx';
import { ProfileCard, SettingsList } from '../../components/more/SettingsList.tsx';
import { PageHeader, Row, RowGroup, Section } from '../../components/ui.tsx';
import { useEntities } from '../../hooks/entities.ts';
import { plural } from '../../lib/format.ts';
import { useLabs } from '../../store/labs.ts';

export function MorePage() {
  const navigate = useNavigate();
  const scenes = useEntities('action');
  const clocks = useEntities('clock');
  const climate = useEntities('climate');
  const house3d = useLabs((state) => state.house3d);
  const chevron = <ChevronRight className="size-4.5 text-faint" aria-hidden />;
  return (
    <>
      <PageHeader title="Mehr" />
      <ProfileCard />
      <DemoPanel />
      <Section title="Zuhause">
        <RowGroup>
          <Row
            icon={Workflow}
            tone="accent"
            title="Aktionen"
            subtitle={`${plural(scenes.length, 'Szene', 'Szenen')} · ${plural(clocks.length, 'Zeitschaltuhr', 'Zeitschaltuhren')}`}
            trailing={chevron}
            onClick={() => navigate('/aktionen')}
          />
          <Row icon={Thermometer} tone="warm" title="Haus & Klima" subtitle={climate.length > 0 ? `${plural(climate.length, 'Raum', 'Räume')} mit Heizung` : 'Klima, Wetter, Energie'} trailing={chevron} onClick={() => navigate('/mehr/haus')} />
          {house3d && <Row icon={Box} tone="accent" title="3D-Haus" subtitle="Labs · das Haus als Modell, Licht nach Tageszeit" trailing={chevron} onClick={() => navigate('/haus3d')} />}
        </RowGroup>
      </Section>
      <SettingsList />
    </>
  );
}
