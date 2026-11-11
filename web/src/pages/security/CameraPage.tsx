import { Camera, Lightbulb, Maximize, Minimize, Siren, Volume2, VolumeX } from 'lucide-react';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import type { CameraEntity, PtzPreset, StreamQuality } from '@home-hub/shared';
import { FavoriteRow } from '../../components/entities/sheets.tsx';
import { LiveView } from '../../components/LiveView.tsx';
import { PtzPad, TalkButton } from '../../components/security/controls.tsx';
import { toast } from '../../components/toast.tsx';
import { Button, ConfirmDialog, cx, EmptyState, IconButton, Notice, PageHeader, Segmented } from '../../components/ui.tsx';
import { useEntity } from '../../hooks/entities.ts';
import { useFullscreen } from '../../hooks/useFullscreen.ts';
import { get, post } from '../../lib/api.ts';
import type { LiveStatus } from '../../lib/live.ts';
import { haptic } from '../../lib/platform.ts';
import { useHub } from '../../store/hub.ts';
import { useCan } from '../../store/session.ts';

export function CameraPage() {
  const { id = '' } = useParams();
  const camera = useEntity<'camera'>(`cam:${id}`) as CameraEntity | undefined;
  const canView = useCan('cameras.view');
  const canControl = useCan('cameras.control');
  const frame = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(frame);
  const [quality, setQuality] = useState<StreamQuality>('main');
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [sound, setSound] = useState(false);
  const [talking, setTalking] = useState(false);
  const [confirmSiren, setConfirmSiren] = useState(false);

  const presets = useQuery({
    queryKey: ['camera-presets', id],
    queryFn: () => get<{ presets: PtzPreset[] }>(`/api/cameras/${encodeURIComponent(id)}/presets`),
    enabled: Boolean(camera?.features.presets && camera.available && canView),
    staleTime: 60_000,
  });

  if (!canView) {
    return (
      <>
        <PageHeader title="Kamera" back="/sicherheit" />
        <EmptyState icon={Camera} title="Kein Zugriff" text="Für Kameras fehlt dir die Berechtigung." />
      </>
    );
  }
  if (!camera) {
    return (
      <>
        <PageHeader title="Kamera" back="/sicherheit" />
        <EmptyState icon={Camera} title="Diese Kamera gibt es nicht (mehr)" />
      </>
    );
  }

  const act = async (path: string, body: unknown, done?: string) => {
    haptic();
    try {
      await post(`/api/cameras/${encodeURIComponent(id)}/${path}`, body);
      if (done) toast.success(done);
    } catch (err) {
      toast.fromError(err);
    }
  };
  const { features } = camera;
  const canMove = canControl && camera.available && (features.ptz || features.zoom);
  const fallbackToSd = quality === 'main' && status?.quality === 'sub';

  return (
    <>
      <PageHeader title={camera.name} subtitle={camera.room ?? camera.model ?? undefined} back="/sicherheit" />
      {!camera.available && (
        <Notice tone="warn" className="mb-4">
          Die Kamera ist gerade nicht erreichbar.
        </Notice>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start lg:gap-6">
        <div ref={frame} className={cx('relative overflow-hidden rounded-tile bg-black shadow-tile', fullscreen.active && 'flex items-center rounded-none')}>
          <LiveView
            entityId={camera.id}
            quality={quality}
            alt={`Live-Bild ${camera.name}`}
            poster={camera.available ? `/api/cameras/${encodeURIComponent(id)}/snapshot` : null}
            muted={!sound || talking}
            onStatus={setStatus}
            className={cx('w-full', fullscreen.active ? 'h-dvh' : 'aspect-video')}
          >
            <div className="absolute right-2.5 top-2.5 flex gap-1.5">
              {status?.hasAudio && (
                <IconButton
                  icon={sound ? Volume2 : VolumeX}
                  label={sound ? 'Ton aus' : 'Ton an'}
                  size="sm"
                  className="bg-black/50 text-white backdrop-blur hover:bg-black/70 hover:text-white"
                  onClick={() => setSound(!sound)}
                />
              )}
              {fullscreen.supported && (
                <IconButton
                  icon={fullscreen.active ? Minimize : Maximize}
                  label={fullscreen.active ? 'Vollbild beenden' : 'Vollbild'}
                  size="sm"
                  className="bg-black/50 text-white backdrop-blur hover:bg-black/70 hover:text-white"
                  onClick={fullscreen.toggle}
                />
              )}
            </div>
            {/* In fullscreen the controls float on the picture so the camera stays steerable. */}
            {fullscreen.active && canMove && (
              <div className="absolute bottom-5 right-5">
                <PtzPad cameraId={id} pan={features.ptz} zoom={features.zoom} overlay />
              </div>
            )}
            {fullscreen.active && canControl && features.talk && camera.available && (
              <div className="absolute bottom-5 left-5">
                <TalkButton entityId={camera.id} onTalking={setTalking} />
              </div>
            )}
          </LiveView>
        </div>

        <div className="mt-4 space-y-5 lg:mt-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'main', label: 'HD' },
                { value: 'sub', label: 'SD' },
              ]}
            />
            <div className="flex items-center gap-2">
              {features.light && canControl && (
                <IconButton
                  icon={Lightbulb}
                  label={camera.lightOn ? 'Licht ausschalten' : 'Licht einschalten'}
                  variant="filled"
                  tone="warm"
                  active={camera.lightOn === true}
                  disabled={!camera.available}
                  onClick={() => {
                    useHub.getState().patchEntity(camera.id, { lightOn: !camera.lightOn } as Partial<CameraEntity>);
                    void act('light', { on: !camera.lightOn });
                  }}
                />
              )}
              {features.siren && canControl && (
                <IconButton icon={Siren} label="Sirene auslösen" variant="filled" tone="danger" disabled={!camera.available} onClick={() => setConfirmSiren(true)} />
              )}
            </div>
          </div>
          {fallbackToSd && <p className="text-sm text-muted">HD kann dieses Gerät hier nicht abspielen – es läuft die SD-Ansicht.</p>}

          {(canMove || (canControl && features.talk)) && (
            <div className="flex flex-wrap items-center justify-center gap-6 rounded-tile bg-surface p-5 shadow-tile">
              {canMove && <PtzPad cameraId={id} pan={features.ptz} zoom={features.zoom} />}
              {canControl && features.talk && camera.available && <TalkButton entityId={camera.id} onTalking={setTalking} large />}
            </div>
          )}

          {features.presets && (presets.data?.presets.length ?? 0) > 0 && (
            <div>
              <p className="mb-2 px-0.5 text-sm font-medium text-muted">Positionen</p>
              <div className="flex flex-wrap gap-2">
                {presets.data!.presets.map((preset) => (
                  <Button key={preset.id} size="sm" disabled={!canControl || !camera.available} onClick={() => void act('preset', { id: preset.id })}>
                    {preset.name}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <FavoriteRow entity={camera} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmSiren}
        onClose={() => setConfirmSiren(false)}
        title="Sirene auslösen?"
        text="Die Kamera gibt einen lauten Alarmton aus."
        confirmLabel="Sirene auslösen"
        danger
        onConfirm={() => act('siren', {}, 'Sirene ausgelöst')}
      />
    </>
  );
}
