import { Fingerprint, Link2, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Notice, Spinner, TextInput } from '../../components/ui.tsx';
import { errorMessage } from '../../lib/api.ts';
import { normaliseHubUrl } from '../../lib/hubUrl.ts';
import { isNative } from '../../lib/platform.ts';
import { useSession } from '../../store/session.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function LoadingPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <Spinner className="size-7" />
    </main>
  );
}

/** (App only) First start: where is the hub? */
export function ConnectPage() {
  const connectHub = useSession((state) => state.connectHub);
  const [url, setUrl] = useState('');
  const unencrypted = (() => {
    try {
      return url.trim() !== '' && !normaliseHubUrl(url).encrypted;
    } catch {
      return false;
    }
  })();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectHub(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Mit deinem Hub verbinden" text="Gib die Adresse ein, unter der dein Home Hub erreichbar ist – dieselbe, die du im Browser verwendest.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Adresse des Hubs" hint="Von unterwegs: die https-Adresse. Im eigenen WLAN geht auch die Adresse, die das Hub-Fenster am PC zeigt (http://…).">
          <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="zuhause.example.de" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required />
        </Field>
        {unencrypted && (
          <Notice tone="warn" icon={ShieldAlert}>
            Unverschlüsselte Verbindung: Das funktioniert nur im eigenen WLAN, und wer dort mitliest, könnte deine Anmeldung sehen. Für die Nutzung von unterwegs und dauerhaft: https einrichten (z. B. mit Tailscale).
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={Link2} disabled={!url.trim()}>
          Verbinden
        </Button>
      </form>
    </AuthLayout>
  );
}

/** The hub does not answer. Keeps trying on its own. */
export function UnreachablePage() {
  const init = useSession((state) => state.init);
  const forgetHub = useSession((state) => state.forgetHub);
  const hubUrl = useSession((state) => state.hubUrl);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => void init(), 5000);
    return () => window.clearInterval(timer);
  }, [init]);

  return (
    <AuthLayout
      title="Hub nicht erreichbar"
      text={
        isNative
          ? `Unter ${hubUrl.replace(/^https?:\/\//, '')} antwortet gerade niemand. Prüfe deine Internetverbindung – die App versucht es automatisch weiter.`
          : 'Der Hub antwortet gerade nicht. Die Seite versucht es automatisch weiter.'
      }
      footer={
        isNative ? (
          <button type="button" className="underline-offset-4 hover:underline" onClick={() => void forgetHub()}>
            Andere Adresse verwenden
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col items-center gap-5">
        <WifiOff className="size-10 text-faint" aria-hidden />
        <Button
          icon={RefreshCw}
          loading={busy}
          onClick={() => {
            setBusy(true);
            void init().finally(() => setBusy(false));
          }}
        >
          Jetzt erneut versuchen
        </Button>
      </div>
    </AuthLayout>
  );
}

export function OutdatedPage() {
  return (
    <AuthLayout title="Aktualisierung nötig" text="Diese Version der App passt nicht zur Version deines Hubs. Bitte aktualisiere die App bzw. den Hub.">
      <Button block icon={RefreshCw} onClick={() => window.location.reload()}>
        Neu laden
      </Button>
    </AuthLayout>
  );
}

/** (App only) Biometric lock. */
export function LockedPage() {
  const unlock = useSession((state) => state.unlock);
  const logout = useSession((state) => state.logout);
  const [failed, setFailed] = useState(false);

  const attempt = () => {
    setFailed(false);
    void unlock().then((ok) => setFailed(!ok));
  };
  // Ask right away — the user opened the app to use it.
  useEffect(attempt, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthLayout
      title="Home Hub ist gesperrt"
      text="Entsperre die App mit Fingerabdruck, Gesicht oder deiner Gerätesperre."
      footer={
        <button type="button" className="underline-offset-4 hover:underline" onClick={() => void logout()}>
          Abmelden
        </button>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <Button variant="primary" size="lg" icon={Fingerprint} onClick={attempt}>
          Entsperren
        </Button>
        {failed && <p className="text-sm text-muted">Entsperren abgebrochen.</p>}
      </div>
    </AuthLayout>
  );
}
