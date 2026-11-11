/**
 * The two documents of the myGEKKO Query API, parsed defensively.
 *
 * `GET /api/v1/var` (the "tree") names every element and documents its values
 * and commands; `GET /api/v1/var/status` carries the values. The shapes below
 * were checked against real controller dumps (firmware 879015, 713511, 680016,
 * 596610 and the legacy "Slide" generation shipped with PyMyGekko).
 */

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// sumstate values
// ---------------------------------------------------------------------------

/**
 * Splits a `sumstate` value into its positional fields.
 *
 * Firmware 879015 terminates the value with a `;` ("0;1;0;2;1;"), older ones
 * do not ("1;100.00;;;0"). Exactly one trailing separator is dropped so that
 * "the last field" means the same on both — the alarm system puts its
 * deviceModel there.
 */
export function splitSumstate(value: unknown): string[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (text === '') return [];
  const body = text.endsWith(';') ? text.slice(0, -1) : text;
  return body.split(';').map((field) => field.trim());
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/** Numeric value of a field; null when it is missing, empty or not a plain number. */
export function num(field: string | undefined): number | null {
  if (field === undefined) return null;
  let text = field.trim();
  if (text === '') return null;
  if (/^[-+]?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** True when the controller reported something for this field. */
export function filled(field: string | undefined): boolean {
  return field !== undefined && field.trim() !== '';
}

// ---------------------------------------------------------------------------
// Documentation strings
// ---------------------------------------------------------------------------

/**
 * The text documenting a value or command moved between `format` (firmware
 * 680016 and later), `value` (596610 and legacy) and reportedly `description`.
 * On new firmware `description` only holds a generic sentence, hence the check.
 */
function documentation(node: unknown, looksLikeFormat: RegExp): string | null {
  if (!isRecord(node)) return null;
  for (const key of ['format', 'value', 'description']) {
    const text = node[key];
    if (typeof text === 'string' && looksLikeFormat.test(text)) return text;
  }
  return null;
}

/** Splits at `;` outside of brackets ("a enum[0=x;1=y](); b float(…)" style safe). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '[' || char === '(') depth++;
    else if ((char === ']' || char === ')') && depth > 0) depth--;
    if (char === ';' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Field names from a sumstate documentation string, by position ('' when a
 * position has no usable name). For display only — real values often carry
 * more fields than documented (a light of firmware 879015 documents 9 and
 * sends 24), so nothing may ever be decided from these labels.
 *
 * Known styles:
 * - 680016+: `currentState enum[0=off,1=on](); dimLevel float[0.00,100.0](%); `
 * - 596610:  `state[0=Off|1=On]; dimValue[%]; RGBcolor[24Bit]`
 * - legacy:  `0;77;45476;0 (On|Off;DimmValue;RGBColor;Locked)` (documented by example)
 */
export function formatLabels(doc: string | null): string[] {
  if (!doc) return [];
  const text = doc.trim();
  const legacy = /^[^[\]()]*\(([^]*)\)$/.exec(text);
  if (legacy) {
    const inner = legacy[1] ?? '';
    return inner.includes(';') ? inner.split(';').map((label) => label.trim()) : [];
  }
  return splitTopLevel(text).map((segment) => /^([A-Za-z_]\w*)(?=\s*\[|\s+\S|\s*$)/.exec(segment)?.[1] ?? '');
}

/** `float[0.00,100000.00](kLx)` → `kLx`; null when the format names no unit. */
export function unitFromFormat(format: unknown): string | null {
  if (typeof format !== 'string') return null;
  const unit = /\(([^()]*)\)\s*;?\s*$/.exec(format)?.[1]?.trim();
  return unit ? unit : null;
}

/**
 * Checks a command value against the element's own command documentation,
 * e.g. `-2|-1|0|1|2|T|P55.4|S32.4 (Hold_down|Down|…)`.
 *
 * A token with a letter prefix and a number stands for "prefix + any number"
 * (`P55.4`, `D100`, `C44782`) — unless the prefix is listed several times, then
 * it enumerates the allowed values (`M1|M2|M8|M16|M64|M256`). Everything else
 * must match literally. Returns true when the text cannot be interpreted, so a
 * firmware with an unknown documentation style is not locked out.
 */
export function documentsCommand(doc: string, value: string): boolean {
  const head = doc.split('(', 1)[0] ?? '';
  const tokens = head
    .split('|')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) return true;
  const prefixes = tokens.map((token) => /^([A-Za-z]+?)(?:[-+]?\d|x$)/.exec(token)?.[1] ?? null);
  return tokens.some((token, index) => {
    if (token === value) return true;
    const prefix = prefixes[index];
    if (!prefix) return false;
    const enumerated = prefixes.filter((other) => other === prefix).length > 1;
    return !enumerated && new RegExp(`^${prefix}[-+]?\\d+(?:\\.\\d+)?$`).test(value);
  });
}

// ---------------------------------------------------------------------------
// Resource tree (/api/v1/var)
// ---------------------------------------------------------------------------

export interface TreeItem {
  system: string;
  /** `item3` or `group0`. */
  key: string;
  isGroup: boolean;
  name: string;
  /** Page of the controller's UI the element sits on — usually the room or floor. */
  page: string | null;
  /** Documented field names of the sumstate, by position. */
  labels: string[];
  /** The element has a `scmd` node, i.e. it accepts commands at all. */
  writable: boolean;
  /** The element's own command documentation, when the tree carries one. */
  commandDoc: string | null;
  /** Alarm systems only: names of the zones. */
  zone1: string | null;
  zone2: string | null;
  /** Alarm systems only: the tree lists a second zone (its name may be empty). */
  hasZone2: boolean;
}

export interface GekkoTree {
  /** system → element key → element, in the controller's order. */
  systems: Map<string, Map<string, TreeItem>>;
  /** Weather values the controller offers, with their unit. */
  meteoUnits: Map<string, string | null>;
}

const SYSTEM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const ELEMENT_KEY = /^(item|group)\d+$/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `page` is missing on legacy firmware and for groups; elements that were never
 * assigned to a page carry the placeholder "..." (seen in real dumps of 879015
 * and 596610), which must not turn into a room called "...".
 */
function pageOf(value: unknown): string | null {
  const page = text(value);
  return page === null || /^\.+$/.test(page) ? null : page;
}

function parseItem(system: string, key: string, node: Json): TreeItem {
  const isGroup = key.startsWith('group');
  const writable = isRecord(node.scmd);
  return {
    system,
    key,
    isGroup,
    name: text(node.name) ?? key,
    page: isGroup ? null : pageOf(node.page),
    labels: formatLabels(documentation(node.sumstate, /[;[|(]/)),
    writable,
    commandDoc: writable ? documentation(node.scmd, /[|(]|^\s*[-+\w.]+\s*$/) : null,
    zone1: text(node.zone1),
    zone2: text(node.zone2),
    hasZone2: 'zone2' in node,
  };
}

/** Returns null when the document is not a myGEKKO resource tree. */
export function parseTree(raw: unknown): GekkoTree | null {
  if (!isRecord(raw)) return null;
  const systems = new Map<string, Map<string, TreeItem>>();
  for (const [system, node] of Object.entries(raw)) {
    if (system === 'globals' || !SYSTEM_NAME.test(system) || !isRecord(node)) continue;
    const items = new Map<string, TreeItem>();
    for (const [key, item] of Object.entries(node)) {
      if (ELEMENT_KEY.test(key) && isRecord(item)) items.set(key, parseItem(system, key, item));
    }
    if (items.size > 0) systems.set(system, items);
  }
  const globals = isRecord(raw.globals) ? raw.globals : null;
  if (!globals && systems.size === 0) return null;

  const meteoUnits = new Map<string, string | null>();
  const meteo = globals && isRecord(globals.meteo) ? globals.meteo : {};
  for (const [key, node] of Object.entries(meteo)) {
    if (!isRecord(node)) continue;
    // Legacy firmware has a separate `unit`; newer ones put it at the end of `format`.
    meteoUnits.set(key, text(node.unit) ?? unitFromFormat(node.format));
  }
  return { systems, meteoUnits };
}

// ---------------------------------------------------------------------------
// Status (/api/v1/var/status)
// ---------------------------------------------------------------------------

export interface GekkoStatus {
  /** `lights/item0` → raw sumstate text. Elements without a usable value are left out. */
  values: Map<string, string>;
  /** Weather key → raw value. */
  meteo: Map<string, string>;
  network: { gekkoName: string | null; version: string | null; hardware: string | null };
  /** Global alarm state of the controller (0 ok, 1 unacknowledged, 2 acknowledged, 3 alarm). */
  globalAlarm: string | null;
  /** False when the answer lacks the `globals` section every controller sends. */
  hasGlobals: boolean;
}

function valueOf(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const value = node.value;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Returns null when the document is not a JSON object at all. */
export function parseStatus(raw: unknown): GekkoStatus | null {
  if (!isRecord(raw)) return null;
  const values = new Map<string, string>();
  for (const [system, node] of Object.entries(raw)) {
    if (system === 'globals' || !SYSTEM_NAME.test(system) || !isRecord(node)) continue;
    for (const [key, item] of Object.entries(node)) {
      if (!ELEMENT_KEY.test(key) || !isRecord(item)) continue;
      const value = valueOf(item.sumstate);
      // The cloud may answer before it has values (it subscribes on the first query):
      // an empty value is "not known yet", never a state.
      if (value !== null && value !== '') values.set(`${system}/${key}`, value);
    }
  }

  const globals = isRecord(raw.globals) ? raw.globals : null;
  const network = globals && isRecord(globals.network) ? globals.network : {};
  const meteo = new Map<string, string>();
  if (globals && isRecord(globals.meteo)) {
    for (const [key, node] of Object.entries(globals.meteo)) {
      const value = valueOf(node);
      if (value !== null && value !== '') meteo.set(key, value);
    }
  }
  const alarm = globals && isRecord(globals.alarm) ? valueOf(globals.alarm.sumstate) : null;
  return {
    values,
    meteo,
    network: {
      gekkoName: valueOf(network.gekkoname) || null,
      version: valueOf(network.version) || null,
      hardware: valueOf(network.hardware) || null,
    },
    globalAlarm: alarm || null,
    hasGlobals: globals !== null,
  };
}
