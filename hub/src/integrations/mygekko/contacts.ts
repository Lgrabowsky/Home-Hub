import { slugify, type ContactCandidate, type ContactMapping, type ContactType, type MyGekkoSettings } from '@home-hub/shared';
import { learnedName, type LearnedContact } from './discovery.ts';
import { filled, num, type GekkoTree, type TreeItem } from './protocol.ts';

/**
 * Window/door contacts.
 *
 * The Query API does not expose the detectors of the alarm system (an
 * `alarmsystem` element only has name, page, zone names and a summary state),
 * so single contacts are read from other elements: what can be recognised
 * automatically (by name, and by watching which values follow the contact zone,
 * see `discovery.ts`), plus whatever the administrator mapped explicitly.
 */

export type ContactSettings = Pick<MyGekkoSettings, 'autoContacts' | 'contactKeywords' | 'doorKeywords' | 'contactZone' | 'contacts'>;

export interface ResolvedContact {
  /** Mapping id; the entity id is `gekko:contact/<id>`. */
  id: string;
  /** `<system>/<element>`. */
  source: string;
  field: number;
  openWhen: 'nonzero' | 'zero';
  name: string;
  contactType: ContactType;
  room: string | null;
  zone: string | null;
  auto: boolean;
}

export type ContactSuggestion = NonNullable<ContactCandidate['suggestion']>;

/** Field of a room controller that reports its window contact (`windowOpenStatus`, firmware 879015+). */
export const ROOM_WINDOW_FIELD = 12;
/** `accessState` of an access door: 0 closed, 1 open. */
const ACCESS_STATE_FIELD = 2;

/** Systems whose elements are offered in the admin mapping UI. */
export const CANDIDATE_SYSTEMS = ['alarms_logics', 'roomtemps', 'accessdoors', 'trends'] as const;

/** Lower case with umlauts written out, so that "Tür", "Tuer" and "TÜR" compare equal. */
export function foldText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

export function parseKeywords(list: string): string[] {
  return list
    .split(',')
    .map((keyword) => foldText(keyword.trim()))
    .filter((keyword) => keyword !== '');
}

function matches(text: string | null, keywords: string[]): boolean {
  if (!text) return false;
  const folded = foldText(text);
  return keywords.some((keyword) => folded.includes(keyword));
}

export function autoContactId(item: TreeItem): string {
  return `auto-${slugify(item.system)}-${slugify(item.key)}`;
}

/**
 * What the automatic rules make of an element; null when it does not look like a contact.
 * (Whether a contact entity is really created is decided in `resolveContacts`.)
 */
export function suggestContact(item: TreeItem, fields: string[] | undefined, settings: ContactSettings): ContactSuggestion | null {
  if (item.isGroup) return null;
  const room = item.page ?? '';
  switch (item.system) {
    case 'roomtemps':
      if (!filled(fields?.[ROOM_WINDOW_FIELD])) return null;
      return { field: ROOM_WINDOW_FIELD, openWhen: 'nonzero', contactType: 'window', name: `Fenster ${item.name}`, room };
    case 'accessdoors':
      return { field: ACCESS_STATE_FIELD, openWhen: 'nonzero', contactType: 'door', name: item.name, room };
    case 'alarms_logics': {
      const keywords = parseKeywords(settings.contactKeywords);
      if (!matches(item.name, keywords) && !matches(item.page, keywords)) return null;
      const isDoor = matches(item.name, parseKeywords(settings.doorKeywords));
      return { field: 0, openWhen: 'nonzero', contactType: isDoor ? 'door' : 'window', name: item.name, room };
    }
    default:
      return null;
  }
}

export function splitSource(source: string): { system: string; key: string } | null {
  const [system, key, ...rest] = source.split('/');
  return system && key && rest.length === 0 ? { system, key } : null;
}

function explicitContact(mapping: ContactMapping): ResolvedContact {
  return {
    id: mapping.id,
    source: mapping.source.trim(),
    field: mapping.field,
    openWhen: mapping.openWhen,
    name: mapping.name,
    contactType: mapping.contactType,
    room: mapping.room.trim() || null,
    zone: mapping.zone.trim() || null,
    auto: false,
  };
}

/**
 * The contacts to show: explicit mappings first (they always win), then the
 * automatic ones that do not collide with them.
 *
 * `provenWindows` holds the room controllers whose window contact has been seen
 * open at least once. Firmware 879015 reports `windowOpenStatus = 0` for every
 * room controller, wired contact or not (all 24 controllers of the two real
 * dumps do), so the mere presence of the field proves nothing — and a window
 * that can never read "open" must not be shown as "closed".
 */
export function resolveContacts(
  tree: GekkoTree,
  values: ReadonlyMap<string, string[]>,
  settings: ContactSettings,
  provenWindows: ReadonlySet<string>,
  learned: readonly LearnedContact[] = [],
): ResolvedContact[] {
  const contacts = settings.contacts.map(explicitContact);
  if (!settings.autoContacts) return contacts;

  const taken = new Set(contacts.map((contact) => `${contact.source}#${contact.field}`));
  const ids = new Set(contacts.map((contact) => contact.id));
  const zone = settings.contactZone.trim() || null;
  for (const system of ['roomtemps', 'accessdoors', 'alarms_logics']) {
    for (const item of tree.systems.get(system)?.values() ?? []) {
      const source = `${item.system}/${item.key}`;
      const suggestion = suggestContact(item, values.get(source), settings);
      if (!suggestion) continue;
      if (system === 'roomtemps' && !provenWindows.has(source)) continue;
      const id = autoContactId(item);
      if (taken.has(`${source}#${suggestion.field}`) || ids.has(id)) continue;
      ids.add(id);
      contacts.push({
        id,
        source,
        field: suggestion.field,
        openWhen: suggestion.openWhen,
        name: suggestion.name,
        contactType: suggestion.contactType,
        room: suggestion.room || null,
        zone,
        auto: true,
      });
    }
  }

  // Values that turned out to follow the contact zone (see discovery.ts) — unless the same element or a
  // contact of the same name is shown already (a contact may also be logged by a trend, for example).
  const usedSources = new Set(contacts.map((contact) => contact.source));
  const usedNames = new Set(contacts.map((contact) => foldText(contact.name).replace(/\s+/g, ' ').trim()));
  const perSource = new Map<string, LearnedContact[]>();
  for (const contact of learned) perSource.set(contact.source, [...(perSource.get(contact.source) ?? []), contact]);
  const doorWords = parseKeywords(settings.doorKeywords);
  for (const [source, all] of perSource) {
    const parsed = splitSource(source);
    const item = parsed ? tree.systems.get(parsed.system)?.get(parsed.key) : undefined;
    if (!item) continue;
    // A logic whose inputs follow the zone usually also has an output "any of them open": that one is no contact.
    const isInput = (field: number) => /^inputValue/.test(item.labels[field] ?? '');
    const list = all.some((contact) => isInput(contact.field)) ? all.filter((contact) => !/^outputGate/.test(item.labels[contact.field] ?? '')) : all;
    if (usedSources.has(source)) continue;
    for (const contact of [...list].sort((a, b) => a.field - b.field)) {
      const id = `${autoContactId(item)}-${contact.field}`;
      const name = learnedName(item, contact.field, values.get(source), list.length);
      const folded = foldText(name).replace(/\s+/g, ' ').trim();
      if (ids.has(id) || usedNames.has(folded)) continue;
      ids.add(id);
      usedNames.add(folded);
      contacts.push({
        id,
        source,
        field: contact.field,
        openWhen: contact.openWhen,
        name,
        contactType: matches(name, doorWords) ? 'door' : 'window',
        room: item.page,
        zone,
        auto: true,
      });
    }
  }
  return contacts;
}

/** Room controllers that report their window as open right now. */
export function openRoomWindows(tree: GekkoTree, values: ReadonlyMap<string, string[]>): string[] {
  const open: string[] = [];
  for (const item of tree.systems.get('roomtemps')?.values() ?? []) {
    if (item.isGroup) continue;
    const source = `${item.system}/${item.key}`;
    const state = num(values.get(source)?.[ROOM_WINDOW_FIELD]);
    if (state !== null && state !== 0) open.push(source);
  }
  return open;
}

/** Everything that could be a contact, with its live raw values (admin mapping / learn UI). */
export function listCandidates(
  tree: GekkoTree,
  values: ReadonlyMap<string, string[]>,
  settings: ContactSettings,
  contacts: readonly ResolvedContact[],
): ContactCandidate[] {
  const systems = new Set<string>(CANDIDATE_SYSTEMS);
  for (const mapping of settings.contacts) {
    const source = splitSource(mapping.source);
    if (source) systems.add(source.system);
  }
  const candidates: ContactCandidate[] = [];
  for (const system of systems) {
    for (const item of tree.systems.get(system)?.values() ?? []) {
      const explicitlyMapped = settings.contacts.some((mapping) => mapping.source.trim() === `${item.system}/${item.key}`);
      // Groups only report a summary; they are listed when the administrator mapped one on purpose.
      if (item.isGroup && !explicitlyMapped) continue;
      const source = `${item.system}/${item.key}`;
      const fields = values.get(source) ?? [];
      candidates.push({
        source,
        system: item.system,
        name: item.name,
        page: item.page,
        fields: [...fields],
        fieldLabels: fields.map((_, index) => item.labels[index] ?? ''),
        suggestion: suggestContact(item, fields, settings),
        mappedIds: contacts.filter((contact) => contact.source === source).map((contact) => `gekko:contact/${contact.id}`),
      });
    }
  }
  return candidates;
}
