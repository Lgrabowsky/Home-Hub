import { KeyRound, LogOut, Plus, ShieldOff, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSION_LABELS, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, ROLE_LABELS, ROLES, type Permission, type Role, type UserInfo } from '@home-hub/shared';
import { toast } from '../../../components/toast.tsx';
import { Badge, Button, ConfirmDialog, cx, Field, Notice, PageHeader, Row, RowGroup, Segmented, Sheet, Spinner, TextInput, Toggle } from '../../../components/ui.tsx';
import { del, errorMessage, get, patch, post } from '../../../lib/api.ts';
import { useSession } from '../../../store/session.ts';

const ROLE_HINTS: Record<Role, string> = {
  admin: 'Darf alles – auch Geräte, Benutzer und Einstellungen verwalten.',
  member: 'Darf alles bedienen, aber nichts an den Einstellungen ändern.',
  guest: 'Darf nur die Bereiche nutzen, die du unten auswählst.',
};

const WORDS = ['Apfel', 'Birke', 'Wolke', 'Fluss', 'Garten', 'Lampe', 'Mond', 'Nebel', 'Ofen', 'Pfad', 'Quelle', 'Regen', 'Sonne', 'Tanne', 'Ufer', 'Wiese', 'Ziegel', 'Brot', 'Kerze', 'Hafen', 'Insel', 'Feder', 'Stern', 'Wald'];

/** A passphrase that is strong and can be read out to someone. Shown once. */
function passphrase(): string {
  const pick = new Uint32Array(5);
  crypto.getRandomValues(pick);
  return [...pick.slice(0, 4)].map((n) => WORDS[n % WORDS.length]).join('-') + '-' + String(10 + (pick[4]! % 90));
}

function PermissionList({ role, value, onChange }: { role: Role; value: Permission[]; onChange(next: Permission[]): void }) {
  const fixed = role === 'admin';
  return (
    <RowGroup className="bg-sunken shadow-none">
      {PERMISSIONS.map((permission) => {
        const checked = fixed || value.includes(permission);
        return (
          <Row
            key={permission}
            tone={permission === 'doors.open' ? 'warn' : 'neutral'}
            icon={permission === 'doors.open' ? KeyRound : undefined}
            title={<span className={cx('whitespace-normal text-sm', permission === 'doors.open' && 'font-semibold')}>{PERMISSION_LABELS[permission]}</span>}
            trailing={
              <Toggle
                checked={checked}
                disabled={fixed}
                label={PERMISSION_LABELS[permission]}
                tone={permission === 'doors.open' ? 'warn' : 'accent'}
                onChange={(next) => onChange(next ? [...value, permission] : value.filter((entry) => entry !== permission))}
              />
            }
          />
        );
      })}
    </RowGroup>
  );
}

function RolePicker({ role, onChange }: { role: Role; onChange(role: Role): void }) {
  return (
    <div>
      <Segmented className="w-full" value={role} onChange={onChange} options={ROLES.map((entry) => ({ value: entry, label: ROLE_LABELS[entry] }))} />
      <p className="mt-1.5 text-sm text-faint">{ROLE_HINTS[role]}</p>
    </div>
  );
}

function CreateSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [permissions, setPermissions] = useState<Permission[]>([...ROLE_DEFAULT_PERMISSIONS.member]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ user: UserInfo }>('/api/users', { username, displayName: displayName || undefined, role, permissions, password }),
    onSuccess: ({ user }) => {
      toast.success(`${user.displayName} wurde angelegt`);
      void client.invalidateQueries({ queryKey: ['users'] });
      setDisplayName('');
      setUsername('');
      setPassword('');
      setError(null);
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Sheet open={open} onClose={onClose} title="Benutzer anlegen">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="z. B. Anna" autoComplete="off" />
        </Field>
        <Field label="Benutzername" hint="Zum Anmelden. Buchstaben, Ziffern, Punkt, Binde- oder Unterstrich.">
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="Erstes Passwort" hint="Mindestens 10 Zeichen. Gib es der Person persönlich – sie kann es danach selbst ändern.">
          <div className="flex gap-2">
            <TextInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
            <Button onClick={() => setPassword(passphrase())}>Vorschlag</Button>
          </div>
        </Field>
        <RolePicker
          role={role}
          onChange={(next) => {
            setRole(next);
            setPermissions([...ROLE_DEFAULT_PERMISSIONS[next]]);
          }}
        />
        <PermissionList role={role} value={permissions} onChange={setPermissions} />
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" block loading={create.isPending} disabled={!username || !password}>
          Anlegen
        </Button>
      </form>
    </Sheet>
  );
}

function EditSheet({ user, onClose }: { user: UserInfo | null; onClose(): void }) {
  const client = useQueryClient();
  const me = useSession((state) => state.user);
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'totp' | 'sessions' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName);
    setRole(user.role);
    setPermissions(user.permissions);
    setNewPassword('');
    setError(null);
  }, [user]);

  if (!user) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const self = user.id === me?.id;
  const done = (message: string) => {
    toast.success(message);
    void client.invalidateQueries({ queryKey: ['users'] });
  };
  const run = async (action: () => Promise<unknown>, message: string, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done(message);
      if (close) onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const path = `/api/users/${encodeURIComponent(user.id)}`;

  return (
    <Sheet open onClose={onClose} title={user.displayName} subtitle={`@${user.username}`}>
      <div className="space-y-4">
        <Field label="Name">
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        {self ? (
          <Notice>Das bist du. Deine eigene Rolle kannst du nicht ändern – so sperrt sich niemand versehentlich aus.</Notice>
        ) : (
          <>
            <RolePicker
              role={role}
              onChange={(next) => {
                setRole(next);
                setPermissions([...ROLE_DEFAULT_PERMISSIONS[next]]);
              }}
            />
            <PermissionList role={role} value={permissions} onChange={setPermissions} />
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button variant="primary" block loading={busy} onClick={() => void run(() => patch(path, self ? { displayName } : { displayName, role, permissions }), 'Gespeichert', true)}>
          Speichern
        </Button>

        <RowGroup className="bg-sunken shadow-none">
          <div className="space-y-2 p-4">
            <p className="text-sm font-medium">Passwort zurücksetzen</p>
            <div className="flex gap-2">
              <TextInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Neues Passwort" autoComplete="off" spellCheck={false} className="font-mono" />
              <Button onClick={() => setNewPassword(passphrase())}>Vorschlag</Button>
            </div>
            <Button block disabled={newPassword.length < 10} loading={busy} onClick={() => void run(() => post(`${path}/password`, { password: newPassword }), 'Passwort gesetzt – die Person wurde überall abgemeldet')}>
              Passwort setzen
            </Button>
          </div>
          {user.totpEnabled && <Row icon={ShieldOff} title="Zwei-Faktor zurücksetzen" subtitle="Bei verlorenem Telefon: wird beim nächsten Anmelden neu eingerichtet." onClick={() => setConfirm('totp')} />}
          <Row icon={LogOut} title="Überall abmelden" onClick={() => setConfirm('sessions')} />
          {!self && (
            <Row
              title="Konto deaktivieren"
              subtitle="Die Person kann sich nicht mehr anmelden."
              trailing={<Toggle checked={user.disabled} label="Konto deaktivieren" tone="danger" onChange={(next) => void run(() => patch(path, { disabled: next }), next ? 'Konto deaktiviert' : 'Konto wieder aktiv')} />}
            />
          )}
          {!self && <Row icon={Trash2} tone="danger" title="Benutzer löschen" onClick={() => setConfirm('delete')} />}
        </RowGroup>
      </div>

      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} title={`${user.displayName} löschen?`} text="Das Konto wird endgültig entfernt." confirmLabel="Löschen" danger onConfirm={() => run(() => del(path), 'Benutzer gelöscht', true)} />
      <ConfirmDialog open={confirm === 'totp'} onClose={() => setConfirm(null)} title="Zwei-Faktor zurücksetzen?" text="Die Person muss den zweiten Faktor beim nächsten Anmelden neu einrichten." confirmLabel="Zurücksetzen" danger onConfirm={() => run(() => post(`${path}/reset-totp`), 'Zwei-Faktor zurückgesetzt')} />
      <ConfirmDialog open={confirm === 'sessions'} onClose={() => setConfirm(null)} title="Überall abmelden?" text={self ? 'Alle deine anderen Geräte werden abgemeldet.' : 'Alle Geräte dieser Person werden abgemeldet.'} confirmLabel="Abmelden" danger onConfirm={() => run(() => post(`${path}/revoke-sessions`), 'Abgemeldet')} />
    </Sheet>
  );
}

export function UsersPage() {
  const me = useSession((state) => state.user);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['users'], queryFn: () => get<{ users: UserInfo[] }>('/api/users') });
  const users = query.data?.users ?? [];
  return (
    <>
      <PageHeader
        title="Benutzer"
        back="/einstellungen"
        actions={
          <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
            Anlegen
          </Button>
        }
      />
      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : query.isError ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <RowGroup>
          {users.map((user) => (
            <Row
              key={user.id}
              icon={UserRound}
              tone={user.disabled ? 'neutral' : user.role === 'admin' ? 'accent' : 'ok'}
              className={user.disabled ? 'opacity-60' : undefined}
              title={
                <>
                  {user.displayName}
                  {user.id === me?.id && <span className="ml-1.5 text-sm font-normal text-muted">(du)</span>}
                </>
              }
              subtitle={`@${user.username}`}
              trailing={
                <>
                  {user.disabled && <Badge tone="danger">Deaktiviert</Badge>}
                  {!user.totpEnabled && !user.disabled && <Badge tone="warn">2FA fehlt</Badge>}
                  <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
                </>
              }
              onClick={() => setEditing(user.id)}
            />
          ))}
        </RowGroup>
      )}
      <CreateSheet open={creating} onClose={() => setCreating(false)} />
      <EditSheet user={users.find((user) => user.id === editing) ?? null} onClose={() => setEditing(null)} />
    </>
  );
}
