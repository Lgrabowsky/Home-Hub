import { Check, ChevronDown, Copy } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SERVICE_LABELS, type DiagnosticsReport, type ServiceHealth } from '@home-hub/shared';
import { Badge, Button, Card, Notice, PageHeader, Row, RowGroup, Section, Spinner, type Tone } from '../../../components/ui.tsx';
import { errorMessage, get } from '../../../lib/api.ts';
import { formatAgo } from '../../../lib/format.ts';

const STATUS: Record<ServiceHealth['status'], { label: string; tone: Tone }> = {
  ok: { label: 'Verbunden', tone: 'ok' },
  degraded: { label: 'Eingeschränkt', tone: 'warn' },
  offline: { label: 'Nicht erreichbar', tone: 'danger' },
  starting: { label: 'Startet …', tone: 'accent' },
  unconfigured: { label: 'Nicht eingerichtet', tone: 'neutral' },
};

const COUNT_LABELS: Record<string, string> = {
  light: 'Lichter',
  blind: 'Jalousien',
  switch: 'Schaltbare Geräte',
  climate: 'Raumregler',
  action: 'Szenen',
  clock: 'Zeitschaltuhren',
  contact: 'Fenster-/Türkontakte',
  alarm: 'Alarmzonen',
  sensor: 'Messwerte',
  camera: 'Kameras',
  door: 'Türstationen',
  speaker: 'Lautsprecher',
  app: 'Verbundene Apps',
};

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days} T ${hours} Std.` : hours > 0 ? `${hours} Std. ${minutes} Min.` : `${minutes} Min.`;
}

export function DiagnosticsPage() {
  const [copied, setCopied] = useState(false);
  const query = useQuery({ queryKey: ['diagnostics'], queryFn: () => get<DiagnosticsReport>('/api/admin/diagnostics'), refetchInterval: 5000 });
  const report = query.data;

  return (
    <>
      <PageHeader title="Diagnose" subtitle={report ? `Version ${report.version} · läuft seit ${uptime(report.uptimeSec)}` : undefined} back="/einstellungen" />
      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-7" />
        </div>
      ) : !report ? (
        <Notice tone="danger">{errorMessage(query.error)}</Notice>
      ) : (
        <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-8">
          <div>
            <Section title="Dienste">
              <RowGroup>
                {report.services.map((service) => (
                  <Row
                    key={service.id}
                    title={SERVICE_LABELS[service.id]}
                    subtitle={
                      <span className="whitespace-normal">
                        {service.message ?? (service.status === 'ok' ? 'Alles in Ordnung' : service.status === 'unconfigured' ? 'In den Einstellungen noch nicht aktiviert' : '')}
                        {service.status !== 'ok' && service.lastOkAt ? ` · zuletzt erreichbar ${formatAgo(service.lastOkAt)}` : ''}
                      </span>
                    }
                    trailing={<Badge tone={STATUS[service.status].tone}>{STATUS[service.status].label}</Badge>}
                  />
                ))}
              </RowGroup>
            </Section>

            <Section title="Video-Dienst">
              <RowGroup>
                <Row title="Zustand" trailing={<Badge tone={report.media.running ? 'ok' : 'neutral'}>{report.media.running ? `Läuft${report.media.version ? ` (${report.media.version})` : ''}` : 'Läuft nicht'}</Badge>} />
                <Row title="Video-Streams" trailing={String(report.media.streams)} />
                <Row
                  title="Adressen für den Zugriff von außen"
                  subtitle={<span className="whitespace-normal">{report.media.candidates.length > 0 ? report.media.candidates.join(', ') : 'Keine eingetragen – Live-Video läuft im Heimnetz und über VPN. Für direkten Zugriff aus dem Internet muss der Medien-Port (8555) erreichbar sein.'}</span>}
                />
              </RowGroup>
            </Section>
          </div>

          <div>
            <Section title="Geräte">
              <Card className="grid grid-cols-2 gap-x-4 gap-y-2.5 p-4 sm:grid-cols-3">
                {Object.entries(report.counts).map(([key, count]) => (
                  <div key={key}>
                    <p className="text-2xl font-bold tabular-nums">{count}</p>
                    <p className="text-[13px] text-muted">{COUNT_LABELS[key] ?? key}</p>
                  </div>
                ))}
              </Card>
            </Section>

            <Section
              title="Details für den Support"
              action={
                <Button
                  size="sm"
                  icon={copied ? Check : Copy}
                  onClick={() => void navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2500); })}
                >
                  {copied ? 'Kopiert' : 'Kopieren'}
                </Button>
              }
            >
              <p className="mb-2.5 px-1 text-sm text-muted">Der Bericht enthält keine Passwörter, aber Gerätenamen und Adressen deines Heimnetzes. Wirf vor dem Weitergeben einen Blick darauf.</p>
              <div className="space-y-2">
                {Object.entries(report.raw).map(([key, value]) => (
                  <details key={key} className="group rounded-tile bg-surface shadow-tile">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 font-medium">
                      {SERVICE_LABELS[key as keyof typeof SERVICE_LABELS] ?? key}
                      <ChevronDown className="size-4.5 text-faint transition group-open:rotate-180" aria-hidden />
                    </summary>
                    <pre className="scroll-area max-h-80 overflow-auto border-t border-line px-4 py-3 font-mono text-xs leading-relaxed text-muted">{JSON.stringify(value, null, 2) ?? 'null'}</pre>
                  </details>
                ))}
              </div>
            </Section>
            <p className="px-1 text-xs text-faint">Node {report.node}</p>
          </div>
        </div>
      )}
    </>
  );
}
