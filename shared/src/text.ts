/** Lower-case, accent-free, dash-separated form of a name: "Küche EG" → "kuche-eg". */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

const CONTACT_WORDS: Record<string, string> = { window: 'Fenster', door: 'Tür', garage: 'Garagentor', motion: 'Bewegungsmelder', other: 'Kontakt' };

/**
 * Names of KNX contacts as the app shows them: the own name, otherwise kind and
 * room ("Fenster Küche"), or kind and group address without a room. Contacts
 * that would end up with the same name are numbered ("Fenster Küche 2").
 */
export function knxContactNames(contacts: readonly { id: string; name: string; room: string; contactType: string; address: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const contact of contacts) {
    const own = contact.name.trim();
    const base = own || `${CONTACT_WORDS[contact.contactType] ?? 'Kontakt'} ${contact.room.trim() || contact.address.trim()}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    names.set(contact.id, own || count === 1 ? base : `${base} ${count}`);
  }
  return names;
}
