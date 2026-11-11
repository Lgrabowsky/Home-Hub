import { FlaskConical, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationSettingsMap, ServiceHealth, SettingsKey, TestResult } from '@home-hub/shared';
import { DoorBirdForm, ReolinkForm } from '../../../components/settings/DeviceForms.tsx';
import { setDraft, useDrafts } from '../../../components/settings/drafts.ts';
import { GeneralForm } from '../../../components/settings/GeneralForm.tsx';
import { areaOf, type Area, type FormProps } from '../../../components/settings/meta.ts';
import { SonosForm, SpotifyForm } from '../../../components/settings/MusicForms.tsx';
import { MyGekkoForm } from '../../../components/settings/MyGekkoForm.tsx';
import { TestOutcome } from '../../../components/settings/parts.tsx';
import { toast } from '../../../components/toast.tsx';
import { Badge, Button, IconButton, Notice, PageHeader, Spinner, type Tone } from '../../../components/ui.tsx';
import { errorMessage, get, post, put } from '../../../lib/api.ts';
import { useHub } from '../../../store/hub.ts';

const FORMS: { [K in SettingsKey]: ComponentType<FormProps<K>> } = {
  general: GeneralForm,
  mygekko: MyGekkoForm,
  doorbird: DoorBirdForm,
  reolink: ReolinkForm,
  sonos: SonosForm,
  spotify: SpotifyForm,
};

const STATUS: Record<ServiceHealth['status'], { label: string; tone: Tone }> = {
  ok: { label: 'Verbunden', tone: 'ok' },
  degraded: { label: 'Eingeschränkt', tone: 'warn' },
  offline: { label: 'Nicht erreichbar', tone: 'danger' },
  starting: { label: 'Startet …', tone: 'accent' },
  unconfigured: { label: 'Nicht eingerichtet', tone: 'neutral' },
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function Editor<K extends SettingsKey>({ area }: { area: Area & { key: K } }) {
  type Value = IntegrationSettingsMap[K];
  const key = area.key;
  const client = useQueryClient();
  const health = useHub((state) => (area.service ? state.services[area.service] : undefined));
  const query = useQuery({
    queryKey: ['settings', key],
    queryFn: () => get<{ value: Value; locked: boolean }>(`/api/admin/settings/${key}`),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const draft = useDrafts((state) => state.drafts[key]) as Value | undefined;
  const saved = query.data?.value;
  const locked = query.data?.locked ?? false;
  const value = draft ?? saved;
  const dirty = draft !== undefined && saved !== undefined && !same(draft, saved);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const top = useRef<HTMLDivElement>(null);

  // Closing the tab with unsaved edits would lose them (in-app navigation keeps them).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(
    () => () => {
      if (dirtyRef.current) toast.info(`Deine Änderungen an „${area.title}“ sind noch nicht gespeichert.`);
    },
    [area.title],
  );

  const onChange = useCallback(
    (next: Value) => {
      setDraft(key, saved !== undefined && same(next, saved) ? null : next);
      setResult(null);
    },
    [key, saved],
  );

  const test = useCallback((body: Value) => post<TestResult>(`/api/admin/settings/${key}/test`, body), [key]);

  const save = useCallback(async (): Promise<boolean> => {
    if (value === undefined) return false;
    setSaving(true);
    setError(null);
    try {
      const response = await put<{ value: Value }>(`/api/admin/settings/${key}`, value);
      client.setQueryData(['settings', key], { value: response.value, locked: false });
      setDraft(key, null);
      void client.invalidateQueries({ queryKey: ['settings-all'] });
      toast.success('Gespeichert');
      return true;
    } catch (err) {
      setError(errorMessage(err));
      top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return false;
    } finally {
      setSaving(false);
    }
  }, [client, key, value]);

  const runTest = async () => {
    if (value === undefined) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await test(value));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err), details: [] });
    } finally {
      setTesting(false);
    }
  };

  const Form = FORMS[key] as ComponentType<FormProps<K>>;
  const status = health ? STATUS[health.status] : null;

  return (
    <>
      <PageHeader title={area.title} subtitle={area.purpose} back="/einstellungen/dienste" />
      <div ref={top} className="scroll-mt-4" />
      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : value === undefined || saved === undefined ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <div className="max-w-2xl">
          {locked && (
            <Notice tone="accent" icon={FlaskConical} className="mb-4">
              Demo-Modus: Diese Geräte sind simuliert. Du kannst dir alles ansehen, aber nichts ändern.
            </Notice>
          )}
          {status && health && (
            <div className="mb-5 flex flex-wrap items-center gap-2 px-1 text-sm" role="status">
              <Badge tone={status.tone}>{status.label}</Badge>
              {health.message && <span className="text-muted">{health.message}</span>}
            </div>
          )}
          {error && (
            <Notice tone="danger" className="mb-4">
              <p className="font-medium text-fg">Das konnte nicht gespeichert werden</p>
              {error}
            </Notice>
          )}

          {/* A disabled fieldset switches off every control inside it — exactly what "locked" means. */}
          <fieldset disabled={locked} className="min-w-0">
            <Form value={value} saved={saved} onChange={onChange} test={test} dirty={dirty} save={save} />
          </fieldset>

          {!locked && (
            <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 mt-2 md:bottom-5">
              <div className="space-y-2.5 rounded-tile bg-raised p-3 shadow-float">
                {result && <TestOutcome result={result} onDismiss={() => setResult(null)} />}
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate pl-1 text-sm text-muted" role="status">
                    {dirty ? 'Noch nicht gespeichert' : 'Alles gespeichert'}
                  </p>
                  {dirty && <IconButton icon={Undo2} label="Änderungen verwerfen" onClick={() => { setDraft(key, null); setError(null); setResult(null); }} />}
                  {area.testable && (
                    <Button loading={testing} onClick={() => void runTest()}>
                      <span className="sm:hidden">Testen</span>
                      <span className="hidden sm:inline">Verbindung testen</span>
                    </Button>
                  )}
                  <Button variant="primary" disabled={!dirty} loading={saving} onClick={() => void save()}>
                    Speichern
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function ServiceSettingsPage() {
  const { key } = useParams();
  const area = areaOf(key);
  if (!area) return <Navigate to="/einstellungen/dienste" replace />;
  // Remount per area: each has its own draft, test result and scroll position.
  return <Editor key={area.key} area={area} />;
}
