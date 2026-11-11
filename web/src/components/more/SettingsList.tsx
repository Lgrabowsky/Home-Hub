import { Activity, ChevronRight, HardDrive, LogOut, MonitorSmartphone, Palette, ScrollText, Server, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '@home-hub/shared';
import { isNative } from '../../lib/platform.ts';
import { useTheme, type ThemeChoice } from '../../lib/theme.ts';
import { useHub } from '../../store/hub.ts';
import { useIsAdmin, useSession } from '../../store/session.ts';
import { Badge, ConfirmDialog, Row, RowGroup, Section, Segmented } from '../ui.tsx';

const chevron = <ChevronRight className="size-4.5 text-faint" aria-hidden />;

export function ProfileCard() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  if (!user) return null;
  const initials = user.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <button
      type="button"
      onClick={() => navigate('/einstellungen/konto')}
      className="mb-7 flex w-full items-center gap-4 rounded-tile bg-surface p-4 text-left shadow-tile transition hover:bg-raised active:scale-[0.99]"
    >
      <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent/20 text-lg font-bold text-accent">{initials || '?'}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-semibold">{user.displayName}</span>
        <span className="block truncate text-sm text-muted">
          {ROLE_LABELS[user.role]} · Konto & Sicherheit
        </span>
      </span>
      {chevron}
    </button>
  );
}

/** The settings entries; shared by "Mehr" and "Einstellungen". */
export function SettingsList() {
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const theme = useTheme();
  const hubUrl = useSession((state) => state.hubUrl);
  const services = useHub((state) => state.services);
  const hubName = useHub((state) => state.hubName);
  const [confirm, setConfirm] = useState<'logout' | 'forget' | null>(null);
  const troubled = Object.values(services).filter((service) => service && (service.status === 'offline' || service.status === 'degraded')).length;

  return (
    <>
      <Section title="Einstellungen">
        <RowGroup>
          <Row icon={ShieldCheck} tone="accent" title="Konto & Sicherheit" subtitle="Passwort, Zwei-Faktor, angemeldete Geräte" trailing={chevron} onClick={() => navigate('/einstellungen/konto')} />
          {/* Not a <Row>: the switch needs the width, the label must not be squeezed to "Dar…". */}
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
            <span className="flex items-center gap-3 font-medium">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Palette className="size-4.5" aria-hidden />
              </span>
              Darstellung
            </span>
            <Segmented<ThemeChoice>
              value={theme.choice}
              onChange={theme.setChoice}
              options={[
                { value: 'system', label: 'Automatisch' },
                { value: 'dark', label: 'Dunkel' },
                { value: 'light', label: 'Hell' },
              ]}
            />
          </div>
        </RowGroup>
      </Section>

      {isAdmin && (
        <Section title="Verwaltung">
          <RowGroup>
            <Row
              icon={Server}
              tone="accent"
              title="Geräte & Dienste"
              subtitle="Gebäude, Türstationen, Kameras, Lautsprecher, Spotify"
              trailing={
                <>
                  {troubled > 0 && <Badge tone="warn">{troubled === 1 ? '1 Problem' : `${troubled} Probleme`}</Badge>}
                  {chevron}
                </>
              }
              onClick={() => navigate('/einstellungen/dienste')}
            />
            <Row icon={Users} tone="accent" title="Benutzer" subtitle="Wer darf was" trailing={chevron} onClick={() => navigate('/einstellungen/benutzer')} />
            <Row icon={ScrollText} tone="accent" title="Protokoll" subtitle="Anmeldungen, Türöffnungen, Änderungen" trailing={chevron} onClick={() => navigate('/einstellungen/protokoll')} />
            <Row icon={Activity} tone="accent" title="Diagnose" subtitle="Zustand aller Verbindungen" trailing={chevron} onClick={() => navigate('/einstellungen/diagnose')} />
          </RowGroup>
        </Section>
      )}

      <Section>
        <RowGroup>
          {isNative && <Row icon={HardDrive} title="Verbundener Hub" subtitle={hubUrl.replace(/^https:\/\//, '')} trailing="Wechseln" onClick={() => setConfirm('forget')} />}
          <Row icon={LogOut} tone="danger" title="Abmelden" onClick={() => setConfirm('logout')} />
        </RowGroup>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-faint">
          <MonitorSmartphone className="size-3.5" aria-hidden />
          {hubName} · Home Hub {__APP_VERSION__}
        </p>
      </Section>

      <ConfirmDialog
        open={confirm === 'logout'}
        onClose={() => setConfirm(null)}
        title="Abmelden?"
        text="Du musst dich danach mit Passwort und Code neu anmelden."
        confirmLabel="Abmelden"
        danger
        onConfirm={() => useSession.getState().logout()}
      />
      <ConfirmDialog
        open={confirm === 'forget'}
        onClose={() => setConfirm(null)}
        title="Hub wechseln?"
        text="Die App vergisst die Adresse dieses Hubs und deine Anmeldung auf diesem Gerät."
        confirmLabel="Hub wechseln"
        danger
        onConfirm={() => useSession.getState().forgetHub()}
      />
    </>
  );
}
