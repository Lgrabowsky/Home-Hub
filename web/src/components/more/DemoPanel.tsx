import { BellRing, FlaskConical, Footprints } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DemoState, DemoTrigger } from '@home-hub/shared';
import { get, post } from '../../lib/api.ts';
import { useSession } from '../../store/session.ts';
import { toast } from '../toast.tsx';
import { Button, Notice, Row, RowGroup, Section, Toggle } from '../ui.tsx';

/**
 * Demo mode only: lets you make the simulated house do something, so the parts
 * of the app that react to the real world (doorbell, open windows) can be tried.
 */
export function DemoPanel() {
  const demo = useSession((state) => state.bootstrap?.demo ?? false);
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['demo-state'], queryFn: () => get<DemoState>('/api/demo/state'), enabled: demo, refetchInterval: 5000 });
  if (!demo) return null;

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
          <RowGroup>
            {query.data.contacts.map((contact) => (
              <Row
                key={contact.name}
                title={contact.name}
                subtitle={contact.open ? 'Offen' : 'Geschlossen'}
                trailing={<Toggle checked={contact.open} tone="warn" label={`${contact.name} öffnen`} onChange={(open) => void trigger({ action: 'contact', name: contact.name, open })} />}
              />
            ))}
          </RowGroup>
        </>
      )}
    </Section>
  );
}
