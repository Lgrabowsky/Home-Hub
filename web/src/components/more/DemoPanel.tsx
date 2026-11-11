import { BellRing, ChevronDown, FlaskConical, Footprints } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DemoState, DemoTrigger } from '@home-hub/shared';
import { get, post } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { toast } from '../toast.tsx';
import { Button, Notice, Row, Section, Toggle } from '../ui.tsx';

/**
 * Demo mode only: lets you make the simulated house do something, so the parts
 * of the app that react to the real world (doorbell, open windows) can be tried.
 */
export function DemoPanel() {
  const demo = useSession((state) => state.bootstrap?.demo ?? false);
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['demo-state'], queryFn: () => get<DemoState>('/api/demo/state'), enabled: demo, refetchInterval: 5000 });
  if (!demo) return null;
  const open = query.data?.contacts.filter((contact) => contact.open).length ?? 0;

  const trigger = (request: DemoTrigger, done?: string) =>
    post('/api/demo/trigger', request).then(
      () => {
        if (done) toast.info(done);
        void client.invalidateQueries({ queryKey: ['demo-state'] });
      },
      (err: unknown) => toast.fromError(err),
    );

  return (
    <Section title="Demo">
      <Notice tone="accent" icon={FlaskConical} className="mb-3">
        Alle Geräte sind simuliert. Hier kannst du das Haus etwas tun lassen – zum Beispiel klingeln – und sehen, wie die App reagiert.
      </Notice>
      {query.data && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {query.data.doors.map((door) => (
              <Button key={door.id} icon={BellRing} onClick={() => void trigger({ action: 'ring', door: door.id })}>
                {door.name}: klingeln
              </Button>
            ))}
            {query.data.doors.slice(0, 1).map((door) => (
              <Button key={door.id} icon={Footprints} variant="ghost" onClick={() => void trigger({ action: 'motion', door: door.id }, 'Bewegung ausgelöst – sie erscheint im Verlauf der Türstation.')}>
                Bewegung
              </Button>
            ))}
          </div>
          {/* Folded away by default: thirteen switches would bury the rest of the page. */}
          <details className="group rounded-tile bg-surface shadow-tile">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 font-medium">
              <span>
                Fenster und Türen öffnen
                {open > 0 && <span className="ml-2 text-sm font-normal text-warn">{open} offen</span>}
              </span>
              <ChevronDown className="size-4.5 text-faint transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="divide-y divide-line border-t border-line">
              {query.data.contacts.map((contact) => (
                <Row
                  key={contact.name}
                  title={contact.name}
                  subtitle={contact.open ? 'Offen' : 'Geschlossen'}
                  trailing={<Toggle checked={contact.open} tone="warn" label={`${contact.name} öffnen`} onChange={(next) => void trigger({ action: 'contact', name: contact.name, open: next })} />}
                />
              ))}
            </div>
          </details>
        </>
      )}
    </Section>
  );
}
