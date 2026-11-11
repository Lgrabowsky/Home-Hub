import {
  clamp,
  type ActionEntity,
  type AlarmEntity,
  type BlindEntity,
  type ClimateEntity,
  type ClockEntity,
  type ContactEntity,
  type Entity,
  type EntityKind,
  type LightEntity,
  type SensorEntity,
  type SwitchEntity,
} from '@home-hub/shared';
import { foldText, type ResolvedContact } from './contacts.ts';
import { documentsCommand, filled, num, type GekkoTree, type TreeItem } from './protocol.ts';

/**
 * Turns the controller's elements into the hub's entities.
 *
 * Values are read strictly by position. The field layouts are those of the
 * format strings every firmware since 596610 documents (see the dumps shipped
 * with PyMyGekko); the documentation text itself is never used to interpret a
 * value, because it moved and changed between firmware versions.
 */

export const SERVICE = 'mygekko';

/** Systems that become entities of their own. */
export const MAPPED_SYSTEMS = ['lights', 'blinds', 'loads', 'roomtemps', 'actions', 'clocks', 'alarmsystem', 'energycosts'] as const;

export const TARGET_RANGE = { min: 5, max: 30, step: 0.5 } as const;

const METEO: Record<string, { name: string; sensorType: SensorEntity['sensorType'] }> = {
  temperature: { name: 'Außentemperatur', sensorType: 'temperature' },
  humidity: { name: 'Luftfeuchte außen', sensorType: 'humidity' },
  wind: { name: 'Wind', sensorType: 'wind' },
  brightness: { name: 'Helligkeit', sensorType: 'brightness' },
  brightnessw: { name: 'Helligkeit West', sensorType: 'brightness' },
  brightnesso: { name: 'Helligkeit Ost', sensorType: 'brightness' },
  twilight: { name: 'Dämmerung', sensorType: 'brightness' },
  rain: { name: 'Regen', sensorType: 'rain' },
};

export function elementEntityId(item: Pick<TreeItem, 'system' | 'key'>): string {
  return `gekko:${item.system}/${item.key}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  // Adding 0 turns -0 into 0 ("-0.00" is a value the controller really sends).
  return Math.round(value * factor) / factor + 0;
}

/** The controller reports levels slightly outside 0–100 at times (pinpong: "dim levels outside of 0-100"). */
function percent(value: number | null): number | null {
  return value === null ? null : round(clamp(value, 0, 100), 0);
}

function switchVariant(name: string): string {
  const folded = foldText(name);
  if (folded.includes('steckdose')) return 'socket';
  if (folded.includes('pumpe')) return 'pump';
  if (folded.includes('lueft') || folded.includes('vent')) return 'fan';
  return 'generic';
}

function climateMode(mode: number | null, deviceModel: number | null): ClimateEntity['mode'] {
  if (mode === null) return 'unknown';
  // deviceModel 3 = KNX room controller, whose workingMode uses the KNX numbering
  // (0 auto, 1 comfort, 2 standby, 3 economy, 4 building protection).
  if (deviceModel === 3) {
    switch (mode) {
      case 0:
      case 1:
        return 'comfort';
      case 2:
        return 'standby';
      case 3:
        return 'reduced';
      case 4:
        return 'off';
      default:
        return 'unknown';
    }
  }
  switch (mode) {
    case 1:
      return 'off';
    case 8:
      return 'comfort';
    case 16:
      return 'reduced';
    case 64:
      return 'manual';
    case 256:
      return 'standby';
    default:
      return 'unknown';
  }
}

/** Whether the element takes `value`: it must be writable and, where it documents its commands, list the value. */
export function accepts(item: TreeItem, value: string): boolean {
  if (!item.writable) return false;
  return item.commandDoc === null || documentsCommand(item.commandDoc, value);
}

export interface BuildInput {
  tree: GekkoTree;
  /** Latest fields per `system/element`; an element is missing until the controller reported it once. */
  values: ReadonlyMap<string, string[]>;
  /** Latest weather values. */
  meteo: ReadonlyMap<string, string>;
  contacts: readonly ResolvedContact[];
  now: number;
}

export interface BuildResult {
  entities: Entity[];
  /** Entity id → element, for everything that takes commands. */
  elements: Map<string, TreeItem>;
  /** German remarks for the diagnostics page (contacts that cannot be read). */
  notes: string[];
}

interface ContactMemory {
  open: boolean;
  /** When `open` last flipped; null until it did. */
  changedAt: number | null;
  /** A value was read at least once. */
  observed: boolean;
}

export class EntityFactory {
  /** A feature stays once its field was seen filled: dimmers report an empty level at times. */
  private readonly lightFeatures = new Map<string, LightEntity['features']>();
  private readonly blindFeatures = new Map<string, BlindEntity['features']>();
  private readonly contactMemory = new Map<string, ContactMemory>();

  build(input: BuildInput): BuildResult {
    const { tree, values } = input;
    const entities: Entity[] = [];
    const elements = new Map<string, TreeItem>();
    const notes: string[] = [];
    const add = (entity: Entity, item?: TreeItem) => {
      entities.push(entity);
      if (item) elements.set(entity.id, item);
    };
    const fieldsOf = (item: TreeItem) => values.get(`${item.system}/${item.key}`);
    const each = (system: string) => [...(tree.systems.get(system)?.values() ?? [])];

    for (const item of each('lights')) add(this.light(item, fieldsOf(item)), item);
    for (const item of each('blinds')) add(this.blind(item, fieldsOf(item)), item);
    for (const item of each('loads')) add(this.load(item, fieldsOf(item)), item);
    // Groups of the remaining systems only carry a summary flag (and partly other commands): skipped.
    for (const item of each('roomtemps')) if (!item.isGroup) add(this.climate(item, fieldsOf(item)), item);
    for (const item of each('actions')) if (!item.isGroup) add(this.action(item, fieldsOf(item)), item);
    for (const item of each('clocks')) if (!item.isGroup) add(this.clock(item, fieldsOf(item)), item);
    for (const item of each('alarmsystem')) if (!item.isGroup) for (const zone of this.alarmZones(item, fieldsOf(item))) add(zone);
    for (const item of each('energycosts')) if (!item.isGroup) add(this.energyMeter(item, fieldsOf(item)));
    for (const sensor of this.weather(input)) add(sensor);
    for (const contact of input.contacts) add(this.contact(contact, input, notes));

    this.forget(new Set(entities.map((entity) => entity.id)));
    return { entities, elements, notes };
  }

  /** Drops what was remembered about elements that no longer exist. */
  private forget(alive: Set<string>): void {
    for (const memory of [this.lightFeatures, this.blindFeatures, this.contactMemory]) {
      for (const id of memory.keys()) if (!alive.has(id)) memory.delete(id);
    }
  }

  private base<K extends EntityKind>(id: string, kind: K, name: string, room: string | null, available: boolean) {
    return { id, kind, name, room, available, service: SERVICE } as const;
  }

  private light(item: TreeItem, fields: string[] | undefined): LightEntity {
    const id = elementEntityId(item);
    const base = this.base(id, 'light', item.name, item.page, fields !== undefined);
    const f = fields ?? [];
    if (item.isGroup) {
      // A group reports a single `0`/`1` and takes only `0|1`.
      return { ...base, on: num(f[0]) === 1, brightness: null, color: null, colorTemp: null, features: { dim: false, color: false, colorTemp: false }, isGroup: true };
    }
    // Legacy firmware sends four fields, `state;dim;rgb;locked` ("0;;;0;"): its field 3 is the
    // lock flag. Tunable white sits there only in the layouts that continue with elementInfo.
    const tunableWhite = f.length >= 5 ? f[3] : undefined;
    const features = this.lightFeatures.get(id) ?? { dim: false, color: false, colorTemp: false };
    if (filled(f[1])) features.dim = true;
    if (filled(f[2])) features.color = true;
    if (filled(tunableWhite)) features.colorTemp = true;
    this.lightFeatures.set(id, features);

    const level = num(f[1]);
    let brightness = percent(level);
    // 0.4 % is still "on": never round a burning light down to zero.
    if (brightness === 0 && level !== null && level > 0) brightness = 1;
    const rgb = num(f[2]);
    return {
      ...base,
      on: num(f[0]) === 1,
      brightness,
      color: rgb === null || rgb < 0 ? null : `#${(Math.round(rgb) & 0xffffff).toString(16).padStart(6, '0')}`,
      colorTemp: percent(num(tunableWhite)),
      features: { ...features },
      isGroup: false,
    };
  }

  private blind(item: TreeItem, fields: string[] | undefined): BlindEntity {
    const id = elementEntityId(item);
    const base = this.base(id, 'blind', item.name, item.page, fields !== undefined);
    const f = fields ?? [];
    if (item.isGroup) {
      // The group value is documented as `State[1=Up|-1=Down]` — where the group was sent last,
      // not a movement — so a group never shows as moving.
      return { ...base, position: null, tilt: null, motion: 'stopped', features: { position: false, tilt: false }, isGroup: true, locked: false };
    }
    const features = this.blindFeatures.get(id) ?? { position: false, tilt: false };
    if (filled(f[1])) features.position = true;
    if (filled(f[2])) features.tilt = true;
    this.blindFeatures.set(id, features);

    const state = num(f[0]) ?? 0;
    const position = percent(num(f[1]));
    let motion: BlindEntity['motion'] = state < 0 ? 'down' : state > 0 ? 'up' : 'stopped';
    // -2/2 ("hold down/up") stay set after the blind has arrived (real dump: "2;0.00;0.00;0;180;"),
    // so at the end stop of the travel direction there is no movement any more.
    if (position !== null && ((motion === 'up' && position <= 0) || (motion === 'down' && position >= 100))) motion = 'stopped';
    const info = num(f[3]);
    return {
      ...base,
      position,
      tilt: percent(num(f[2])),
      motion,
      features: { ...features },
      isGroup: false,
      // elementInfo: 3 = locked, 4 = alarm (e.g. wind) — in both the controller refuses to move the blind.
      locked: info === 3 || info === 4,
    };
  }

  private load(item: TreeItem, fields: string[] | undefined): SwitchEntity {
    const state = num(fields?.[0]);
    return {
      ...this.base(elementEntityId(item), 'switch', item.name, item.page, fields !== undefined),
      // 1 = on by impulse, 2 = on permanently.
      on: state !== null && state !== 0,
      variant: switchVariant(item.name),
      momentary: false,
    };
  }

  private climate(item: TreeItem, fields: string[] | undefined): ClimateEntity {
    const f = fields ?? [];
    const temperature = num(f[0]);
    const target = num(f[1]);
    const output = num(f[2]);
    const humidity = num(f[8]);
    const cooling = num(f[6]) === 1;
    const window = num(f[12]);
    return {
      ...this.base(elementEntityId(item), 'climate', item.name, item.page, fields !== undefined),
      temperature: temperature === null ? null : round(temperature, 1),
      target: target === null ? null : round(target, 1),
      humidity: humidity === null ? null : round(humidity, 0),
      output: percent(output),
      mode: climateMode(num(f[3]), num(f[11])),
      heating: output !== null && output > 0 && !cooling,
      cooling,
      windowOpen: window === null ? null : window !== 0,
      targetRange: { ...TARGET_RANGE },
      // Legacy firmware documents no setpoint command (only `K`, the adjustment): do not offer one.
      features: { target: accepts(item, 'S21.5'), mode: accepts(item, 'M8') },
    };
  }

  private action(item: TreeItem, fields: string[] | undefined): ActionEntity {
    return {
      ...this.base(elementEntityId(item), 'action', item.name, item.page, fields !== undefined),
      active: num(fields?.[0]) === 1,
      features: { start: accepts(item, '1'), stop: accepts(item, '-1') },
    };
  }

  private clock(item: TreeItem, fields: string[] | undefined): ClockEntity {
    const state = num(fields?.[0]);
    return {
      ...this.base(elementEntityId(item), 'clock', item.name, item.page, fields !== undefined),
      // 0 off, 1 on, 2 on at coincidence.
      enabled: state === null ? null : state !== 0,
      active: null,
      features: { toggle: accepts(item, '0') && accepts(item, '1') },
    };
  }

  /**
   * One entity per zone. Layout: alarmState, then (deviceStatus, sharpState,
   * alarmState) per zone, deviceModel last. The second triple only exists when
   * the tree names a second zone — a one-zone system sends "0;1;0;2;1;", where
   * the trailing 1 is the deviceModel and not a zone value.
   */
  private alarmZones(item: TreeItem, fields: string[] | undefined): AlarmEntity[] {
    const f = fields ?? [];
    const zones = item.hasZone2 ? [1, 2] : [1];
    return zones.map((zone) => {
      const offset = 1 + (zone - 1) * 3;
      const known = f.length >= offset + 3;
      const deviceStatus = known ? num(f[offset]) : null;
      const sharp = known ? num(f[offset + 1]) : null;
      const alarm = known ? num(f[offset + 2]) : null;
      const mode: AlarmEntity['mode'] = sharp === 1 ? 'armed' : sharp === 0 ? 'disarmed' : 'unknown';
      const triggered = alarm === 3;
      // 2 = "alarmButUnsharp": a detector of the zone is tripped while the zone is disarmed.
      const breached = alarm === 2;
      let stateText: string;
      if (triggered) stateText = 'ALARM';
      else if (mode === 'unknown') stateText = 'Status unbekannt';
      else if (deviceStatus === 0) stateText = 'Ausgeschaltet';
      else if (mode === 'armed') stateText = 'Scharf';
      else stateText = breached ? 'Unscharf · mindestens ein Kontakt offen' : 'Unscharf · alles geschlossen';
      const zoneName = (zone === 1 ? item.zone1 : item.zone2) ?? (zones.length > 1 ? `${item.name} · Zone ${zone}` : item.name);
      return {
        ...this.base(`${elementEntityId(item)}#${zone}`, 'alarm', zoneName, item.page, fields !== undefined),
        system: item.name,
        mode,
        triggered,
        breached,
        stateText,
      };
    });
  }

  private energyMeter(item: TreeItem, fields: string[] | undefined): SensorEntity {
    const power = num(fields?.[0]);
    const unit = fields?.[6]?.trim();
    return {
      ...this.base(elementEntityId(item), 'sensor', item.name, item.page, fields !== undefined),
      sensorType: 'power',
      value: power === null ? null : round(power, 2),
      unit: unit ? unit : null,
    };
  }

  private weather(input: BuildInput): SensorEntity[] {
    const keys = new Set([...input.tree.meteoUnits.keys(), ...input.meteo.keys()]);
    const sensors: SensorEntity[] = [];
    for (const [key, spec] of Object.entries(METEO)) {
      if (!keys.has(key)) continue;
      const raw = input.meteo.get(key);
      const value = num(raw);
      sensors.push({
        ...this.base(`gekko:meteo/${key}`, 'sensor', spec.name, null, raw !== undefined),
        sensorType: spec.sensorType,
        value: value === null ? null : round(value, 1),
        unit: input.tree.meteoUnits.get(key) ?? null,
      });
    }
    return sensors;
  }

  private contact(contact: ResolvedContact, input: BuildInput, notes: string[]): ContactEntity {
    const id = `gekko:contact/${contact.id}`;
    const [system = '', key = ''] = contact.source.split('/');
    const item = input.tree.systems.get(system)?.get(key);
    const fields = input.values.get(contact.source);
    const raw = num(fields?.[contact.field]);
    let open = false;
    if (!item) {
      notes.push(`Kontakt „${contact.name}“: Das Element ${contact.source} gibt es auf dem myGEKKO nicht.`);
    } else if (fields !== undefined && raw === null) {
      // Per contract an unreadable value counts as closed — but the administrator must learn about it.
      notes.push(`Kontakt „${contact.name}“: Feld ${contact.field} von ${contact.source} fehlt oder ist keine Zahl – wird als geschlossen angezeigt.`);
    } else if (raw !== null) {
      open = contact.openWhen === 'zero' ? raw === 0 : raw !== 0;
    }

    const available = item !== undefined && fields !== undefined;
    let memory = this.contactMemory.get(id);
    if (!memory) {
      memory = { open: false, changedAt: null, observed: false };
      this.contactMemory.set(id, memory);
    }
    if (available) {
      // The first reading is the baseline, not a change.
      if (memory.observed && memory.open !== open) memory.changedAt = input.now;
      memory.open = open;
      memory.observed = true;
    }
    return {
      ...this.base(id, 'contact', contact.name, contact.room, available),
      open: memory.open,
      contactType: contact.contactType,
      zone: contact.zone,
      fault: false,
      changedAt: memory.changedAt,
    };
  }
}
