import { foldText, parseKeywords, type ContactSettings } from './contacts.ts';
import { num, type GekkoTree, type TreeItem } from './protocol.ts';

/**
 * Finds single window/door contacts by themselves — no teaching needed.
 *
 * The Query API never names the detectors of the alarm system: an
 * `alarmsystem` element only says, per zone, "all closed", "something is open"
 * (alarmButUnsharp) or "alarm" (checked against the official variable list and
 * three real installations). Many installations nevertheless carry the
 * contacts somewhere else as well — as inputs or outputs of logic elements
 * ("Alarm/Logik") or as logged digital inputs of a trend element — just not
 * under a name the hub could recognise.
 *
 * So the hub watches: a field becomes a contact when
 *  - it only ever reads 0 or 1,
 *  - it reads the same value at every poll while the contact zone reports
 *    "all closed" (at least `MIN_CLOSED_POLLS` of them), and
 *  - it left that value during an "open" period of the zone and was back when
 *    the zone closed again — in `REQUIRED_PERIODS` separate open periods.
 * A learned contact that reads "open" while the zone reports "all closed" is
 * dropped again (`UNLEARN_AFTER` such polls), so a coincidence corrects itself.
 *
 * Room controllers are not handled here: their window field is recognised by
 * name already (see `resolveContacts`).
 */

export interface LearnedContact {
  /** `<system>/<element>`. */
  source: string;
  field: number;
  /** The value the field shows while the contact is closed is the other one. */
  openWhen: 'nonzero' | 'zero';
}

export type ZoneReading = 'closed' | 'open' | 'unknown';

const MIN_CLOSED_POLLS = 3;
const REQUIRED_PERIODS = 2;
const UNLEARN_AFTER = 3;

/** Zone names that stand for something else than window and door contacts. */
const OTHER_DETECTORS = ['bewegung', 'praesenz', 'rauch', 'brand', 'glasbruch', 'wasser', 'sabotage', 'motion', 'smoke'];

interface Zone {
  name: string;
  system: string;
  alarmState: number | null;
  deviceStatus: number | null;
}

function zonesOf(tree: GekkoTree, values: ReadonlyMap<string, string[]>): Zone[] {
  const zones: Zone[] = [];
  for (const item of tree.systems.get('alarmsystem')?.values() ?? []) {
    if (item.isGroup) continue;
    const fields = values.get(`${item.system}/${item.key}`);
    for (const zone of item.hasZone2 ? [1, 2] : [1]) {
      const offset = 1 + (zone - 1) * 3;
      const known = (fields?.length ?? 0) >= offset + 3;
      zones.push({
        name: (zone === 1 ? item.zone1 : item.zone2) ?? '',
        system: item.name,
        deviceStatus: known ? num(fields![offset]) : null,
        alarmState: known ? num(fields![offset + 2]) : null,
      });
    }
  }
  return zones;
}

/**
 * The zone(s) whose detectors are the window and door contacts: those named like
 * the configured contact zone or a contact keyword ("Hülle", "Fenster/Türen");
 * when nothing is named so and there is exactly one zone, that one.
 */
export function contactZones(tree: GekkoTree, values: ReadonlyMap<string, string[]>, settings: Pick<ContactSettings, 'contactZone' | 'contactKeywords'>): Zone[] {
  const zones = zonesOf(tree, values);
  const wanted = [foldText(settings.contactZone.trim()), ...parseKeywords(settings.contactKeywords)].filter((word) => word !== '');
  const other = (zone: Zone) => OTHER_DETECTORS.some((word) => foldText(`${zone.name} ${zone.system}`).includes(word));
  const named = zones.filter((zone) => !other(zone) && wanted.some((word) => foldText(zone.name).includes(word) || foldText(zone.system).includes(word)));
  if (named.length > 0) return named;
  return zones.length === 1 && !other(zones[0]!) ? zones : [];
}

/** "closed" only when every contact zone says so; "open" when one reports an open detector or an alarm. */
export function readContactZones(zones: Zone[]): ZoneReading {
  if (zones.length === 0) return 'unknown';
  let open = false;
  for (const zone of zones) {
    if (zone.deviceStatus === 0 || zone.alarmState === null) return 'unknown';
    if (zone.alarmState === 2 || zone.alarmState === 3) open = true;
    else if (zone.alarmState !== 0) return 'unknown';
  }
  return open ? 'open' : 'closed';
}

/** Fields worth watching: inputs and outputs of logic elements, logged inputs of trend elements. */
export function candidateFields(item: TreeItem, fields: string[]): number[] {
  if (item.isGroup) return [];
  if (item.system === 'alarms_logics') return fields.map((_, index) => index);
  if (item.system === 'trends') {
    const out: number[] = [];
    // Per variable: state; type (0 logic, 1 digital input, …); name; value; unit.
    for (let n = 0; n * 5 + 3 < fields.length; n++) {
      const type = num(fields[n * 5 + 1]);
      if (type === 0 || type === 1) out.push(n * 5 + 3);
    }
    return out;
  }
  return [];
}

/** A readable name for a learned field: the element, and — where it says something — which of its values. */
export function learnedName(item: TreeItem, field: number, fields: string[] | undefined, siblings: number): string {
  if (item.system === 'trends') {
    const variable = fields?.[field - 1]?.trim();
    if (variable) return variable;
    return `${item.name} · Wert ${Math.floor(field / 5) + 1}`;
  }
  const label = item.labels[field] ?? '';
  // An input is named as such right away, so that its name does not change when a second one is found.
  const input = /^inputValue(\d+)_(\d+)$/.exec(label);
  if (input) return `${item.name} · Kontakt ${input[1]}.${input[2]}`;
  if (siblings <= 1) return item.name;
  const output = /^outputGate(\w+)$/.exec(label);
  if (output) return `${item.name} · Ausgang ${output[1]}`;
  return `${item.name} · Wert ${field + 1}`;
}

interface Watch {
  closedValue: number | null;
  closedPolls: number;
  pending: boolean;
  periods: number;
  ruledOut: boolean;
}

export class ContactDiscovery {
  private readonly watches = new Map<string, Watch>();
  private readonly learned = new Map<string, LearnedContact>();
  private readonly misfits = new Map<string, number>();
  private lastZone: ZoneReading = 'unknown';
  private openPeriods = 0;

  constructor(learned: readonly LearnedContact[] = []) {
    for (const contact of learned) this.learned.set(`${contact.source}#${contact.field}`, { ...contact });
  }

  get contacts(): LearnedContact[] {
    return [...this.learned.values()];
  }

  /** What is being watched, for the diagnostics page. */
  summary(): { zone: ZoneReading; openPeriodsSeen: number; watching: number; learned: number } {
    let watching = 0;
    for (const watch of this.watches.values()) if (!watch.ruledOut) watching++;
    return { zone: this.lastZone, openPeriodsSeen: this.openPeriods, watching, learned: this.learned.size };
  }

  /**
   * One poll. Returns the contacts learned and dropped by it (both empty most of the time).
   */
  observe(tree: GekkoTree, values: ReadonlyMap<string, string[]>, zone: ZoneReading): { learned: LearnedContact[]; dropped: LearnedContact[] } {
    const learned: LearnedContact[] = [];
    const dropped: LearnedContact[] = [];
    if (zone === 'unknown') return { learned, dropped };
    if (zone === 'open' && this.lastZone !== 'open') this.openPeriods++;
    this.lastZone = zone;

    for (const system of ['alarms_logics', 'trends']) {
      for (const item of tree.systems.get(system)?.values() ?? []) {
        const source = `${item.system}/${item.key}`;
        const fields = values.get(source);
        if (!fields) continue;
        for (const field of candidateFields(item, fields)) {
          const key = `${source}#${field}`;
          const value = num(fields[field]);
          const known = this.learned.get(key);
          if (known) {
            // A learned contact must read "closed" whenever the zone is closed.
            if (zone !== 'closed' || value === null) continue;
            const open = known.openWhen === 'nonzero' ? value !== 0 : value === 0;
            const misses = open ? (this.misfits.get(key) ?? 0) + 1 : 0;
            this.misfits.set(key, misses);
            if (misses >= UNLEARN_AFTER) {
              this.learned.delete(key);
              this.misfits.delete(key);
              this.watches.set(key, { closedValue: null, closedPolls: 0, pending: false, periods: 0, ruledOut: true });
              dropped.push(known);
            }
            continue;
          }
          if (value === null) continue;
          let watch = this.watches.get(key);
          if (!watch) this.watches.set(key, (watch = { closedValue: null, closedPolls: 0, pending: false, periods: 0, ruledOut: false }));
          if (watch.ruledOut) continue;
          if (value !== 0 && value !== 1) {
            watch.ruledOut = true;
            continue;
          }
          if (zone === 'closed') {
            if (watch.closedValue === null) watch.closedValue = value;
            else if (value !== watch.closedValue) {
              watch.ruledOut = true;
              continue;
            }
            watch.closedPolls++;
            if (watch.pending) {
              watch.pending = false;
              watch.periods++;
              if (watch.periods >= REQUIRED_PERIODS) {
                const contact: LearnedContact = { source, field, openWhen: watch.closedValue === 0 ? 'nonzero' : 'zero' };
                this.learned.set(key, contact);
                this.watches.delete(key);
                learned.push(contact);
              }
            }
          } else if (watch.closedValue !== null && watch.closedPolls >= MIN_CLOSED_POLLS && value !== watch.closedValue) {
            watch.pending = true;
          }
        }
      }
    }
    return { learned, dropped };
  }
}
