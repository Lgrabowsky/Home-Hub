import type { House3DMarker } from '@home-hub/shared';

/**
 * A made-up house as an IFC file, written the way timber construction CAD
 * exports it (faceted B-reps, storeys named by their CAD layers). The demo
 * mode shows it, and the tests convert it.
 *
 *   Keller under the western half · Erdgeschoss · Obergeschoss · gable roof
 *   Carport to the east · terrace to the south (the garden side)
 *
 * Metres, Z up, north = +Y. The house covers x 0…12, y 0…9.
 */

type V3 = [number, number, number];

/** STEP strings: quotes doubled, everything beyond ASCII as \X2\ escapes. */
export function stepString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code >= 32 && code < 127) out += ch;
    else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return `'${out}'`;
}

const num = (n: number) => {
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '') : `${s}.`;
};

class IfcWriter {
  private lines: string[] = [];
  private next = 1;
  private readonly materials = new Map<string, { id: number; elements: number[] }>();
  private readonly layers = new Map<string, number[]>();
  private readonly colours = new Map<string, number>();
  readonly elements: number[] = [];
  private placement = 0;
  private context = 0;
  private owner = 0;
  private guid = 0;

  add(text: string): number {
    const id = this.next++;
    this.lines.push(`#${id}=${text};`);
    return id;
  }

  private gid(): string {
    // 22 characters from the IFC base-64 alphabet; deterministic, so the file is reproducible.
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    let n = ++this.guid;
    let s = '';
    for (let i = 0; i < 22; i++) {
      s = alphabet[n % 64] + s;
      n = Math.floor(n / 64);
    }
    return `'${s}'`;
  }

  start(): void {
    const person = this.add("IFCPERSON($,'Demo','Haus',$,$,$,$,$)");
    const org = this.add("IFCORGANIZATION($,'Home Hub',$,$,$)");
    const po = this.add(`IFCPERSONANDORGANIZATION(#${person},#${org},$)`);
    const app = this.add(`IFCAPPLICATION(#${org},'1.0','Home Hub Demo','HomeHubDemo')`);
    this.owner = this.add(`IFCOWNERHISTORY(#${po},#${app},$,.ADDED.,0,$,$,0)`);
    const metre = this.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    const units = this.add(`IFCUNITASSIGNMENT((#${metre}))`);
    const origin = this.add('IFCCARTESIANPOINT((0.,0.,0.))');
    const axis = this.add(`IFCAXIS2PLACEMENT3D(#${origin},$,$)`);
    const north = this.add('IFCDIRECTION((0.,1.))');
    this.context = this.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axis},#${north})`);
    const project = this.add(`IFCPROJECT(${this.gid()},#${this.owner},${stepString('Demo-Haus')},$,$,$,$,(#${this.context}),#${units})`);
    this.placement = this.add(`IFCLOCALPLACEMENT($,#${axis})`);
    const site = this.add(`IFCSITE(${this.gid()},#${this.owner},'Grundstück',$,$,#${this.placement},$,$,.ELEMENT.,$,$,$,$,$)`);
    const building = this.add(`IFCBUILDING(${this.gid()},#${this.owner},'Haus',$,$,#${this.placement},$,$,.ELEMENT.,$,$,$)`);
    const storey = this.add(`IFCBUILDINGSTOREY(${this.gid()},#${this.owner},'Default Storey',$,$,#${this.placement},$,$,.ELEMENT.,0.)`);
    this.add(`IFCRELAGGREGATES(${this.gid()},#${this.owner},$,$,#${project},(#${site}))`);
    this.add(`IFCRELAGGREGATES(${this.gid()},#${this.owner},$,$,#${site},(#${building}))`);
    this.add(`IFCRELAGGREGATES(${this.gid()},#${this.owner},$,$,#${building},(#${storey}))`);
    this.storey = storey;
  }

  private storey = 0;

  private colour(hex: string): number {
    let id = this.colours.get(hex);
    if (id) return id;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const rgb = this.add(`IFCCOLOURRGB($,${num(r)},${num(g)},${num(b)})`);
    const rendering = this.add(`IFCSURFACESTYLERENDERING(#${rgb},${hex === '#00ffff' ? '0.6' : '0.'},$,$,$,$,$,$,.NOTDEFINED.)`);
    const style = this.add(`IFCSURFACESTYLE($,.BOTH.,(#${rendering}))`);
    id = this.add(`IFCPRESENTATIONSTYLEASSIGNMENT((#${style}))`);
    this.colours.set(hex, id);
    return id;
  }

  /** A closed solid from its corner points and faces (vertex indices, counter-clockwise from outside). */
  solid(name: string, material: string, layer: string, cadColour: string, points: V3[], faces: number[][]): void {
    const pointIds = points.map((p) => this.add(`IFCCARTESIANPOINT((${p.map(num).join(',')}))`));
    const faceIds = faces.map((face) => {
      const loop = this.add(`IFCPOLYLOOP((${face.map((i) => `#${pointIds[i]}`).join(',')}))`);
      const bound = this.add(`IFCFACEOUTERBOUND(#${loop},.T.)`);
      return this.add(`IFCFACE((#${bound}))`);
    });
    const shell = this.add(`IFCCLOSEDSHELL((${faceIds.map((f) => `#${f}`).join(',')}))`);
    const brep = this.add(`IFCFACETEDBREP(#${shell})`);
    this.add(`IFCSTYLEDITEM(#${brep},(#${this.colour(cadColour)}),$)`);
    const rep = this.add(`IFCSHAPEREPRESENTATION(#${this.context},'Body','Brep',(#${brep}))`);
    const shape = this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const element = this.add(`IFCBUILDINGELEMENTPROXY(${this.gid()},#${this.owner},${stepString(name)},'',$,#${this.placement},#${shape},$,.ELEMENT.)`);
    this.elements.push(element);
    let entry = this.materials.get(material);
    if (!entry) this.materials.set(material, (entry = { id: this.add(`IFCMATERIAL(${stepString(material)})`), elements: [] }));
    entry.elements.push(element);
    const list = this.layers.get(layer) ?? [];
    list.push(rep);
    this.layers.set(layer, list);
  }

  box(name: string, material: string, layer: string, colour: string, a: V3, b: V3): void {
    const [x0, y0, z0] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const [x1, y1, z1] = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6 || z1 - z0 < 1e-6) return;
    this.solid(
      name,
      material,
      layer,
      colour,
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
      ],
    );
  }

  finish(): string {
    for (const [name, reps] of this.layers) this.add(`IFCPRESENTATIONLAYERASSIGNMENT(${stepString(name)},$,(${reps.map((r) => `#${r}`).join(',')}),$)`);
    for (const { id, elements } of this.materials.values()) {
      this.add(`IFCRELASSOCIATESMATERIAL(${this.gid()},#${this.owner},$,$,(${elements.map((e) => `#${e}`).join(',')}),#${id})`);
    }
    this.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${this.gid()},#${this.owner},$,$,(${this.elements.map((e) => `#${e}`).join(',')}),#${this.storey})`);
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
      "FILE_NAME('Demo-Haus.ifc','2026-01-01T00:00:00',(''),(''),'','Home Hub Demo','');",
      "FILE_SCHEMA(('IFC2X3'));",
      'ENDSEC;',
      'DATA;',
      ...this.lines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }
}

interface Opening {
  /** Distance along the wall from its start. */
  from: number;
  to: number;
  sill: number;
  head: number;
}

/** CAD colours as a timber construction program would use them (the hub chooses real ones). */
const CAD = { cladding: '#00ff00', structure: '#0082ff', board: '#ffffff', concrete: '#999999', glass: '#00ffff', steel: '#ff0000', deck: '#00a851' };

/**
 * An exterior wall from (x0,y0) to (x1,y1): timber core with plasterboard inside and larch boards
 * outside, cut around its openings. The walls run clockwise around the house (seen from above),
 * so the outside is to the left of the direction of travel.
 */
function exteriorWall(w: IfcWriter, layer: string, start: [number, number], end: [number, number], z0: number, z1: number, openings: Opening[] = []): void {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const dir = [(end[0] - start[0]) / length, (end[1] - start[1]) / length] as const;
  const out = [-dir[1], dir[0]] as const; // to the left = outside
  const skins: { name: string; material: string; colour: string; inner: number; outer: number }[] = [
    { name: 'GK', material: 'Gipskarton', colour: CAD.board, inner: -0.26, outer: -0.245 },
    { name: 'STEHER', material: 'KVH', colour: CAD.structure, inner: -0.245, outer: -0.03 },
    { name: 'Fassade Lärche', material: 'Lärche', colour: CAD.cladding, inner: -0.03, outer: 0 },
  ];
  const at = (s: number, offset: number): [number, number] => [start[0] + dir[0] * s + out[0] * offset, start[1] + dir[1] * s + out[1] * offset];
  const piece = (skin: (typeof skins)[number], s0: number, s1: number, h0: number, h1: number) => {
    if (s1 - s0 < 1e-6 || h1 - h0 < 1e-6) return;
    const a = at(s0, skin.inner);
    const b = at(s1, skin.inner);
    const c = at(s1, skin.outer);
    const d = at(s0, skin.outer);
    w.solid(skin.name, skin.material, layer, skin.colour, [
      [a[0], a[1], h0],
      [b[0], b[1], h0],
      [c[0], c[1], h0],
      [d[0], d[1], h0],
      [a[0], a[1], h1],
      [b[0], b[1], h1],
      [c[0], c[1], h1],
      [d[0], d[1], h1],
    ], [
      [0, 1, 2, 3],
      [4, 7, 6, 5],
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ]);
  };
  const sorted = [...openings].sort((a, b) => a.from - b.from);
  for (const skin of skins) {
    let s = 0;
    for (const o of sorted) {
      piece(skin, s, o.from, z0, z1);
      piece(skin, o.from, o.to, z0, z0 + o.sill);
      piece(skin, o.from, o.to, z0 + o.head, z1);
      s = o.to;
    }
    piece(skin, s, length, z0, z1);
  }
  for (const o of sorted) {
    if (o.sill === 0 && o.head < 2.3 && o.to - o.from < 1.3) {
      // A door: solid wood.
      const a = at(o.from, -0.2);
      const b = at(o.to, -0.15);
      w.box('Haustür', 'Eiche', layer, CAD.structure, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0], [Math.max(a[0], b[0]), Math.max(a[1], b[1]), z0 + o.head]);
      continue;
    }
    const a = at(o.from, -0.14);
    const b = at(o.to, -0.12);
    w.box('Verglasung', 'Glas', layer, CAD.glass, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0 + o.sill], [Math.max(a[0], b[0]), Math.max(a[1], b[1]), z0 + o.head]);
  }
}

function interiorWall(w: IfcWriter, layer: string, a: [number, number], b: [number, number], z0: number, z1: number): void {
  const t = 0.06;
  const horizontal = a[1] === b[1];
  const p0: V3 = horizontal ? [Math.min(a[0], b[0]), a[1] - t, z0] : [a[0] - t, Math.min(a[1], b[1]), z0];
  const p1: V3 = horizontal ? [Math.max(a[0], b[0]), a[1] + t, z1] : [a[0] + t, Math.max(a[1], b[1]), z1];
  w.box('Innenwand GK', 'Gipskarton', layer, CAD.board, p0, p1);
}

/** The demo house as IFC text. */
export function demoHouseIfc(): string {
  const w = new IfcWriter();
  w.start();
  const window = (from: number, to: number, sill = 0.9, head = 2.25): Opening => ({ from, to, sill, head });
  const door = (from: number, to: number, head = 2.2): Opening => ({ from, to, sill: 0, head });

  // Keller (western half), concrete.
  w.box('Bodenplatte', 'Beton C25/30', 'KG Bodenplatte', CAD.concrete, [0, 0, -2.85], [6, 9, -2.6]);
  for (const [a, b] of [
    [[0, 0], [6, 0.25]],
    [[0, 8.75], [6, 9]],
    [[0, 0], [0.25, 9]],
    [[5.75, 0], [6, 9]],
  ] as [[number, number], [number, number]][]) {
    w.box('Kellerwand', 'Beton C25/30', 'KG Wände', CAD.concrete, [a[0], a[1], -2.6], [b[0], b[1], -0.3]);
  }
  interiorWall(w, 'KG Wände', [0.25, 4.5], [5.75, 4.5], -2.6, -0.3);

  // Erdgeschoss: z 0 … 2.75. South (y = 0) faces the garden.
  w.box('Bodenplatte', 'Beton C25/30', 'EG Bodenplatte', CAD.concrete, [0, 0, -0.3], [12, 9, 0]);
  exteriorWall(w, 'EG Wände', [12, 0], [0, 0], 0, 2.75, [window(0.6, 2.6, 0.45), window(3.4, 5.4, 0), window(7.2, 11.2, 0)]);
  exteriorWall(w, 'EG Wände', [0, 0], [0, 9], 0, 2.75, [window(1.5, 3.5), window(6, 7.4)]);
  exteriorWall(w, 'EG Wände', [0, 9], [12, 9], 0, 2.75, [window(1.2, 2.4), window(5, 5.8, 1.6), door(8.6, 9.7), window(10.4, 11.4)]);
  exteriorWall(w, 'EG Wände', [12, 9], [12, 0], 0, 2.75, [window(1.5, 3.5), window(5.6, 7.2)]);
  interiorWall(w, 'EG Wände', [0.26, 5], [11.74, 5], 0, 2.75);
  interiorWall(w, 'EG Wände', [4, 5], [4, 8.74], 0, 2.75);
  interiorWall(w, 'EG Wände', [8, 5], [8, 8.74], 0, 2.75);
  interiorWall(w, 'EG Wände', [9, 0.26], [9, 5], 0, 2.75);
  w.box('Geschossdecke', 'CLT 200 L5s', 'EG Decke', '#ffff00', [0, 0, 2.75], [12, 9, 3.0]);

  // Obergeschoss: z 3.0 … 5.6.
  exteriorWall(w, 'OG 1 Wände', [12, 0], [0, 0], 3.0, 5.6, [window(1, 3), window(5.5, 7.5), window(9.8, 11)]);
  exteriorWall(w, 'OG 1 Wände', [0, 0], [0, 9], 3.0, 5.6, [window(2, 3.5)]);
  exteriorWall(w, 'OG 1 Wände', [0, 9], [12, 9], 3.0, 5.6, [window(1.5, 3), window(5.4, 6.6), window(9, 10.5)]);
  exteriorWall(w, 'OG 1 Wände', [12, 9], [12, 0], 3.0, 5.6, [window(2, 3.4)]);
  interiorWall(w, 'OG 1 Wände', [0.26, 5], [11.74, 5], 3.0, 5.6);
  interiorWall(w, 'OG 1 Wände', [5, 0.26], [5, 5], 3.0, 5.6);
  interiorWall(w, 'OG 1 Wände', [9, 0.26], [9, 5], 3.0, 5.6);
  w.box('Geschossdecke', 'CLT 200 L5s', 'OG 1 Decke', '#ffff00', [0, 0, 5.6], [12, 9, 5.85]);

  // Gable ends (triangles above the top ceiling) and the gable roof, ridge along x.
  const ridge = 8.6;
  for (const x of [0, 11.97]) {
    w.solid('Giebel', 'Lärche', 'OG 1 Wände', CAD.cladding, [
      [x, 0, 5.85],
      [x, 9, 5.85],
      [x, 4.5, ridge - 0.05],
      [x + 0.03, 0, 5.85],
      [x + 0.03, 9, 5.85],
      [x + 0.03, 4.5, ridge - 0.05],
    ], [
      [0, 2, 1],
      [3, 4, 5],
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [2, 0, 3, 5],
    ]);
  }
  const roofSlab = (y0: number, y1: number, z0: number, z1: number) => {
    const t = 0.3;
    w.solid('Dachfläche', 'Blech', 'Dach', '#ff00ff', [
      [-0.5, y0, z0],
      [12.5, y0, z0],
      [12.5, y1, z1],
      [-0.5, y1, z1],
      [-0.5, y0, z0 + t],
      [12.5, y0, z0 + t],
      [12.5, y1, z1 + t],
      [-0.5, y1, z1 + t],
    ], [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ]);
  };
  const slope = (ridge - 5.85) / 4.5;
  roofSlab(-0.6, 4.5, 5.85 - 0.6 * slope, ridge);
  roofSlab(9.6, 4.5, 5.85 - 0.6 * slope, ridge);

  // Carport (east), steel posts and a flat roof.
  for (const [x, y] of [
    [12.6, 3.2],
    [17.8, 3.2],
    [12.6, 8.8],
    [17.8, 8.8],
  ] as [number, number][]) {
    w.box('Stahlsäule', 'Stahl S235', 'Carport', CAD.steel, [x - 0.06, y - 0.06, 0], [x + 0.06, y + 0.06, 2.55]);
  }
  w.box('Carportdach', 'Stahl Trapezblech', 'Carport', CAD.steel, [12.4, 3.0, 2.55], [18.0, 9.0, 2.7]);

  // Terrace in the garden (south).
  w.box('Terrassendielen', 'Lärche', 'Terrasse', CAD.deck, [0, -3.6, -0.05], [9, 0, 0]);

  return w.finish();
}

/** Where the demo devices sit (IFC coordinates). */
export const DEMO_HOUSE_MARKERS: House3DMarker[] = [
  // Erdgeschoss
  { entityId: 'gekko:lights/item0', position: [3, 2.5, 2.6], level: 'eg' },
  { entityId: 'gekko:lights/item1', position: [0.8, 4.2, 1.5], level: 'eg' },
  { entityId: 'gekko:lights/item2', position: [3, 0.6, 0.4], level: 'eg' },
  { entityId: 'gekko:lights/item3', position: [10.5, 2.5, 2.6], level: 'eg' },
  { entityId: 'gekko:lights/item4', position: [11.4, 3.6, 1.0], level: 'eg' },
  { entityId: 'gekko:lights/item5', position: [7.5, 2.5, 2.4], level: 'eg' },
  { entityId: 'gekko:lights/item9', position: [6, 7, 2.6], level: 'eg' },
  { entityId: 'gekko:lights/item10', position: [2, 7, 2.6], level: 'eg' },
  { entityId: 'gekko:blinds/item0', position: [1.6, -0.05, 1.9], level: 'eg' },
  { entityId: 'gekko:blinds/item2', position: [4.6, -0.05, 2.1], level: 'eg' },
  { entityId: 'gekko:blinds/item4', position: [7.6, -0.05, 2.1], level: 'eg' },
  { entityId: 'gekko:blinds/item3', position: [10.4, -0.05, 2.1], level: 'eg' },
  { entityId: 'gekko:blinds/item8', position: [-0.05, 7.2, 1.9], level: 'eg' },
  { entityId: 'gekko:roomtemps/item0', position: [5.7, 3.6, 1.4], level: 'eg' },
  { entityId: 'gekko:roomtemps/item1', position: [11.7, 1.5, 1.4], level: 'eg' },
  { entityId: 'gekko:roomtemps/item6', position: [0.4, 5.6, 1.4], level: 'eg' },
  { entityId: 'gekko:loads/item3', position: [0.5, 2.4, 0.3], level: 'eg' },
  { entityId: 'gekko:loads/item4', position: [11.6, 4.4, 0.95], level: 'eg' },
  // Obergeschoss
  { entityId: 'gekko:lights/item6', position: [2.5, 2.5, 5.4], level: '1-og' },
  { entityId: 'gekko:lights/item7', position: [7, 2.5, 5.4], level: '1-og' },
  { entityId: 'gekko:lights/item8', position: [10.5, 2.5, 4.8], level: '1-og' },
  { entityId: 'gekko:blinds/item5', position: [2, -0.05, 4.9], level: '1-og' },
  { entityId: 'gekko:blinds/item6', position: [6.5, -0.05, 4.9], level: '1-og' },
  { entityId: 'gekko:blinds/item7', position: [10.4, -0.05, 4.9], level: '1-og' },
  { entityId: 'gekko:roomtemps/item3', position: [4.7, 3.5, 4.4], level: '1-og' },
  { entityId: 'gekko:roomtemps/item4', position: [8.7, 3.5, 4.4], level: '1-og' },
  { entityId: 'gekko:roomtemps/item5', position: [11.7, 2.8, 4.4], level: '1-og' },
  { entityId: 'gekko:loads/item2', position: [11.6, 4.6, 5.3], level: '1-og' },
  // Outside
  { entityId: 'gekko:lights/item12', position: [4.5, -0.1, 2.5], level: 'outside' },
  { entityId: 'gekko:loads/item0', position: [8.6, -0.1, 0.4], level: 'outside' },
  { entityId: 'gekko:loads/item1', position: [8, -3.4, 0.2], level: 'outside' },
];
