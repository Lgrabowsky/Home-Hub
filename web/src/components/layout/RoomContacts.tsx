import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { recognisedRoomOf, roomKey, setDevice, shownRoom, type ContactEntity } from '@home-hub/shared';
import { formatAgo } from '../../lib/format.ts';
import { saveLayout } from '../../lib/layout.ts';
import { useHub } from '../../store/hub.ts';
import { contactIcon } from '../entities/icons.ts';
import { cx, Notice, Sheet, TextInput, Toggle } from '../ui.tsx';

/** Contacts of the whole house: the one that changed last first — that is the window just opened. */
function useAllContacts(): ContactEntity[] {
  const entities = useHub((state) => state.entities);
  const hidden = useHub((state) => state.hidden);
  return useMemo(
    () =>
      [...Object.values(entities), ...Object.values(hidden)]
        .filter((entity): entity is ContactEntity => entity.kind === 'contact')
        .sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0) || a.name.localeCompare(b.name, 'de', { numeric: true })),
    [entities, hidden],
  );
}

function ContactRow({ contact, room, belongs }: { contact: ContactEntity; room: string; belongs: boolean }) {
  const Icon = contactIcon(contact);
  const toggle = (next: boolean) => {
    const layout = useHub.getState().layout;
    const recognised = recognisedRoomOf(contact);
    const automatic = recognised === null ? null : shownRoom(recognised, layout);
    // Taken out of this room: back where it was recognised, or without a room when that was this one.
    const target = next ? room : automatic !== null && roomKey(automatic) !== roomKey(room) ? automatic : null;
    void saveLayout(setDevice(layout, contact, { room: target }), next ? `„${contact.name}“ gehört jetzt zu „${room}“` : `„${contact.name}“ aus „${room}“ genommen`);
  };
  const open = contact.available && contact.open;
  return (
    <li className={cx('flex items-center gap-3 px-4 py-3 transition-colors', open && 'bg-warn/10')}>
      <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-full', open ? 'bg-warn/20 text-warn' : 'bg-ok/15 text-ok')}>
        <Icon className="size-4.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{contact.name}</span>
        <span className="block truncate text-sm text-muted">
          <span className={open ? 'font-medium text-warn' : undefined}>{!contact.available ? 'unbekannt' : open ? 'offen' : 'zu'}</span>
          {contact.changedAt ? ` · ${formatAgo(contact.changedAt)}` : ''}
          {!belongs && ` · ${contact.room ?? 'ohne Raum'}`}
        </span>
      </span>
      <Toggle checked={belongs} label={`${contact.name} gehört zu ${room}`} onChange={toggle} />
    </li>
  );
}

/**
 * Which windows and doors belong to a room. Every contact shows its live state,
 * the one that changed last on top: open a window, and it is the first entry.
 */
export function RoomContacts({ room, open, onClose }: { room: string; open: boolean; onClose(): void }) {
  const contacts = useAllContacts();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (contact: ContactEntity) => q === '' || `${contact.name} ${contact.room ?? ''}`.toLowerCase().includes(q);
  const here = contacts.filter((contact) => contact.room !== null && roomKey(contact.room) === roomKey(room));
  const others = contacts.filter((contact) => !here.includes(contact) && matches(contact));
  return (
    <Sheet open={open} onClose={onClose} title={`Fenster & Türen in ${room}`} subtitle="Zustand live vom Haus">
      <Notice className="mb-4">Tipp: Öffne das Fenster, das du suchst – es springt hier auf „offen“ und steht ganz oben.</Notice>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">In diesem Raum</p>
      {here.length > 0 ? (
        <ul className="mb-5 divide-y divide-line overflow-hidden rounded-tile bg-sunken">
          {here.map((contact) => (
            <ContactRow key={contact.id} contact={contact} room={room} belongs />
          ))}
        </ul>
      ) : (
        <p className="mb-5 px-1 text-sm text-muted">Noch keine. Schalte unten ein, was zu diesem Raum gehört.</p>
      )}
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faint">Alle anderen Fenster & Türen</p>
      {contacts.length > 12 && (
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3.5 top-3.5 size-5 text-faint" aria-hidden />
          <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Fenster oder Raum suchen" aria-label="Fenster oder Raum suchen" className="pl-11" />
        </div>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-tile bg-sunken" aria-live="polite">
        {others.map((contact) => (
          <ContactRow key={contact.id} contact={contact} room={room} belongs={false} />
        ))}
        {others.length === 0 && <li className="px-4 py-3 text-sm text-muted">{q ? 'Nichts gefunden.' : 'Keine weiteren Fenster und Türen.'}</li>}
      </ul>
    </Sheet>
  );
}
