import { ProfileCard, SettingsList } from '../../components/more/SettingsList.tsx';
import { PageHeader } from '../../components/ui.tsx';

export function SettingsHome() {
  return (
    <>
      <PageHeader title="Einstellungen" back="/mehr" />
      <ProfileCard />
      <SettingsList />
    </>
  );
}
