import { Check, Copy, EyeOff, Fingerprint, KeyRound, LogOut, Monitor, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_LABELS, type SessionInfo, type TotpEnableResponse, type TotpSetupResponse } from '@home-hub/shared';
import { QrCode } from '../../components/QrCode.tsx';
import { toast } from '../../components/toast.tsx';
import { Badge, Button, ConfirmDialog, Field, Notice, PageHeader, Row, RowGroup, Section, Sheet, Spinner, TextInput, Toggle } from '../../components/ui.tsx';
import { del, errorMessage, get, post } from '../../lib/api.ts';
import { formatAgo, formatDate } from '../../lib/format.ts';
import { isNative } from '../../lib/platform.ts';
import { useSession } from '../../store/session.ts';

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-3 text-sm text-muted">Mit einem dieser Codes kommst du auch ohne Telefon hinein. Jeder gilt einmal. Bewahre sie sicher auf – sie werden nicht noch einmal angezeigt.</p>
      <div className="grid grid-cols-2 gap-2 rounded-tile bg-sunken p-4 font-mono text-[15px]">
        {codes.map((code) => (
          <span key={code} className="text-center tracking-wider">
            {code}
          </span>
        ))}
      </div>
      <Button block className="mt-3" icon={copied ? Check : Copy} onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).then(() => setCopied(true))}>
        {copied ? 'Kopiert' : 'Kopieren'}
      </Button>
    </div>
  );
}

function PasswordSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCurrent('');
    setNext('');
    setRepeat('');
    setError(null);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== repeat) {
      setError('Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/password', { current, next });
      toast.success('Passwort geändert. Alle anderen Geräte wurden abgemeldet.');
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={close} title="Passwort ändern">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Aktuelles Passwort">
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="Neues Passwort" hint="Mindestens 10 Zeichen.">
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Neues Passwort wiederholen">
          <TextInput type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" block loading={busy} disabled={!current || !next || !repeat}>
          Passwort ändern
        </Button>
      </form>
    </Sheet>
  );
}

type TotpFlow = { step: 'closed' } | { step: 'scan'; setup: TotpSetupResponse } | { step: 'codes'; codes: string[] } | { step: 'password'; purpose: 'disable' | 'codes' };

function TwoFactor() {
  const user = useSession((state) => state.user);
  const refresh = useSession((state) => state.refresh);
  const [flow, setFlow] = useState<TotpFlow>({ step: 'closed' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const close = () => {
    setFlow({ step: 'closed' });
    setCode('');
    setPassword('');
    setError(null);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Zwei-Faktor-Anmeldung">
      <RowGroup>
        <Row
          icon={user.totpEnabled ? ShieldCheck : ShieldOff}
          tone={user.totpEnabled ? 'ok' : 'warn'}
          title={user.totpEnabled ? 'Aktiv' : 'Nicht eingerichtet'}
          subtitle={user.totpEnabled ? 'Beim Anmelden wird ein Code aus deiner Authenticator-App verlangt.' : 'Schütze dein Konto zusätzlich mit einem Code aus einer Authenticator-App.'}
          trailing={
            user.totpEnabled ? (
              <Badge tone="ok">An</Badge>
            ) : (
              <Button size="sm" variant="primary" loading={busy} onClick={() => void run(async () => setFlow({ step: 'scan', setup: await post<TotpSetupResponse>('/api/auth/totp/setup') }))}>
                Einrichten
              </Button>
            )
          }
        />
        {user.totpEnabled && <Row icon={KeyRound} title="Neue Wiederherstellungscodes" subtitle="Die bisherigen Codes werden ungültig." onClick={() => setFlow({ step: 'password', purpose: 'codes' })} />}
        {user.totpEnabled && <Row icon={ShieldOff} tone="danger" title="Zwei-Faktor-Anmeldung deaktivieren" onClick={() => setFlow({ step: 'password', purpose: 'disable' })} />}
      </RowGroup>
      {error && flow.step === 'closed' && (
        <Notice tone="danger" className="mt-2">
          {error}
        </Notice>
      )}

      <Sheet open={flow.step === 'scan'} onClose={close} title="Zweiten Faktor einrichten">
        {flow.step === 'scan' && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await post<TotpEnableResponse>('/api/auth/totp/enable', { code });
                await refresh();
                setCode('');
                setFlow({ step: 'codes', codes: result.recoveryCodes });
              });
            }}
          >
            <div className="flex flex-col items-center gap-3">
              <QrCode value={flow.setup.otpauthUrl} label="QR-Code für die Authenticator-App" />
              <code className="select-all break-all rounded-lg bg-sunken px-3 py-1.5 text-center font-mono text-sm tracking-wider">{flow.setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            </div>
            <Field label="6-stelliger Code aus der App">
              <TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className="text-center font-mono text-2xl tracking-[0.5em]" />
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button type="submit" variant="primary" block loading={busy} disabled={code.length !== 6}>
              Aktivieren
            </Button>
          </form>
        )}
      </Sheet>

      <Sheet open={flow.step === 'codes'} onClose={close} title="Wiederherstellungscodes" footer={<Button block variant="primary" onClick={close}>Ich habe die Codes gesichert</Button>}>
        {flow.step === 'codes' && <RecoveryCodes codes={flow.codes} />}
      </Sheet>

      <Sheet open={flow.step === 'password'} onClose={close} title={flow.step === 'password' && flow.purpose === 'disable' ? 'Zwei-Faktor deaktivieren' : 'Neue Wiederherstellungscodes'}>
        {flow.step === 'password' && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const purpose = flow.purpose;
              void run(async () => {
                if (purpose === 'disable') {
                  const result = await post<{ requireTotp: boolean }>('/api/auth/totp/disable', { password });
                  await refresh();
                  close();
                  toast.info(result.requireTotp ? 'Deaktiviert. Bei der nächsten Anmeldung musst du den zweiten Faktor neu einrichten.' : 'Zwei-Faktor-Anmeldung deaktiviert.');
                } else {
                  const result = await post<{ recoveryCodes: string[] }>('/api/auth/recovery-codes', { password });
                  setPassword('');
                  setFlow({ step: 'codes', codes: result.recoveryCodes });
                }
              });
            }}
          >
            <p className="text-sm text-muted">Bestätige mit deinem Passwort.</p>
            <Field label="Passwort">
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button type="submit" variant={flow.purpose === 'disable' ? 'danger' : 'primary'} block loading={busy} disabled={!password}>
              {flow.purpose === 'disable' ? 'Deaktivieren' : 'Neue Codes erzeugen'}
            </Button>
          </form>
        )}
      </Sheet>
    </Section>
  );
}

function describeDevice(session: SessionInfo): string {
  if (session.deviceName) return session.deviceName;
  const ua = session.userAgent ?? '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Unbekanntes Gerät';
  return os ? `${browser} (${os})` : browser;
}

function Sessions() {
  const client = useQueryClient();
  const [confirmOthers, setConfirmOthers] = useState(false);
  const query = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ sessions: SessionInfo[] }>('/api/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/auth/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Gerät abgemeldet');
      void client.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => toast.fromError(err),
  });
  const sessions = query.data?.sessions ?? [];
  return (
    <Section title="Angemeldete Geräte">
      {query.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <RowGroup>
          {sessions.map((session) => (
            <Row
              key={session.id}
              icon={session.client === 'native' ? Smartphone : Monitor}
              tone={session.current ? 'accent' : 'neutral'}
              title={describeDevice(session)}
              subtitle={`${session.current ? 'Dieses Gerät · ' : ''}aktiv ${formatAgo(session.lastSeenAt)} · angemeldet seit ${formatDate(session.createdAt)}`}
              trailing={
                session.current ? (
                  <Badge tone="accent">Aktuell</Badge>
                ) : (
                  <Button size="sm" variant="ghost" icon={LogOut} loading={revoke.isPending && revoke.variables === session.id} onClick={() => revoke.mutate(session.id)}>
                    Abmelden
                  </Button>
                )
              }
            />
          ))}
          {sessions.length > 1 && <Row icon={LogOut} tone="danger" title="Alle anderen Geräte abmelden" onClick={() => setConfirmOthers(true)} />}
        </RowGroup>
      )}
      <ConfirmDialog
        open={confirmOthers}
        onClose={() => setConfirmOthers(false)}
        title="Alle anderen Geräte abmelden?"
        text="Nur dieses Gerät bleibt angemeldet."
        confirmLabel="Abmelden"
        danger
        onConfirm={async () => {
          await post('/api/auth/sessions/revoke-others').then(
            () => toast.success('Alle anderen Geräte wurden abgemeldet'),
            (err: unknown) => toast.fromError(err),
          );
          void client.invalidateQueries({ queryKey: ['sessions'] });
        }}
      />
    </Section>
  );
}

export function AccountPage() {
  const user = useSession((state) => state.user);
  const lockEnabled = useSession((state) => state.lockEnabled);
  const privacyEnabled = useSession((state) => state.privacyEnabled);
  const [passwordOpen, setPasswordOpen] = useState(false);
  if (!user) return null;
  return (
    <>
      <PageHeader title="Konto & Sicherheit" back="/einstellungen" />
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-8">
        <div>
          <Section title="Profil">
            <RowGroup>
              <Row title="Name" trailing={user.displayName} />
              <Row title="Benutzername" trailing={user.username} />
              <Row title="Rolle" trailing={ROLE_LABELS[user.role]} />
              <Row icon={KeyRound} tone="accent" title="Passwort ändern" onClick={() => setPasswordOpen(true)} />
            </RowGroup>
          </Section>
          <TwoFactor />
          {isNative && (
            <Section title="Auf diesem Gerät">
              <RowGroup>
                <Row
                  icon={Fingerprint}
                  tone={lockEnabled ? 'ok' : 'neutral'}
                  title="Mit Fingerabdruck oder Gesicht entsperren"
                  subtitle="Beim Öffnen der App und nach einer Minute im Hintergrund."
                  trailing={
                    <Toggle
                      checked={lockEnabled}
                      label="App-Sperre"
                      onChange={(next) =>
                        void useSession
                          .getState()
                          .setLockEnabled(next)
                          .catch((err: unknown) => toast.error(err instanceof Error && err.name === 'ApiError' ? err.message : 'Die App-Sperre konnte nicht geändert werden.'))
                      }
                    />
                  }
                />
                <Row
                  icon={EyeOff}
                  tone={privacyEnabled ? 'ok' : 'neutral'}
                  title="Inhalt in der App-Übersicht verbergen"
                  subtitle="Zeigt in der Übersicht der geöffneten Apps eine leere Kachel und verhindert Bildschirmfotos."
                  trailing={
                    <Toggle
                      checked={privacyEnabled}
                      label="Inhalt in der App-Übersicht verbergen"
                      onChange={(next) =>
                        void useSession
                          .getState()
                          .setPrivacyEnabled(next)
                          .catch(() => toast.error('Die Einstellung konnte nicht geändert werden.'))
                      }
                    />
                  }
                />
              </RowGroup>
            </Section>
          )}
        </div>
        <Sessions />
      </div>
      <PasswordSheet open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
