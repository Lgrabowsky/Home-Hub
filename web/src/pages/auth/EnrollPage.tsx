import { Check, Copy, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { TotpEnableResponse, TotpSetupResponse } from '@home-hub/shared';
import { QrCode } from '../../components/QrCode.tsx';
import { Button, Field, Notice, Spinner, TextInput } from '../../components/ui.tsx';
import { errorMessage, post } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { AuthLayout } from './AuthLayout.tsx';

/**
 * Mandatory second factor: scan the QR code with an authenticator app,
 * confirm with a code, then save the recovery codes.
 */
export function EnrollPage() {
  const finishEnrollment = useSession((state) => state.finishEnrollment);
  const logout = useSession((state) => state.logout);
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<TotpEnableResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    post<TotpSetupResponse>('/api/auth/totp/setup')
      .then((response) => !cancelled && setSetup(response))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await post<TotpEnableResponse>('/api/auth/totp/enable', { code }));
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const text = result.recoveryCodes.join('\n');
    return (
      <AuthLayout title="Wiederherstellungscodes" text="Falls du dein Telefon verlierst, kommst du mit einem dieser Codes trotzdem hinein. Jeder Code gilt einmal. Bewahre sie sicher auf – sie werden nicht noch einmal angezeigt.">
        <div className="grid grid-cols-2 gap-2 rounded-tile bg-surface p-4 font-mono text-[15px] shadow-tile">
          {result.recoveryCodes.map((entry) => (
            <span key={entry} className="text-center tracking-wider">
              {entry}
            </span>
          ))}
        </div>
        <div className="mt-4 space-y-2.5">
          <Button
            block
            icon={copied ? Check : Copy}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setCopied(true));
            }}
          >
            {copied ? 'Kopiert' : 'In die Zwischenablage kopieren'}
          </Button>
          <Button block variant="primary" size="lg" loading={busy} onClick={() => { setBusy(true); void finishEnrollment(result).catch((err) => { setError(errorMessage(err)); setBusy(false); }); }}>
            Ich habe die Codes gesichert
          </Button>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Zweiten Faktor einrichten"
      text="Dein Zuhause wird zusätzlich zum Passwort mit einem Code aus einer Authenticator-App geschützt (z. B. Aegis, 2FAS, Google oder Microsoft Authenticator)."
      footer={
        <button type="button" className="underline-offset-4 hover:underline" onClick={() => void logout()}>
          Abbrechen und abmelden
        </button>
      }
    >
      {!setup ? (
        error ? (
          <Notice tone="danger">{error}</Notice>
        ) : (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )
      ) : (
        <form onSubmit={confirm} className="space-y-4" noValidate>
          <div className="flex flex-col items-center gap-3 rounded-tile bg-surface p-5 shadow-tile">
            <QrCode value={setup.otpauthUrl} label="QR-Code für die Authenticator-App" />
            <p className="text-center text-sm text-muted">Oder Schlüssel von Hand eingeben:</p>
            <code className="select-all break-all rounded-lg bg-sunken px-3 py-1.5 text-center font-mono text-sm tracking-wider">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
          <Field label="6-stelliger Code aus der App">
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="text-center font-mono text-2xl tracking-[0.5em]"
              required
            />
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button type="submit" variant="primary" size="lg" block loading={busy} icon={ShieldCheck} disabled={code.length !== 6}>
            Aktivieren
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
