import { describe, expect, it } from 'vitest';
import { resolveContacts } from '../src/integrations/mygekko/contacts.ts';
import { ContactDiscovery, contactZones, learnedName, readContactZones, type ZoneReading } from '../src/integrations/mygekko/discovery.ts';
import type { GekkoTree, TreeItem } from '../src/integrations/mygekko/protocol.ts';

const LOGIC_LABELS = [
  ...['1', '2', '3', '4', '5', '6', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].map((gate) => `outputGate${gate}`),
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`inputValue${n}_1`, `inputValue${n}_2`]),
];

function item(system: string, key: string, name: string, page: string | null, extra: Partial<TreeItem> = {}): TreeItem {
  return { system, key, isGroup: false, name, page, labels: [], writable: false, commandDoc: null, zone1: null, zone2: null, hasZone2: false, ...extra };
}

function tree(...items: TreeItem[]): GekkoTree {
  const systems = new Map<string, Map<string, TreeItem>>();
  for (const entry of items) {
    if (!systems.has(entry.system)) systems.set(entry.system, new Map());
    systems.get(entry.system)!.set(entry.key, entry);
  }
  return { systems, meteoUnits: new Map() };
}

const SETTINGS = {
  autoContacts: true,
  contactKeywords: 'fenster, tür, tuer, kontakt, hülle',
  doorKeywords: 'tür, tuer, tor',
  contactZone: 'Hülle',
  contacts: [],
};

/** A logic whose inputs are the contacts, output 1 = "any open", plus an unrelated logic. */
const HOUSE = tree(
  item('alarmsystem', 'item0', 'Alarmanlage', '...', { zone1: 'Hülle' }),
  item('alarms_logics', 'item7', 'Logik 7', 'Logik', { labels: LOGIC_LABELS }),
  item('alarms_logics', 'item8', 'Lüften', 'Haustechnik', { labels: LOGIC_LABELS }),
);

/** Values of one poll: which inputs of "Logik 7" are 1, and what "Lüften" shows. */
function poll(open: number[], other = 0): Map<string, string[]> {
  const logic = new Array<string>(25).fill('0.00');
  for (const input of open) logic[13 + input] = '1.00';
  logic[0] = open.length > 0 ? '1.00' : '0.00';
  const other7 = new Array<string>(25).fill('0.00');
  other7[0] = other.toFixed(2);
  return new Map([
    ['alarmsystem/item0', ['0', '1', '0', open.length > 0 ? '2' : '0', '1']],
    ['alarms_logics/item7', logic],
    ['alarms_logics/item8', other7],
  ]);
}

function run(discovery: ContactDiscovery, steps: number[][], other: (step: number) => number = () => 0) {
  const learned = [];
  for (const [index, open] of steps.entries()) {
    const values = poll(open, other(index));
    const zone: ZoneReading = readContactZones(contactZones(HOUSE, values, SETTINGS));
    learned.push(...discovery.observe(HOUSE, values, zone).learned);
  }
  return learned;
}

const closed = (n: number) => Array.from({ length: n }, () => [] as number[]);

describe('which alarm zone holds the contacts', () => {
  it('takes zones named like the contact zone, ignores motion and smoke detectors', () => {
    const house = tree(
      item('alarmsystem', 'item0', 'Bewegungsmelder', 'Alarmanlage', { zone1: 'Alarm' }),
      item('alarmsystem', 'item1', 'Rauchmelder', 'Alarmanlage', { zone1: 'Haus' }),
      item('alarmsystem', 'item2', 'Alarmanlage', 'Alarmanlage', { zone1: 'Fenster/Türen' }),
    );
    const values = new Map([
      ['alarmsystem/item0', ['0', '1', '0', '2', '1']],
      ['alarmsystem/item1', ['0', '1', '1', '0', '1']],
      ['alarmsystem/item2', ['0', '1', '0', '0', '1']],
    ]);
    const zones = contactZones(house, values, SETTINGS);
    expect(zones.map((zone) => zone.name)).toEqual(['Fenster/Türen']);
    // The motion detector being "open" says nothing about windows.
    expect(readContactZones(zones)).toBe('closed');
  });

  it('falls back to the only zone there is, and knows nothing when there is none', () => {
    const one = tree(item('alarmsystem', 'item0', 'Alarm', '...', { zone1: 'Haus' }));
    expect(contactZones(one, new Map([['alarmsystem/item0', ['0', '1', '0', '2', '1']]]), SETTINGS)).toHaveLength(1);
    expect(readContactZones(contactZones(tree(), new Map(), SETTINGS))).toBe('unknown');
  });

  it('reads a switched-off zone or missing values as unknown', () => {
    const house = tree(item('alarmsystem', 'item0', 'Alarmanlage', '...', { zone1: 'Hülle' }));
    expect(readContactZones(contactZones(house, new Map([['alarmsystem/item0', ['0', '0', '0', '0', '1']]]), SETTINGS))).toBe('unknown');
    expect(readContactZones(contactZones(house, new Map(), SETTINGS))).toBe('unknown');
    expect(readContactZones(contactZones(house, new Map([['alarmsystem/item0', ['1', '1', '1', '3', '1']]]), SETTINGS))).toBe('open');
  });
});

describe('learning contacts by watching the zone', () => {
  it('learns an input after it followed the zone in two separate open periods', () => {
    const discovery = new ContactDiscovery();
    expect(run(discovery, [...closed(3), [0], [0], [], [], [0], []])).toEqual(
      // Input 1.1 (field 13) and the "any open" output 1 (field 0) both followed the zone.
      expect.arrayContaining([
        { source: 'alarms_logics/item7', field: 13, openWhen: 'nonzero' },
        { source: 'alarms_logics/item7', field: 0, openWhen: 'nonzero' },
      ]),
    );
    expect(discovery.contacts).toHaveLength(2);
  });

  it('needs a second period, enough closed polls first, and never learns what changes while all is closed', () => {
    expect(run(new ContactDiscovery(), [...closed(3), [0], []])).toEqual([]);
    // Opened before the closed state was known.
    expect(run(new ContactDiscovery(), [[0], [], [0], [], [0], []])).toEqual([]);
    // "Lüften" flips with the windows, but also while everything is closed: not a contact.
    const discovery = new ContactDiscovery();
    run(discovery, [...closed(3), [0], [], [], [0], []], (step) => (step === 3 || step === 4 || step === 6 ? 1 : 0));
    expect(discovery.contacts.some((contact) => contact.source === 'alarms_logics/item8')).toBe(false);
  });

  it('drops a learned contact that reads open while the zone is closed', () => {
    const discovery = new ContactDiscovery([{ source: 'alarms_logics/item8', field: 0, openWhen: 'nonzero' }]);
    const dropped = [];
    for (let i = 0; i < 3; i++) {
      const values = poll([], 1);
      dropped.push(...discovery.observe(HOUSE, values, readContactZones(contactZones(HOUSE, values, SETTINGS))).dropped);
    }
    expect(dropped).toEqual([{ source: 'alarms_logics/item8', field: 0, openWhen: 'nonzero' }]);
    expect(discovery.contacts).toEqual([]);
  });

  it('learns inverted contacts (1 = closed) too', () => {
    const house = tree(item('alarmsystem', 'item0', 'Alarmanlage', '...', { zone1: 'Hülle' }), item('trends', 'item0', 'Eingänge', '...'));
    const discovery = new ContactDiscovery();
    const step = (open: boolean) => {
      const values = new Map([
        ['alarmsystem/item0', ['0', '1', '0', open ? '2' : '0', '1']],
        ['trends/item0', ['1', '1', 'Kellerfenster', open ? '0.00' : '1.00', '', '0', '0', '', '0.00', '', '0']],
      ]);
      return discovery.observe(house, values, readContactZones(contactZones(house, values, SETTINGS))).learned;
    };
    for (const open of [false, false, false, true, false, true, false]) step(open);
    expect(discovery.contacts).toEqual([{ source: 'trends/item0', field: 3, openWhen: 'zero' }]);
  });
});

describe('learned contacts as entities', () => {
  it('names inputs, hides the "any open" output and keeps contacts that are known by name', () => {
    const logic = HOUSE.systems.get('alarms_logics')!.get('item7')!;
    expect(learnedName(logic, 13, undefined, 1)).toBe('Logik 7 · Kontakt 1.1');
    expect(learnedName(logic, 0, undefined, 1)).toBe('Logik 7');
    expect(learnedName(item('trends', 'item0', 'Eingänge', null), 8, ['1', '1', 'Fenster Bad', '0', '', '1', '1', 'Kellertür', '0', ''], 1)).toBe('Kellertür');

    const values = poll([]);
    const contacts = resolveContacts(HOUSE, values, SETTINGS, new Set(), [
      { source: 'alarms_logics/item7', field: 0, openWhen: 'nonzero' },
      { source: 'alarms_logics/item7', field: 13, openWhen: 'nonzero' },
      { source: 'alarms_logics/item7', field: 14, openWhen: 'nonzero' },
    ]);
    expect(contacts.map((contact) => [contact.id, contact.name, contact.room, contact.zone])).toEqual([
      ['auto-alarms-logics-item7-13', 'Logik 7 · Kontakt 1.1', 'Logik', 'Hülle'],
      ['auto-alarms-logics-item7-14', 'Logik 7 · Kontakt 1.2', 'Logik', 'Hülle'],
    ]);
    // Switched off: nothing automatic, learned or not.
    expect(resolveContacts(HOUSE, values, { ...SETTINGS, autoContacts: false }, new Set(), [{ source: 'alarms_logics/item7', field: 13, openWhen: 'nonzero' }])).toEqual([]);
  });
});
