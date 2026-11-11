import { Activity, ChevronRight, FlaskConical } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { IntegrationSettingsMap, ServiceHealth, SpotifyStatus } from '@home-hub/shared';
import { useDrafts } from '../../../components/settings/drafts.ts';
import { AREAS, type Area } from '../../../components/settings/meta.ts';
import { Badge, cx, Notice, PageHeader, Row, RowGroup, Skeleton, toneSoft, type Tone } from '../../../components/ui.tsx';
import { errorMessage, get } from '../../../lib/api.ts';
import { plural } from '../../../lib/format.ts';
import { useHub } from '../../../store/hub.ts';

const STATUS: Record<ServiceHealth['status'], { label: string; tone: Tone }> = {
  ok: { label: 'Verbunden', tone: 'ok' },
  degraded: { label: 'Eingeschränkt', tone: 'warn' },
  offline: { label: 'Nicht erreichbar', tone: 'danger' },
  starting: { label: 'Startet …', tone: 'accent' },
  unconfigured: { label: 'Nicht eingerichtet', tone: 'neutral' },
};

function summary(area: Area, settings: IntegrationSettingsMap, counts: { contacts: number; speakers: number }, spotify: SpotifyStatus | undefined): string | null {
  switch (area.key) {
    case 'general':
      return `${settings.general.hubName} · Zwei-Faktor ${settings.general.requireTotp ? 'Pflicht' : 'freiwillig'}`;
    case 'mygekko':
      return settings.mygekko.enabled ? `${settings.mygekko.mode === 'local' ? settings.mygekko.host : 'myGEKKO Plus'} · ${counts.contacts} ${plural(counts.contacts, 'Kontakt', 'Kontakte')}` : null;
    case 'doorbird':
      return settings.doorbird.enabled ? `${settings.doorbird.devices.length} ${plural(settings.doorbird.devices.length, 'Türstation', 'Türstationen')}` : null;
    case 'reolink':
      return settings.reolink.enabled ? `${settings.reolink.devices.length} ${plural(settings.reolink.devices.length, 'Kamera', 'Kameras')}` : null;
    case 'sonos':
      return settings.sonos.enabled ? `${counts.speakers} Lautsprecher` : null;
    case 'spotify':
      return settings.spotify.enabled ? (spotify?.linked ? `Verbunden mit ${spotify.account ?? 'deinem Konto'}` : 'Noch kein Konto verbunden') : null;
  }
}

export function ServicesPage() {
  const navigate = useNavigate();
  const services = useHub((state) => state.services);
  const contacts = useHub((state) => Object.values(state.entities).filter((entity) => entity.kind === 'contact').length);
  const speakers = useHub((state) => state.music.players.length);
  const drafts = useDrafts((state) => state.drafts);
  const query = useQuery({ queryKey: ['settings-all'], queryFn: () => get<{ settings: IntegrationSettingsMap; demo: boolean }>('/api/admin/settings'), staleTime: 0 });
  const spotify = useQuery({ queryKey: ['spotify-status'], queryFn: () => get<SpotifyStatus>('/api/spotify/status'), staleTime: 30_000 });
  const media = services.media;

  return (
    <>
      <PageHeader title="Geräte & Dienste" subtitle="Was dein Zuhause mit der App verbindet" back="/einstellungen" />
      {query.data?.demo && (
        <Notice tone="accent" icon={FlaskConical} className="mb-4">
          Demo-Modus: Alle Geräte sind simuliert. Du kannst dir die Einstellungen ansehen, aber nichts daran ändern.
        </Notice>
      )}
      {query.isError && (
        <Notice tone="danger" className="mb-4">
          {errorMessage(query.error)}
        </Notice>
      )}
      <div className="grid gap-2.5 lg:grid-cols-2">
        {AREAS.map((area) => {
          const health = area.service ? services[area.service] : undefined;
          const status = health ? STATUS[health.status] : null;
          const line = query.data ? summary(area, query.data.settings, { contacts, speakers }, spotify.data) : null;
          return (
            <button
              key={area.key}
              type="button"
              onClick={() => navigate(`/einstellungen/dienste/${area.key}`)}
              className="flex items-start gap-3.5 rounded-tile bg-surface p-4 text-left shadow-tile transition hover:bg-raised active:scale-[0.99]"
            >
              <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-full', toneSoft[area.tone])}>
                <area.icon className="size-5.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">{area.title}</span>
                  {status && <Badge tone={status.tone}>{status.label}</Badge>}
                  {drafts[area.key] !== undefined && <Badge tone="warn">Nicht gespeichert</Badge>}
                </span>
                <span className="mt-0.5 block text-sm text-muted">{area.purpose}</span>
                {query.isPending ? (
                  <Skeleton className="mt-2 h-4 w-40 rounded-md bg-sunken" />
                ) : (
                  (health?.message || line) && <span className={cx('mt-1.5 block text-sm', health?.message && health.status !== 'ok' ? 'text-warn' : 'text-fg/80')}>{health?.message && health.status !== 'ok' ? health.message : line}</span>
                )}
              </span>
              <ChevronRight className="mt-3 size-4.5 shrink-0 text-faint" aria-hidden />
            </button>
          );
        })}
      </div>

      <RowGroup className="mt-6">
        <Row
          icon={Activity}
          tone={media?.status === 'ok' ? 'ok' : media?.status === 'offline' ? 'danger' : 'neutral'}
          title="Video-Dienst"
          subtitle={<span className="whitespace-normal">{media?.message ?? 'Überträgt die Live-Bilder von Kameras und Türstationen'}</span>}
          trailing={
            <>
              {media && <Badge tone={STATUS[media.status].tone}>{STATUS[media.status].label}</Badge>}
              <ChevronRight className="size-4.5 text-faint" aria-hidden />
            </>
          }
          onClick={() => navigate('/einstellungen/diagnose')}
        />
      </RowGroup>
    </>
  );
}
