import { slugify, type House3DGroup, type House3DLevel, type House3DMaterial, type House3DModelInfo } from '@home-hub/shared';
import type { IfcElement, IfcReadResult } from './ifc.ts';

/**
 * Turns the elements of an IFC model into what the app draws: storeys (with
 * floor and section heights), merged meshes per storey and material, and
 * believable material colours (CAD programs colour by part type, not by look).
 *
 * The result is one binary file:
 *   "HH3D" · u32 format · u32 header length · JSON header (padded to 4 bytes) ·
 *   per group: Float32 positions (x,y,z), then Uint32 indices.
 * Coordinates are metres, Z up, shifted so that the model's centre lies at
 * x = y = 0 and the ground at z = 0 (`origin` says by how much).
 */

export const MODEL_FORMAT = 1;
const MAGIC = 'HH3D';

// --- what things look like ----------------------------------------------------------------

interface Look {
  key: string;
  label: string;
  color: string;
  opacity: number;
}

const LOOKS: { test: RegExp; look: Look }[] = [
  { test: /glas|glass|verglasung|\btvg\b|\besg\b|\bvsg\b/i, look: { key: 'glas', label: 'Glas', color: '#a9c7d8', opacity: 0.35 } },
  { test: /stahl|steel|\b(ipe|ipn|hea|heb|hem|unp|upe|rhs|shs|chs)\b|metall|alu/i, look: { key: 'stahl', label: 'Stahl & Metall', color: '#5d636b', opacity: 1 } },
  { test: /beton|concrete|estrich|zement|fundament/i, look: { key: 'beton', label: 'Beton', color: '#b7b4ad', opacity: 1 } },
  { test: /ziegel|mauerwerk|kalksand|porenbeton|brick|masonry/i, look: { key: 'mauerwerk', label: 'Mauerwerk', color: '#d9d2c5', opacity: 1 } },
  { test: /gipskarton|\bgk\b|\bgkb\b|\bgkf\b|fermacell|gipsfaser|gips|putz|plaster/i, look: { key: 'putz', label: 'Gipskarton & Putz', color: '#efebe4', opacity: 1 } },
  { test: /d[äa]e?mm|\beps\b|\bxps\b|mineralwolle|steinwolle|glaswolle|holzfaser|insulation|zellulose/i, look: { key: 'daemmung', label: 'Dämmung', color: '#e7e1d1', opacity: 1 } },
  { test: /\bosb\b/i, look: { key: 'osb', label: 'OSB-Platten', color: '#cda874', opacity: 1 } },
  { test: /\bclt\b|brettsperrholz|\bbsp\b|x-?lam/i, look: { key: 'clt', label: 'Brettsperrholz', color: '#dcc298', opacity: 1 } },
  { test: /3-?schicht|\b3s\b|dreischicht|wei(ß|ss)tanne|mehrschicht/i, look: { key: 'dreischicht', label: 'Dreischichtplatten', color: '#e3d0aa', opacity: 1 } },
  { test: /fassade|facade|cladding|verschalung|st[üu]lpschalung|deckelschalung|l[äa]rche/i, look: { key: 'fassade', label: 'Fassade (Holz)', color: '#b58a5c', opacity: 1 } },
  { test: /lattung|latte|schalung|rauschalung|konterlatt|leiste/i, look: { key: 'lattung', label: 'Lattung & Schalung', color: '#b99464', opacity: 1 } },
  { test: /holz|\bgl\s?\d|\bbsh\b|\bkvh\b|\bc\s?(16|20|24|30)\b|fichte|tanne|l[äa]rche|kiefer|eiche|douglas|timber|wood|sparren|pfette|balken|steher|st[üu]tze|schwelle|r[äa]hm|riegel|tram|unterzug|s[äa]ule/i, look: { key: 'holz', label: 'Holz (Tragwerk)', color: '#c9a273', opacity: 1 } },
  { test: /fliese|tile|keramik|naturstein|stein|stone|granit|marmor/i, look: { key: 'stein', label: 'Stein & Fliesen', color: '#cbc6bd', opacity: 1 } },
];

const ROOF_LOOK: Look = { key: 'dach', label: 'Dach (Eindeckung)', color: '#4d5157', opacity: 1 };
const OTHER_LOOK: Look = { key: 'sonstiges', label: 'Sonstiges', color: '#cfc8bc', opacity: 1 };

function lookOf(element: IfcElement, pieceOpacity: number, roof: boolean): Look {
  if (pieceOpacity < 0.95) return LOOKS[0]!.look;
  const text = `${element.material ?? ''} ${element.name}`;
  if (element.type === 'IFCWINDOW' || element.type === 'IFCPLATE' || element.type === 'IFCCURTAINWALL') {
    if (/glas|glass/i.test(text)) return LOOKS[0]!.look;
  }
  if (roof && !/glas|glass/i.test(text)) return ROOF_LOOK;
  for (const { test, look } of LOOKS) if (test.test(text)) return look;
  if (element.type === 'IFCROOF' || element.type === 'IFCCOVERING') return roof ? ROOF_LOOK : OTHER_LOOK;
  if (element.type === 'IFCSLAB' || element.type === 'IFCFOOTING') return LOOKS[2]!.look;
  return OTHER_LOOK;
}

// --- storeys -------------------------------------------------------------------------------

type Kind = 'storey' | 'roof' | 'outside';

interface Token {
  order: number;
  short: string;
  name: string;
}

const ROOF = /(^|[\s_-])(dach|roof|bedachung|dacheindeckung)([\s_-]|$)/i;
const OUTSIDE = /carport|garage|au(ß|ss)en|terrasse|garten|gel[äa]nde|pergola|zaun|einfahrt|pool|schwimmbad|gartenhaus|site|exterior|landscap/i;
const SLAB = /decke|bodenplatte|fundament|slab|floor\s*plate|geschossdecke/i;

/** Recognises a storey in a layer or storey name ("OG 1 Wände", "Erdgeschoss", "2.OG"). */
export function storeyToken(text: string): Token | null {
  const t = ` ${text} `;
  let m: RegExpExecArray | null;
  if ((m = /[\s_-](?:(\d)\s*\.?\s*(?:UG|KG)|(?:UG|KG)\s*(\d)?|keller(?:geschoss)?|untergeschoss|basement)(?=[\s_-])/i.exec(t))) {
    const n = Number(m[1] ?? m[2] ?? 1);
    return { order: -n, short: n > 1 ? `${n}.UG` : /KG|keller/i.test(m[0]) ? 'KG' : 'UG', name: n > 1 ? `${n}. Untergeschoss` : /KG|keller/i.test(m[0]) ? 'Keller' : 'Untergeschoss' };
  }
  if (/[\s_-](EG|erdgeschoss|ground\s*floor|GF)(?=[\s_-])/i.test(t)) return { order: 0, short: 'EG', name: 'Erdgeschoss' };
  if ((m = /[\s_-](?:OG\s*(\d)|(\d)\s*\.?\s*OG|(\d)\.\s*obergeschoss|obergeschoss\s*(\d)?|OG)(?=[\s_-])/i.exec(t))) {
    const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? 1);
    return { order: n, short: `${n}.OG`, name: `${n}. Obergeschoss` };
  }
  if (/[\s_-](DG|dachgeschoss|attic)(?=[\s_-])/i.test(t)) return { order: 50, short: 'DG', name: 'Dachgeschoss' };
  if (/[\s_-](SB|spitzboden)(?=[\s_-])/i.test(t)) return { order: 60, short: 'SB', name: 'Spitzboden' };
  return null;
}

interface Measured {
  element: IfcElement;
  zmin: number;
  zmax: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

function measure(element: IfcElement): Measured {
  const m: Measured = { element, zmin: Infinity, zmax: -Infinity, xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity };
  for (const piece of element.pieces) {
    const p = piece.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i]! < m.xmin) m.xmin = p[i]!;
      if (p[i]! > m.xmax) m.xmax = p[i]!;
      if (p[i + 1]! < m.ymin) m.ymin = p[i + 1]!;
      if (p[i + 1]! > m.ymax) m.ymax = p[i + 1]!;
      if (p[i + 2]! < m.zmin) m.zmin = p[i + 2]!;
      if (p[i + 2]! > m.zmax) m.zmax = p[i + 2]!;
    }
  }
  return m;
}

/** The most common bottom height (10 cm bins): where the walls of a storey stand. */
function floorHeight(items: Measured[]): number {
  if (items.length === 0) return 0;
  const bins = new Map<number, number>();
  for (const item of items) {
    const bin = Math.round(item.zmin * 10);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let best = 0;
  let count = -1;
  for (const [bin, n] of bins) {
    if (n > count || (n === count && bin < best)) {
      best = bin;
      count = n;
    }
  }
  // The bin's lowest real value, so walls standing on it are not cut off.
  const inBin = items.filter((item) => Math.round(item.zmin * 10) === best).map((item) => item.zmin);
  return Math.min(...inBin);
}

interface LevelDraft {
  key: string;
  token: Token;
  kind: Kind;
  members: Measured[];
  floorZ: number;
}

// --- building ------------------------------------------------------------------------------

export interface BuiltModel {
  info: House3DModelInfo;
  binary: Buffer;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export function buildHouseModel(result: IfcReadResult): BuiltModel {
  const measured = result.elements.map(measure).filter((m) => Number.isFinite(m.zmin));
  if (measured.length === 0) throw new ModelError('Im Modell wurden keine darstellbaren Bauteile gefunden.');

  // 1) Storeys: from the CAD layer names ("EG Wände", "OG 1 Decke") when they name at least two,
  //    else from the model's own storeys — exporters often write one or two empty placeholder storeys.
  const layerOrders = new Set(measured.map((m) => storeyToken(m.element.layer ?? '')?.order).filter((o): o is number => o !== undefined));
  const storeyNames = new Set(measured.map((m) => m.element.storey?.name).filter((n): n is string => Boolean(n)));
  const useStoreys = layerOrders.size < 2 && storeyNames.size >= 2;
  const drafts = new Map<string, LevelDraft>();
  const roofItems: Measured[] = [];
  const outsideItems: Measured[] = [];
  const unplaced: Measured[] = [];
  const slabItems: Measured[] = [];

  for (const item of measured) {
    const { element } = item;
    const layer = element.layer ?? '';
    const label = useStoreys ? (element.storey?.name ?? '') : layer;
    // A named storey wins over the keywords: "EG Garage" is part of the ground floor.
    const named = storeyToken(layer) !== null || (useStoreys && storeyToken(label) !== null);
    if (ROOF.test(layer) || (useStoreys && ROOF.test(label)) || element.type === 'IFCROOF') {
      roofItems.push(item);
      continue;
    }
    if (!named && (OUTSIDE.test(layer) || (useStoreys && OUTSIDE.test(label)))) {
      outsideItems.push(item);
      continue;
    }
    if (SLAB.test(layer) || element.type === 'IFCSLAB') {
      slabItems.push(item);
      continue;
    }
    const token = storeyToken(label) ?? (useStoreys && label ? { order: 0, short: label.slice(0, 6), name: label } : null);
    if (!token) {
      unplaced.push(item);
      continue;
    }
    const key = useStoreys ? `s:${label}` : `t:${token.order}`;
    let draft = drafts.get(key);
    if (!draft) drafts.set(key, (draft = { key, token, kind: 'storey', members: [], floorZ: 0 }));
    draft.members.push(item);
  }

  // Sorted by height: storeys named alike ("Ebene 1", "Ebene 2") have no order of their own.
  let levels = [...drafts.values()];
  for (const level of levels) level.floorZ = floorHeight(level.members);
  levels.sort((a, b) => a.floorZ - b.floorZ || a.token.order - b.token.order);
  if (levels.length === 0) {
    // No storeys at all: one level holding everything that is not roof or outside.
    const all = [...unplaced, ...slabItems];
    levels = [{ key: 'all', token: { order: 0, short: 'Haus', name: 'Haus' }, kind: 'storey', members: [], floorZ: floorHeight(all) }];
  }

  // 2) Parts clearly outside their storey's height, slabs and parts without a storey: by height.
  const levelAt = (z: number): LevelDraft => {
    let found = levels[0]!;
    for (const level of levels) if (z >= level.floorZ - 0.35) found = level;
    return found;
  };
  const moves: [Measured, LevelDraft][] = [];
  levels.forEach((level, index) => {
    const next = levels[index + 1];
    level.members = level.members.filter((item) => {
      // Mostly below the floor (stair parts reaching down) or standing on the next floor.
      const misplaced = (item.zmin + item.zmax) / 2 < level.floorZ - 0.3 || (next !== undefined && item.zmin >= next.floorZ - 0.35);
      const target = misplaced ? levelAt(item.zmin + 0.05) : level;
      if (target === level) return true;
      moves.push([item, target]);
      return false;
    });
  });
  for (const [item, target] of moves) target.members.push(item);
  for (const item of unplaced) levelAt(item.zmin + 0.05).members.push(item);
  for (const item of slabItems) {
    // A slab is the floor of the storey whose floor height is closest to its top.
    let best = levels[0]!;
    for (const level of levels) if (Math.abs(level.floorZ - item.zmax) < Math.abs(best.floorZ - item.zmax)) best = level;
    best.members.push(item);
  }

  const roof: LevelDraft | null = roofItems.length > 0 ? { key: 'roof', token: { order: 100, short: 'Dach', name: 'Dach' }, kind: 'roof', members: roofItems, floorZ: Math.min(...roofItems.map((i) => i.zmin)) } : null;
  const outside: LevelDraft | null = outsideItems.length > 0 ? { key: 'outside', token: { order: 200, short: 'Außen', name: 'Außenbereich' }, kind: 'outside', members: outsideItems, floorZ: Math.min(...outsideItems.map((i) => i.zmin)) } : null;
  const all = [...levels, ...(roof ? [roof] : []), ...(outside ? [outside] : [])].filter((l) => l.members.length > 0);

  // 3) Ground: where the outdoor parts stand, else the ground floor.
  const groundFloor = levels.find((l) => l.token.order === 0) ?? levels.find((l) => l.floorZ >= -0.5) ?? levels[0]!;
  const ground = outside ? Math.max(Math.min(...outside.members.map((i) => i.zmin)), groundFloor.floorZ - 1.5) : groundFloor.floorZ;

  // 4) Centre the model on the ground.
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  let zmax = -Infinity;
  let zmin = Infinity;
  for (const item of measured) {
    xmin = Math.min(xmin, item.xmin);
    xmax = Math.max(xmax, item.xmax);
    ymin = Math.min(ymin, item.ymin);
    ymax = Math.max(ymax, item.ymax);
    zmin = Math.min(zmin, item.zmin);
    zmax = Math.max(zmax, item.zmax);
  }
  const origin: [number, number, number] = [(xmin + xmax) / 2, (ymin + ymax) / 2, ground];

  // 5) Merge everything into one mesh per level and look.
  interface Bucket {
    level: number;
    look: Look;
    positions: number[];
    indices: number[];
  }
  const buckets = new Map<string, Bucket>();
  const materialCounts = new Map<string, { look: Look; count: number }>();
  const out: House3DLevel[] = [];
  const usedIds = new Set<string>();
  const levelId = (draft: LevelDraft): string => {
    const base = draft.kind === 'storey' ? slugify(draft.token.short) : draft.key;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };
  all.forEach((draft, levelIndex) => {
    const topZ = Math.max(...draft.members.map((i) => i.zmax));
    const lowZ = Math.min(...draft.members.map((i) => i.zmin));
    const floorZ = draft.kind === 'storey' ? draft.floorZ : lowZ;
    out.push({
      id: levelId(draft),
      kind: draft.kind,
      short: draft.token.short,
      name: draft.token.name,
      floorZ: round(floorZ - origin[2]),
      topZ: round(topZ - origin[2]),
      cutZ: round(Math.min(floorZ + 1.2, topZ - 0.05) - origin[2]),
      bottomZ: round(lowZ - origin[2]),
      elements: draft.members.length,
    });
    for (const { element } of draft.members) {
      const seen = new Set<string>();
      for (const piece of element.pieces) {
        const look = lookOf(element, piece.opacity, draft.kind === 'roof');
        const key = `${levelIndex}/${look.key}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, (bucket = { level: levelIndex, look, positions: [], indices: [] }));
        const base = bucket.positions.length / 3;
        const p = piece.positions;
        for (let i = 0; i < p.length; i += 3) bucket.positions.push(p[i]! - origin[0], p[i + 1]! - origin[1], p[i + 2]! - origin[2]);
        for (const index of piece.indices) bucket.indices.push(base + index);
        if (!seen.has(look.key)) {
          seen.add(look.key);
          const entry = materialCounts.get(look.key) ?? { look, count: 0 };
          entry.count++;
          materialCounts.set(look.key, entry);
        }
      }
    }
  });

  // 6) Write the binary.
  const groups: House3DGroup[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  let triangles = 0;
  for (const bucket of [...buckets.values()].sort((a, b) => a.level - b.level || a.look.key.localeCompare(b.look.key))) {
    const positions = Buffer.from(new Float32Array(bucket.positions).buffer);
    const indices = Buffer.from(new Uint32Array(bucket.indices).buffer);
    groups.push({
      level: bucket.level,
      material: bucket.look.key,
      positionOffset: offset,
      vertexCount: bucket.positions.length / 3,
      indexOffset: offset + positions.length,
      indexCount: bucket.indices.length,
    });
    chunks.push(positions, indices);
    offset += positions.length + indices.length;
    triangles += bucket.indices.length / 3;
  }

  const materials: House3DMaterial[] = [...materialCounts.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ look, count }) => ({ key: look.key, label: look.label, color: look.color, opacity: look.opacity, elements: count }));

  const warnings: string[] = [];
  const skippedTotal = Object.values(result.skipped).reduce((a, b) => a + b, 0);
  if (skippedTotal > 0) warnings.push(`${skippedTotal} Geometrie-Teile in einer nicht unterstützten Form wurden ausgelassen (${Object.keys(result.skipped).slice(0, 4).join(', ')}).`);
  if (result.simplified > 0) warnings.push(`${result.simplified} Bauteile mit Ausschnitten werden ohne Ausschnitt gezeigt.`);
  if (out.filter((l) => l.kind === 'storey').length <= 1) warnings.push('Im Modell wurden keine Geschosse erkannt; es wird als ein Geschoss gezeigt.');

  const info: House3DModelInfo = {
    format: MODEL_FORMAT,
    schema: result.schema,
    application: result.application,
    elements: measured.length,
    triangles,
    origin: origin.map(round) as [number, number, number],
    trueNorthDeg: result.trueNorthDeg,
    location: result.location,
    size: [round(xmax - xmin), round(ymax - ymin), round(zmax - zmin)],
    bounds: { min: [round(xmin - origin[0]), round(ymin - origin[1]), round(zmin - origin[2])], max: [round(xmax - origin[0]), round(ymax - origin[1]), round(zmax - origin[2])] },
    levels: out,
    materials,
    warnings,
  };

  const header = Buffer.from(JSON.stringify({ info, groups }), 'utf8');
  const padded = Buffer.alloc(Math.ceil(header.length / 4) * 4, 0x20);
  header.copy(padded);
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(MODEL_FORMAT, 4);
  prefix.writeUInt32LE(padded.length, 8);
  return { info, binary: Buffer.concat([prefix, padded, ...chunks]) };
}

/** Reads the header of a model file written by `buildHouseModel`. */
export function readModelHeader(binary: Buffer): { info: House3DModelInfo; groups: House3DGroup[]; dataOffset: number } {
  if (binary.length < 12 || binary.toString('ascii', 0, 4) !== MAGIC) throw new ModelError('Die Modelldatei ist beschädigt.');
  const length = binary.readUInt32LE(8);
  const parsed = JSON.parse(binary.toString('utf8', 12, 12 + length)) as { info: House3DModelInfo; groups: House3DGroup[] };
  return { ...parsed, dataOffset: 12 + length };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
