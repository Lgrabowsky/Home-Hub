import { Check, Copy, ExternalLink, Unlink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpotifyStatus } from '@home-hub/shared';
import { errorMessage, get, post } from '../../lib/api.ts';
import { isNative } from '../../lib/platform.ts';
import { toast } from '../toast.tsx';
import { Badge, Button, Card, ConfirmDialog, Field, IconButton, Notice, RowGroup, Section, Segmented, Spinner, TextInput } from '../ui.tsx';
import type { FormProps } from './meta.ts';
import { ChipsInput, HowTo, isHost, SecretInput, SwitchRow } from './parts.tsx';

export function SonosForm({ value, onChange }: FormProps<'sonos'>) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="Sonos verwenden" subtitle="Lautsprecher in der App anzeigen, gruppieren und bespielen." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="music" />
        </RowGroup>
      </Section>
      <Section title="Lautsprecher finden">
        <HowTo
          title="In der Sonos-App vorbereiten"
          steps={[
            <>Unter „Konto › Datenschutz & Sicherheit“ muss „UPnP“ eingeschaltet sein – darüber steuert der Hub die Lautsprecher im Heimnetz.</>,
            <>Damit Musik von Spotify läuft, muss Spotify in der Sonos-App als Musikdienst hinzugefügt sein.</>,
          ]}
        />
        <Card className="space-y-4 p-4">
          <Field label="Adressen der Lautsprecher (optional)" hint="Leer lassen, um automatisch zu suchen. Nur nötig, wenn die Suche nichts findet – dann genügt die IP-Adresse eines einzigen Lautsprechers.">
            <ChipsInput value={value.hosts} onChange={(hosts) => set({ hosts })} placeholder="192.168.1.40" validate={isHost} />
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium">Spotify-Region deines Sonos-Kontos</p>
            <Segmented
              value={value.spotifyRegion}
              onChange={(spotifyRegion) => set({ spotifyRegion })}
              options={[
                { value: 'EU', label: 'Europa' },
                { value: 'US', label: 'USA' },
              ]}
            />
            <p className="mt-1.5 text-sm text-faint">Nur umstellen, wenn Titel von Spotify nicht starten.</p>
          </div>
        </Card>
      </Section>
    </>
  );
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="-ml-4.5 mt-2 flex items-center gap-1 rounded-control bg-surface py-1 pl-3.5 pr-1">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px]">{text}</code>
      <IconButton
        size="sm"
        icon={copied ? Check : Copy}
        label={copied ? 'Kopiert' : 'Adresse kopieren'}
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          })
        }
      />
    </div>
  );
}

export function SpotifyForm({ value, saved, onChange, dirty, save }: FormProps<'spotify'>) {
  const client = useQueryClient();
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes });
  const [linking, setLinking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const deadline = useRef(0);
  const status = useQuery({
    queryKey: ['spotify-status'],
    queryFn: () => get<SpotifyStatus>('/api/spotify/status'),
    // While the consent screen is open in another tab, watch for the result.
    refetchInterval: linking ? 2000 : false,
    staleTime: 0,
  });
  const linked = status.data?.linked ?? false;

  useEffect(() => {
    if (!linking) return;
    if (linked) {
      setLinking(false);
      toast.success('Spotify ist verbunden');
      void client.invalidateQueries({ queryKey: ['spotify'] });
    } else if (Date.now() > deadline.current) {
      setLinking(false);
      setError('Die Verbindung wurde nicht abgeschlossen. Bitte versuche es noch einmal.');
    }
  }, [linking, linked, status.dataUpdatedAt, client]);

  const connect = async () => {
    setError(null);
    setStarting(true);
    try {
      if (dirty && !(await save())) return;
      const { url } = await post<{ url: string }>('/api/spotify/auth/start');
      // The consent screen belongs to Spotify: always the system browser, never inside the app's own web view.
      window.open(url, isNative ? '_system' : '_blank', 'noopener');
      deadline.current = Date.now() + 3 * 60_000;
      setLinking(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <Section>
        <RowGroup>
          <SwitchRow title="Spotify verwenden" subtitle="In deiner Musik suchen und stöbern; abgespielt wird über die Lautsprecher." checked={value.enabled} onChange={(enabled) => set({ enabled })} tone="music" />
        </RowGroup>
      </Section>

      <Section title="Eigene Spotify-App">
        <HowTo
          title="Einmalig bei Spotify einrichten (kostenlos, mit Premium-Konto)"
          steps={[
            <>
              Auf developer.spotify.com im „Dashboard“ mit deinem Spotify-Konto anmelden und „Create app“ wählen. Als API „Web API“ ankreuzen.
            </>,
            <>
              Bei „Redirect URIs“ genau diese Adresse eintragen:
              {status.data ? <CopyBox text={status.data.redirectUri} /> : <Spinner className="ml-2 inline size-4" />}
            </>,
            <>Die „Client ID“ der neuen App kopieren und unten einfügen.</>,
          ]}
        >
          {status.data && !/^(https:\/\/|http:\/\/(127\.0\.0\.1|\[::1\])[:/])/.test(status.data.redirectUri) && (
            <p className="mt-2 text-warn">Spotify akzeptiert nur https-Adressen. Öffne die App über die https-Adresse deines Hubs und richte Spotify von dort aus ein.</p>
          )}
        </HowTo>
        <Card className="space-y-4 p-4">
          <Field label="Client-ID" hint="Besteht aus 32 Buchstaben und Ziffern.">
            <TextInput value={value.clientId} onChange={(event) => set({ clientId: event.target.value.trim() })} maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono text-sm" />
          </Field>
          <Field label="Client-Secret (optional)" hint="Wird normalerweise nicht gebraucht – leer lassen.">
            <SecretInput value={value.clientSecret} stored={saved.clientSecret !== ''} onChange={(clientSecret) => set({ clientSecret })} />
          </Field>
          <Field label="Land" hint="Ländercode mit zwei Buchstaben; bestimmt, welche Titel verfügbar sind.">
            <TextInput value={value.market} onChange={(event) => set({ market: event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })} className="max-w-24 uppercase" />
          </Field>
        </Card>
      </Section>

      <Section title="Konto">
        <Card className="p-4">
          {status.isPending ? (
            <Spinner />
          ) : linked ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <Badge tone="ok">Verbunden</Badge>
                  <span className="truncate">{status.data?.account ?? 'Spotify-Konto'}</span>
                </p>
                <p className="mt-1 text-sm text-muted">Spotify verlangt etwa alle sechs Monate, die Verbindung zu erneuern.</p>
              </div>
              <Button icon={Unlink} onClick={() => setConfirmUnlink(true)}>
                Trennen
              </Button>
            </div>
          ) : (
            <div>
              <p className="text-muted">{value.clientId ? 'Noch kein Spotify-Konto verbunden.' : 'Trage zuerst die Client-ID ein, dann kannst du dein Konto verbinden.'}</p>
              <Button variant="primary" icon={ExternalLink} className="mt-3" disabled={!value.clientId || !value.enabled} loading={starting || linking} onClick={() => void connect()}>
                {linking ? 'Warte auf Spotify …' : 'Mit Spotify verbinden'}
              </Button>
              {!value.enabled && value.clientId && <p className="mt-2 text-sm text-muted">Schalte oben „Spotify verwenden“ ein.</p>}
              {linking && <p className="mt-2 text-sm text-muted">Spotify wurde in einem neuen Fenster geöffnet. Melde dich dort an und erlaube den Zugriff – diese Seite merkt es von selbst.</p>}
            </div>
          )}
          {error && (
            <Notice tone="danger" className="mt-3">
              {error}
            </Notice>
          )}
        </Card>
      </Section>

      <ConfirmDialog
        open={confirmUnlink}
        onClose={() => setConfirmUnlink(false)}
        title="Spotify trennen?"
        text="Suchen und Stöbern in Spotify ist dann nicht mehr möglich. Die Lautsprecher und ihre Favoriten funktionieren weiter."
        confirmLabel="Trennen"
        danger
        onConfirm={async () => {
          try {
            await post('/api/spotify/unlink');
            await status.refetch();
            toast.success('Spotify wurde getrennt');
          } catch (err) {
            toast.fromError(err);
          }
        }}
      />
    </>
  );
}
