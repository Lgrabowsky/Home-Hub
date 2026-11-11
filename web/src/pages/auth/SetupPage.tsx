import { ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Field, Notice, TextInput } from '../../components/ui.tsx';
import { errorMessage } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { AuthLayout } from './AuthLayout.tsx';

/** First start of a fresh hub: create the administrator. */
export function SetupPage() {
  const setup = useSession((state) => state.setup);
  const [setupCode, setSetupCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== repeat) {
      setError('Die beiden Passwörter stimmen nicht überein.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setup({ setupCode, username, password, displayName: displayName || undefined });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Home Hub einrichten" text="Lege das erste Konto an. Es verwaltet später Geräte und weitere Benutzer.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Einrichtungscode" hint="Steht beim ersten Start im Protokoll des Hubs (z. B. „docker logs home-hub“) und in der Datei setup-code.txt.">
          <TextInput value={setupCode} onChange={(e) => setSetupCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" className="font-mono tracking-widest" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoFocus required />
        </Field>
        <Field label="Dein Name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" placeholder="z. B. Lukas" />
        </Field>
        <Field label="Benutzername">
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        </Field>
        <Field label="Passwort" hint="Mindestens 10 Zeichen. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.">
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Passwort wiederholen">
          <TextInput type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={ShieldCheck} disabled={!setupCode || !username || !password || !repeat}>
          Konto anlegen
        </Button>
      </form>
    </AuthLayout>
  );
}
