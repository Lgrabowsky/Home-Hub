import { KeyRound, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, TextInput } from '../../components/ui.tsx';
import { errorMessage } from '../../lib/api.ts';
import { isNative } from '../../lib/platform.ts';
import { useSession } from '../../store/session.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function LoginPage() {
  const login = useSession((state) => state.login);
  const forgetHub = useSession((state) => state.forgetHub);
  const hubUrl = useSession((state) => state.hubUrl);
  const demo = useSession((state) => state.bootstrap?.demo);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login({ username, password, code: needCode ? code : undefined });
      if (result === 'totp_required') {
        setNeedCode(true);
        setCode('');
      }
    } catch (err) {
      setError(errorMessage(err));
      if (needCode) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={needCode ? 'Bestätigungscode' : 'Willkommen zuhause'}
      text={needCode ? (recovery ? 'Gib einen deiner Wiederherstellungscodes ein.' : 'Öffne deine Authenticator-App und gib den 6-stelligen Code ein.') : 'Melde dich an, um dein Zuhause zu steuern.'}
      footer={
        isNative ? (
          <button type="button" className="underline-offset-4 hover:underline" onClick={() => void forgetHub()}>
            Verbunden mit {hubUrl.replace(/^https:\/\//, '')} · ändern
          </button>
        ) : undefined
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {demo && !needCode && <Notice tone="accent">Demo-Modus: alle Geräte sind simuliert.</Notice>}
        {!needCode ? (
          <>
            <Field label="Benutzername">
              <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required />
            </Field>
            <Field label="Passwort">
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
          </>
        ) : (
          <Field label={recovery ? 'Wiederherstellungscode' : 'Code'}>
            <TextInput
              key={recovery ? 'recovery' : 'totp'}
              value={code}
              onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={recovery ? 'XXXXX-XXXXX' : '000000'}
              className={recovery ? 'text-center font-mono tracking-widest' : 'text-center font-mono text-2xl tracking-[0.5em]'}
              autoFocus
              required
            />
          </Field>
        )}
        {error && (
          <Notice tone="danger" icon={KeyRound}>
            {error}
          </Notice>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={LogIn} disabled={needCode ? code.length < 6 : !username || !password}>
          {needCode ? 'Bestätigen' : 'Anmelden'}
        </Button>
        {needCode && (
          <div className="flex justify-between text-sm text-muted">
            <button
              type="button"
              className="underline-offset-4 hover:underline"
              onClick={() => {
                setNeedCode(false);
                setError(null);
              }}
            >
              Zurück
            </button>
            <button
              type="button"
              className="underline-offset-4 hover:underline"
              onClick={() => {
                setRecovery(!recovery);
                setCode('');
                setError(null);
              }}
            >
              {recovery ? 'Code aus der App verwenden' : 'Kein Zugriff auf die App?'}
            </button>
          </div>
        )}
      </form>
    </AuthLayout>
  );
}
