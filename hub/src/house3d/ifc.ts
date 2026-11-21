import earcut from 'earcut';
import { Enum, Ref, Typed, type StepEntity, type StepFile, type StepValue } from './step.ts';

/**
 * Pulls the visible geometry out of an IFC model (IFC2X3 or IFC4): every
 * product with a body representation, placed in world coordinates (metres,
 * Z up), triangulated, with its colour, material, CAD layer and storey.
 *
 * Supported: faceted B-reps, surface models, IFC4 triangle and polygon face
 * sets, extrusions of the usual profiles, mapped items, blocks. Boolean
 * results show their first operand (openings are not cut out); anything else
 * is counted as skipped, so the administrator can be told.
 */

export type Vec3 = [number, number, number];
type Vec2 = [number, number];
/** Column-major 4×4 matrix. */
type Mat4 = Float64Array;

export interface IfcPiece {
  /** Colour from the model's own styles (0–1), null when the model sets none. */
  color: Vec3 | null;
  /** 1 = opaque. */
  opacity: number;
  /** World coordinates in metres, Z up: x0,y0,z0,x1,… */
  positions: number[];
  indices: number[];
}

export interface IfcElement {
  id: number;
  type: string;
  name: string;
  material: string | null;
  layer: string | null;
  storey: { name: string; elevation: number | null } | null;
  pieces: IfcPiece[];
}

export interface IfcReadResult {
  schema: string;
  application: string;
  projectName: string;
  /** Degrees clockwise from +Y where north is (0 when the model does not say). */
  trueNorthDeg: number;
  location: { latitude: number; longitude: number } | null;
  elements: IfcElement[];
  /** Representation types the reader could not show, with how often they occurred. */
  skipped: Record<string, number>;
  /** Boolean results shown without their cut (openings, clipped walls). */
  simplified: number;
}

const NOT_SHOWN = new Set([
  'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE',
  'IFCSPACE',
  'IFCANNOTATION',
  'IFCGRID',
  'IFCVIRTUALELEMENT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCSPATIALZONE',
  'IFCEXTERNALSPATIALELEMENT',
  'IFCVOIDINGFEATURE',
  'IFCALIGNMENT',
]);

const SI_PREFIX: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 100, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };

// --- small vector / matrix helpers -----------------------------------------------------------

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return out;
}

function fromBasis(x: Vec3, y: Vec3, z: Vec3, origin: Vec3): Mat4 {
  return Float64Array.of(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1);
}

function apply(m: Mat4, p: Vec3): Vec3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : fallback;
}

/** Right-handed basis from a Z axis and a reference X direction (IFC's Axis2Placement rule). */
function basis(zIn: Vec3 | null, xIn: Vec3 | null): [Vec3, Vec3, Vec3] {
  const z = normalize(zIn ?? [0, 0, 1], [0, 0, 1]);
  let xRef = normalize(xIn ?? [1, 0, 0], [1, 0, 0]);
  if (Math.abs(dot(xRef, z)) > 0.999) xRef = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(xRef, z);
  const x = normalize([xRef[0] - d * z[0], xRef[1] - d * z[1], xRef[2] - d * z[2]], [1, 0, 0]);
  return [x, cross(z, x), z];
}

/** Newell's method: normal of a (possibly non-convex) polygon, length = twice its area. */
function polygonNormal(points: Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

function signedArea2(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

// --- mesh accumulation --------------------------------------------------------------------------

class MeshBuilder {
  positions: number[] = [];
  indices: number[] = [];

  vertex(p: Vec3): number {
    this.positions.push(p[0], p[1], p[2]);
    return this.positions.length / 3 - 1;
  }

  point(index: number): Vec3 {
    return [this.positions[index * 3]!, this.positions[index * 3 + 1]!, this.positions[index * 3 + 2]!];
  }

  /** Triangulates a planar face given as vertex indices: outer loop first, then holes. */
  face(loops: number[][]): void {
    const outer = loops[0];
    if (!outer || outer.length < 3) return;
    const outerPoints = outer.map((i) => this.point(i));
    const normal = polygonNormal(outerPoints);
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length < 1e-14) return; // degenerate
    if (loops.length === 1 && outer.length === 3) {
      this.indices.push(outer[0]!, outer[1]!, outer[2]!);
      return;
    }
    // Project onto the plane the face is most parallel to, then let earcut do the work.
    const ax = Math.abs(normal[0]);
    const ay = Math.abs(normal[1]);
    const az = Math.abs(normal[2]);
    const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
    const flat: number[] = [];
    const holes: number[] = [];
    const all: number[] = [];
    loops.forEach((loop, index) => {
      if (loop.length < 3) return;
      if (index > 0) holes.push(all.length);
      for (const vertex of loop) {
        flat.push(this.positions[vertex * 3 + u]!, this.positions[vertex * 3 + v]!);
        all.push(vertex);
      }
    });
    const triangles = earcut(flat, holes.length > 0 ? holes : undefined, 2);
    for (let t = 0; t < triangles.length; t += 3) {
      const a = all[triangles[t]!]!;
      const b = all[triangles[t + 1]!]!;
      const c = all[triangles[t + 2]!]!;
      // Keep the face's own orientation (earcut does not promise one).
      const tn = cross(sub(this.point(b), this.point(a)), sub(this.point(c), this.point(a)));
      if (dot(tn, normal) < 0) this.indices.push(a, c, b);
      else this.indices.push(a, b, c);
    }
  }

  /** Closed solids should face outwards; some exporters write them inside out. */
  orientOutwards(fromIndex: number): void {
    let volume = 0;
    for (let t = fromIndex; t < this.indices.length; t += 3) {
      const a = this.point(this.indices[t]!);
      const b = this.point(this.indices[t + 1]!);
      const c = this.point(this.indices[t + 2]!);
      volume += dot(a, cross(b, c));
    }
    if (volume >= 0) return;
    for (let t = fromIndex; t < this.indices.length; t += 3) {
      const b = this.indices[t + 1]!;
      this.indices[t + 1] = this.indices[t + 2]!;
      this.indices[t + 2] = b;
    }
  }
}

// --- the reader -------------------------------------------------------------------------------

interface Style {
  color: Vec3 | null;
  opacity: number;
}

const NO_STYLE: Style = { color: null, opacity: 1 };

export class IfcReader {
  private readonly entities: Map<number, StepEntity>;
  private readonly placements = new Map<number, Mat4>();
  private readonly itemStyles = new Map<number, Style>();
  private readonly materialStyles = new Map<number, Style>();
  private readonly layers = new Map<number, string>();
  private readonly materialOf = new Map<number, number>();
  private readonly storeyOf = new Map<number, number>();
  private readonly parentOf = new Map<number, number>();
  private readonly typeOf = new Map<number, number>();
  private readonly unit: number;
  readonly skipped: Record<string, number> = {};
  simplified = 0;

  constructor(private readonly file: StepFile) {
    this.entities = file.entities;
    this.unit = this.lengthUnit();
    this.indexStyles();
    this.indexRelations();
  }

  // --- access helpers

  private entity(value: StepValue | undefined): StepEntity | null {
    return value instanceof Ref ? (this.entities.get(value.id) ?? null) : null;
  }

  private ids(type: string): number[] {
    return this.file.byType.get(type) ?? [];
  }

  private num(value: StepValue | undefined, fallback = 0): number {
    if (typeof value === 'number') return value;
    if (value instanceof Typed) return this.num(value.value, fallback);
    return fallback;
  }

  private text(value: StepValue | undefined): string {
    if (typeof value === 'string') return value;
    if (value instanceof Typed) return this.text(value.value);
    return '';
  }

  private list(value: StepValue | undefined): StepValue[] {
    return Array.isArray(value) ? value : [];
  }

  private skip(kind: string): void {
    this.skipped[kind] = (this.skipped[kind] ?? 0) + 1;
  }

  // --- units

  private lengthUnit(): number {
    for (const id of this.ids('IFCUNITASSIGNMENT')) {
      for (const unit of this.list(this.entities.get(id)!.args[0])) {
        const e = this.entity(unit);
        if (!e) continue;
        if (e.type === 'IFCSIUNIT' && e.args[1] instanceof Enum && e.args[1].value === 'LENGTHUNIT') {
          const prefix = e.args[2] instanceof Enum ? e.args[2].value : null;
          return prefix ? (SI_PREFIX[prefix] ?? 1) : 1;
        }
        if (e.type === 'IFCCONVERSIONBASEDUNIT' && e.args[1] instanceof Enum && e.args[1].value === 'LENGTHUNIT') {
          const measure = this.entity(e.args[3]);
          if (!measure) continue;
          const base = this.entity(measure.args[1]);
          const basePrefix = base?.args[2] instanceof Enum ? base.args[2].value : null;
          return this.num(measure.args[0], 1) * (basePrefix ? (SI_PREFIX[basePrefix] ?? 1) : 1);
        }
      }
    }
    return 1;
  }

  // --- points and placements (all lengths scaled to metres here)

  private point3(value: StepValue | undefined): Vec3 {
    const e = this.entity(value);
    const c = e ? this.list(e.args[0]) : [];
    return [this.num(c[0]) * this.unit, this.num(c[1]) * this.unit, this.num(c[2]) * this.unit];
  }

  private point2(value: StepValue | undefined): Vec2 {
    const e = this.entity(value);
    const c = e ? this.list(e.args[0]) : [];
    return [this.num(c[0]) * this.unit, this.num(c[1]) * this.unit];
  }

  private direction(value: StepValue | undefined): Vec3 | null {
    const e = this.entity(value);
    if (!e) return null;
    const c = this.list(e.args[0]);
    return [this.num(c[0]), this.num(c[1]), this.num(c[2])];
  }

  private axis3(value: StepValue | undefined): Mat4 {
    const e = this.entity(value);
    if (!e) return identity();
    if (e.type === 'IFCAXIS2PLACEMENT2D') {
      const [x, y, z] = basis([0, 0, 1], this.direction(e.args[1]));
      const p = this.point2(e.args[0]);
      return fromBasis(x, y, z, [p[0], p[1], 0]);
    }
    const [x, y, z] = basis(this.direction(e.args[1]), this.direction(e.args[2]));
    return fromBasis(x, y, z, this.point3(e.args[0]));
  }

  private placement(value: StepValue | undefined, depth = 0): Mat4 {
    const e = this.entity(value);
    if (!e || depth > 64) return identity();
    const cached = this.placements.get(e.id);
    if (cached) return cached;
    let m = identity();
    if (e.type === 'IFCLOCALPLACEMENT') {
      m = multiply(this.placement(e.args[0], depth + 1), this.axis3(e.args[1]));
    }
    this.placements.set(e.id, m);
    return m;
  }

  /** IfcCartesianTransformationOperator3D (used by mapped items). */
  private operator(value: StepValue | undefined): Mat4 {
    const e = this.entity(value);
    if (!e) return identity();
    const x1 = this.direction(e.args[0]);
    const x3 = this.direction(e.args[4]);
    const [x, y, z] = basis(x3, x1);
    const scale = typeof e.args[3] === 'number' ? e.args[3] : 1;
    const sy = e.type === 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM' && typeof e.args[5] === 'number' ? e.args[5] : scale;
    const sz = e.type === 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM' && typeof e.args[6] === 'number' ? e.args[6] : scale;
    const o = this.point3(e.args[2]);
    return Float64Array.of(x[0] * scale, x[1] * scale, x[2] * scale, 0, y[0] * sy, y[1] * sy, y[2] * sy, 0, z[0] * sz, z[1] * sz, z[2] * sz, 0, o[0], o[1], o[2], 1);
  }

  // --- styles, layers, materials, storeys

  private styleFrom(styles: StepValue[]): Style {
    for (const value of styles) {
      const s = this.entity(value);
      if (!s) continue;
      if (s.type === 'IFCPRESENTATIONSTYLEASSIGNMENT') {
        const inner = this.styleFrom(this.list(s.args[0]));
        if (inner.color) return inner;
      } else if (s.type === 'IFCSURFACESTYLE') {
        for (const element of this.list(s.args[2])) {
          const r = this.entity(element);
          if (!r || (r.type !== 'IFCSURFACESTYLERENDERING' && r.type !== 'IFCSURFACESTYLESHADING')) continue;
          const colour = this.entity(r.args[0]);
          if (!colour || colour.type !== 'IFCCOLOURRGB') continue;
          const transparency = this.num(r.args[1], 0);
          return {
            color: [this.num(colour.args[1]), this.num(colour.args[2]), this.num(colour.args[3])],
            opacity: Math.min(1, Math.max(0.05, 1 - transparency)),
          };
        }
      }
    }
    return NO_STYLE;
  }

  private indexStyles(): void {
    for (const id of this.ids('IFCSTYLEDITEM')) {
      const e = this.entities.get(id)!;
      if (!(e.args[0] instanceof Ref)) continue;
      const style = this.styleFrom(this.list(e.args[1]));
      if (style.color) this.itemStyles.set(e.args[0].id, style);
    }
    for (const id of this.ids('IFCMATERIALDEFINITIONREPRESENTATION')) {
      const e = this.entities.get(id)!;
      if (!(e.args[3] instanceof Ref)) continue;
      for (const rep of this.list(e.args[2])) {
        for (const item of this.list(this.entity(rep)?.args[3])) {
          const styled = this.entity(item);
          if (styled?.type !== 'IFCSTYLEDITEM') continue;
          const style = this.styleFrom(this.list(styled.args[1]));
          if (style.color) this.materialStyles.set(e.args[3].id, style);
        }
      }
    }
    for (const type of ['IFCPRESENTATIONLAYERASSIGNMENT', 'IFCPRESENTATIONLAYERWITHSTYLE']) {
      for (const id of this.ids(type)) {
        const e = this.entities.get(id)!;
        const layerName = this.text(e.args[0]).trim();
        for (const item of this.list(e.args[2])) if (item instanceof Ref) this.layers.set(item.id, layerName);
      }
    }
  }

  private indexRelations(): void {
    for (const id of this.ids('IFCRELASSOCIATESMATERIAL')) {
      const e = this.entities.get(id)!;
      if (!(e.args[5] instanceof Ref)) continue;
      for (const object of this.list(e.args[4])) if (object instanceof Ref) this.materialOf.set(object.id, e.args[5].id);
    }
    for (const id of this.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
      const e = this.entities.get(id)!;
      if (!(e.args[5] instanceof Ref)) continue;
      for (const object of this.list(e.args[4])) if (object instanceof Ref) this.storeyOf.set(object.id, e.args[5].id);
    }
    for (const type of ['IFCRELAGGREGATES', 'IFCRELNESTS']) {
      for (const id of this.ids(type)) {
        const e = this.entities.get(id)!;
        if (!(e.args[4] instanceof Ref)) continue;
        for (const object of this.list(e.args[5])) if (object instanceof Ref) this.parentOf.set(object.id, e.args[4].id);
      }
    }
    for (const id of this.ids('IFCRELDEFINESBYTYPE')) {
      const e = this.entities.get(id)!;
      if (!(e.args[5] instanceof Ref)) continue;
      for (const object of this.list(e.args[4])) if (object instanceof Ref) this.typeOf.set(object.id, e.args[5].id);
    }
  }

  /** The material entity that best describes what an element is made of. */
  private materialEntity(id: number | undefined, depth = 0): StepEntity | null {
    const e = id === undefined ? null : (this.entities.get(id) ?? null);
    if (!e || depth > 6) return null;
    switch (e.type) {
      case 'IFCMATERIAL':
        return e;
      case 'IFCMATERIALLAYERSETUSAGE':
      case 'IFCMATERIALPROFILESETUSAGE':
      case 'IFCMATERIALPROFILESETUSAGETAPERING':
        return e.args[0] instanceof Ref ? this.materialEntity(e.args[0].id, depth + 1) : null;
      case 'IFCMATERIALLAYERSET': {
        // The thickest layer says most about the look of a wall or slab.
        let best: StepEntity | null = null;
        let thickness = -1;
        for (const layer of this.list(e.args[0])) {
          const l = this.entity(layer);
          if (!l) continue;
          const t = this.num(l.args[1]);
          if (t > thickness && l.args[0] instanceof Ref) {
            thickness = t;
            best = this.materialEntity(l.args[0].id, depth + 1);
          }
        }
        return best;
      }
      case 'IFCMATERIALLAYER':
        return e.args[0] instanceof Ref ? this.materialEntity(e.args[0].id, depth + 1) : null;
      case 'IFCMATERIALLIST': {
        const first = this.list(e.args[0])[0];
        return first instanceof Ref ? this.materialEntity(first.id, depth + 1) : null;
      }
      case 'IFCMATERIALCONSTITUENTSET': {
        const first = this.list(e.args[2])[0];
        const c = this.entity(first);
        return c?.args[2] instanceof Ref ? this.materialEntity(c.args[2].id, depth + 1) : null;
      }
      case 'IFCMATERIALPROFILESET': {
        const first = this.list(e.args[2])[0];
        const p = this.entity(first);
        return p?.args[2] instanceof Ref ? this.materialEntity(p.args[2].id, depth + 1) : null;
      }
      default:
        return null;
    }
  }

  private storeyFor(id: number): { name: string; elevation: number | null } | null {
    let current: number | undefined = id;
    for (let depth = 0; current !== undefined && depth < 16; depth++) {
      const structure = this.storeyOf.get(current);
      if (structure !== undefined) {
        let s = this.entities.get(structure);
        // A space or zone inside a storey: walk up to the storey.
        for (let up = 0; s && s.type !== 'IFCBUILDINGSTOREY' && up < 4; up++) s = this.entities.get(this.parentOf.get(s.id) ?? -1);
        if (!s || s.type !== 'IFCBUILDINGSTOREY') return null;
        const elevation = typeof s.args[9] === 'number' ? s.args[9] * this.unit : null;
        return { name: this.text(s.args[2]).trim() || this.text(s.args[7]).trim(), elevation };
      }
      current = this.parentOf.get(current);
    }
    return null;
  }

  // --- profiles (2D, metres)

  private curvePoints(value: StepValue | undefined, depth = 0): Vec2[] {
    const e = this.entity(value);
    if (!e || depth > 8) return [];
    switch (e.type) {
      case 'IFCPOLYLINE':
        return this.list(e.args[0]).map((p) => this.point2(p));
      case 'IFCINDEXEDPOLYCURVE': {
        const list = this.entity(e.args[0]);
        const coords = this.list(list?.args[0]).map((c) => {
          const xy = this.list(c);
          return [this.num(xy[0]) * this.unit, this.num(xy[1]) * this.unit] as Vec2;
        });
        const segments = this.list(e.args[1]);
        if (segments.length === 0) return coords;
        const out: Vec2[] = [];
        for (const segment of segments) {
          if (!(segment instanceof Typed)) continue;
          const indices = this.list(segment.value).map((i) => this.num(i) - 1);
          const points = indices.map((i) => coords[i]).filter((p): p is Vec2 => Boolean(p));
          const run = segment.type === 'IFCARCINDEX' && points.length === 3 ? arcThrough(points[0]!, points[1]!, points[2]!) : points;
          for (const p of run) {
            const last = out[out.length - 1];
            if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
          }
        }
        return out;
      }
      case 'IFCCOMPOSITECURVE': {
        const out: Vec2[] = [];
        for (const segmentRef of this.list(e.args[0])) {
          const segment = this.entity(segmentRef);
          if (!segment) continue;
          let points = this.curvePoints(segment.args[2], depth + 1);
          if (segment.args[1] instanceof Enum && segment.args[1].value === 'F') points = [...points].reverse();
          for (const p of points) {
            const last = out[out.length - 1];
            if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
          }
        }
        return out;
      }
      case 'IFCTRIMMEDCURVE': {
        const basisCurve = this.entity(e.args[0]);
        const trimPoint = (trim: StepValue | undefined): Vec2 | null => {
          for (const t of this.list(trim)) {
            const p = this.entity(t);
            if (p?.type === 'IFCCARTESIANPOINT') return this.point2(t);
          }
          return null;
        };
        const trimParam = (trim: StepValue | undefined): number | null => {
          for (const t of this.list(trim)) {
            if (t instanceof Typed && t.type === 'IFCPARAMETERVALUE') return this.num(t.value);
            if (typeof t === 'number') return t;
          }
          return null;
        };
        const sense = !(e.args[3] instanceof Enum && e.args[3].value === 'F');
        if (basisCurve?.type === 'IFCCIRCLE') {
          const m = this.axis3(basisCurve.args[0]);
          const r = this.num(basisCurve.args[1]) * this.unit;
          const center: Vec2 = [m[12]!, m[13]!];
          const rot = Math.atan2(m[1]!, m[0]!);
          const angleOf = (trim: StepValue | undefined): number => {
            const p = trimPoint(trim);
            if (p) return Math.atan2(p[1] - center[1], p[0] - center[0]);
            const param = trimParam(trim);
            // Parameters of a circle are angles in the model's angle unit; nearly always degrees or radians.
            return rot + (param === null ? 0 : Math.abs(param) > 2 * Math.PI + 1e-6 ? (param * Math.PI) / 180 : param);
          };
          let a0 = angleOf(e.args[1]);
          let a1 = angleOf(e.args[2]);
          if (sense) {
            while (a1 <= a0) a1 += 2 * Math.PI;
          } else {
            while (a1 >= a0) a1 -= 2 * Math.PI;
          }
          const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)));
          const out: Vec2[] = [];
          for (let i = 0; i <= steps; i++) {
            const a = a0 + ((a1 - a0) * i) / steps;
            out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
          }
          return out;
        }
        const p0 = trimPoint(e.args[1]);
        const p1 = trimPoint(e.args[2]);
        return p0 && p1 ? (sense ? [p0, p1] : [p1, p0]) : [];
      }
      default:
        this.skip(e.type);
        return [];
    }
  }

  /** Outer loop and holes of a profile, in the profile's placement. */
  private profile(value: StepValue | undefined): { outer: Vec2[]; holes: Vec2[][] } | null {
    const e = this.entity(value);
    if (!e) return null;
    const placed = (points: Vec2[], position: StepValue | undefined): Vec2[] => {
      const m = this.axis3(position);
      return points.map(([x, y]) => [m[0]! * x + m[4]! * y + m[12]!, m[1]! * x + m[5]! * y + m[13]!]);
    };
    const rect = (w: number, h: number): Vec2[] => [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ];
    const circle = (r: number): Vec2[] => Array.from({ length: 24 }, (_, i) => [r * Math.cos((i * Math.PI) / 12), r * Math.sin((i * Math.PI) / 12)] as Vec2);
    const u = this.unit;
    switch (e.type) {
      case 'IFCRECTANGLEPROFILEDEF':
      case 'IFCROUNDEDRECTANGLEPROFILEDEF':
        return { outer: placed(rect(this.num(e.args[3]) * u, this.num(e.args[4]) * u), e.args[2]), holes: [] };
      case 'IFCRECTANGLEHOLLOWPROFILEDEF': {
        const w = this.num(e.args[3]) * u;
        const h = this.num(e.args[4]) * u;
        const t = this.num(e.args[5]) * u;
        return { outer: placed(rect(w, h), e.args[2]), holes: t > 0 && t * 2 < Math.min(w, h) ? [placed(rect(w - 2 * t, h - 2 * t), e.args[2])] : [] };
      }
      case 'IFCCIRCLEPROFILEDEF':
        return { outer: placed(circle(this.num(e.args[3]) * u), e.args[2]), holes: [] };
      case 'IFCCIRCLEHOLLOWPROFILEDEF': {
        const r = this.num(e.args[3]) * u;
        const t = this.num(e.args[4]) * u;
        return { outer: placed(circle(r), e.args[2]), holes: t > 0 && t < r ? [placed(circle(r - t), e.args[2])] : [] };
      }
      case 'IFCELLIPSEPROFILEDEF': {
        const a = this.num(e.args[3]) * u;
        const b = this.num(e.args[4]) * u;
        return { outer: placed(Array.from({ length: 24 }, (_, i) => [a * Math.cos((i * Math.PI) / 12), b * Math.sin((i * Math.PI) / 12)] as Vec2), e.args[2]), holes: [] };
      }
      case 'IFCISHAPEPROFILEDEF': {
        const w = this.num(e.args[3]) * u;
        const d = this.num(e.args[4]) * u;
        const tw = this.num(e.args[5]) * u;
        const tf = this.num(e.args[6]) * u;
        const shape: Vec2[] = [
          [-w / 2, -d / 2],
          [w / 2, -d / 2],
          [w / 2, -d / 2 + tf],
          [tw / 2, -d / 2 + tf],
          [tw / 2, d / 2 - tf],
          [w / 2, d / 2 - tf],
          [w / 2, d / 2],
          [-w / 2, d / 2],
          [-w / 2, d / 2 - tf],
          [-tw / 2, d / 2 - tf],
          [-tw / 2, -d / 2 + tf],
          [-w / 2, -d / 2 + tf],
        ];
        return { outer: placed(shape, e.args[2]), holes: [] };
      }
      case 'IFCLSHAPEPROFILEDEF':
      case 'IFCTSHAPEPROFILEDEF':
      case 'IFCUSHAPEPROFILEDEF':
      case 'IFCCSHAPEPROFILEDEF':
      case 'IFCZSHAPEPROFILEDEF': {
        // Shown as their outline box: close enough at house scale.
        const depth = this.num(e.args[3]) * u;
        const width = this.num(e.args[4], this.num(e.args[3])) * u;
        return { outer: placed(rect(width, depth), e.args[2]), holes: [] };
      }
      case 'IFCARBITRARYCLOSEDPROFILEDEF':
        return { outer: this.curvePoints(e.args[2]), holes: [] };
      case 'IFCARBITRARYPROFILEDEFWITHVOIDS':
        return { outer: this.curvePoints(e.args[2]), holes: this.list(e.args[3]).map((c) => this.curvePoints(c)) };
      case 'IFCDERIVEDPROFILEDEF': {
        const parent = this.profile(e.args[2]);
        if (!parent) return null;
        const op = this.entity(e.args[3]);
        const origin = op ? this.point2(op.args[2]) : ([0, 0] as Vec2);
        const axis = op ? this.direction(op.args[0]) : null;
        const angle = axis ? Math.atan2(axis[1], axis[0]) : 0;
        const scale = op && typeof op.args[3] === 'number' ? op.args[3] : 1;
        const map = (p: Vec2): Vec2 => [origin[0] + scale * (p[0] * Math.cos(angle) - p[1] * Math.sin(angle)), origin[1] + scale * (p[0] * Math.sin(angle) + p[1] * Math.cos(angle))];
        return { outer: parent.outer.map(map), holes: parent.holes.map((h) => h.map(map)) };
      }
      default:
        this.skip(e.type);
        return null;
    }
  }

  // --- geometry items

  private loop(bound: StepEntity | null, mesh: MeshBuilder, m: Mat4, cache: Map<number, number>): number[] {
    const polyloop = bound ? this.entity(bound.args[0]) : null;
    if (!polyloop || polyloop.type !== 'IFCPOLYLOOP') {
      if (polyloop) this.skip(polyloop.type);
      return [];
    }
    const indices: number[] = [];
    for (const p of this.list(polyloop.args[0])) {
      if (!(p instanceof Ref)) continue;
      let index = cache.get(p.id);
      if (index === undefined) {
        index = mesh.vertex(apply(m, this.point3(p)));
        cache.set(p.id, index);
      }
      if (indices[indices.length - 1] !== index) indices.push(index);
    }
    if (indices.length > 1 && indices[0] === indices[indices.length - 1]) indices.pop();
    if (bound!.args[1] instanceof Enum && bound!.args[1].value === 'F') indices.reverse();
    return indices;
  }

  private faces(faceRefs: StepValue[], mesh: MeshBuilder, m: Mat4, cache: Map<number, number>): void {
    for (const ref of faceRefs) {
      const face = this.entity(ref);
      if (!face) continue;
      const bounds = this.list(face.args[0]).map((b) => this.entity(b)).filter((b): b is StepEntity => b !== null);
      const outer = bounds.find((b) => b.type === 'IFCFACEOUTERBOUND') ?? bounds[0];
      if (!outer) continue;
      const loops = [this.loop(outer, mesh, m, cache), ...bounds.filter((b) => b !== outer).map((b) => this.loop(b, mesh, m, cache))];
      mesh.face(loops.filter((l, i) => i === 0 || l.length >= 3));
    }
  }

  private extrusion(e: StepEntity, mesh: MeshBuilder, m: Mat4): void {
    const profile = this.profile(e.args[0]);
    if (!profile || profile.outer.length < 3) return;
    const depth = this.num(e.args[3]) * this.unit;
    const dir = normalize(this.direction(e.args[2]) ?? [0, 0, 1], [0, 0, 1]);
    const local = multiply(m, this.axis3(e.args[1]));
    const fix = (points: Vec2[], ccw: boolean): Vec2[] => {
      const clean = points.filter((p, i) => {
        const q = points[(i + 1) % points.length]!;
        return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9;
      });
      return signedArea2(clean) > 0 === ccw ? clean : [...clean].reverse();
    };
    const outer = fix(profile.outer, true);
    const holes = profile.holes.map((h) => fix(h, false)).filter((h) => h.length >= 3);
    const start = mesh.indices.length;
    const loops = [outer, ...holes];
    const bottom = loops.map((loop) => loop.map(([x, y]) => mesh.vertex(apply(local, [x, y, 0]))));
    const top = loops.map((loop) => loop.map(([x, y]) => mesh.vertex(apply(local, [x + dir[0] * depth, y + dir[1] * depth, dir[2] * depth]))));
    mesh.face(bottom.map((loop) => [...loop].reverse()));
    mesh.face(top);
    for (let l = 0; l < loops.length; l++) {
      const b = bottom[l]!;
      const t = top[l]!;
      for (let i = 0; i < b.length; i++) {
        const j = (i + 1) % b.length;
        mesh.face([[b[i]!, b[j]!, t[j]!, t[i]!]]);
      }
    }
    mesh.orientOutwards(start);
  }

  private block(e: StepEntity, mesh: MeshBuilder, m: Mat4): void {
    const local = multiply(m, this.axis3(e.args[0]));
    const [x, y, z] = [this.num(e.args[1]) * this.unit, this.num(e.args[2]) * this.unit, this.num(e.args[3]) * this.unit];
    const v = [
      [0, 0, 0],
      [x, 0, 0],
      [x, y, 0],
      [0, y, 0],
      [0, 0, z],
      [x, 0, z],
      [x, y, z],
      [0, y, z],
    ].map((p) => mesh.vertex(apply(local, p as Vec3)));
    const start = mesh.indices.length;
    for (const f of [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ]) {
      mesh.face([f.map((i) => v[i]!)]);
    }
    mesh.orientOutwards(start);
  }

  private faceSet(e: StepEntity, mesh: MeshBuilder, m: Mat4): void {
    const list = this.entity(e.args[0]);
    const coords = this.list(list?.args[0]);
    const base = mesh.positions.length / 3;
    for (const c of coords) {
      const xyz = this.list(c);
      mesh.vertex(apply(m, [this.num(xyz[0]) * this.unit, this.num(xyz[1]) * this.unit, this.num(xyz[2]) * this.unit]));
    }
    const start = mesh.indices.length;
    const count = coords.length;
    const valid = (i: number) => i >= 0 && i < count;
    if (e.type === 'IFCTRIANGULATEDFACESET' || e.type === 'IFCTRIANGULATEDIRREGULARNETWORK') {
      for (const tri of this.list(e.args[3])) {
        const idx = this.list(tri).map((i) => this.num(i) - 1);
        if (idx.length === 3 && idx.every(valid)) mesh.indices.push(base + idx[0]!, base + idx[1]!, base + idx[2]!);
      }
    } else {
      for (const faceRef of this.list(e.args[2])) {
        const face = this.entity(faceRef);
        if (!face) continue;
        const outer = this.list(face.args[0]).map((i) => this.num(i) - 1);
        const inner = face.type === 'IFCINDEXEDPOLYGONALFACEWITHVOIDS' ? this.list(face.args[1]).map((l) => this.list(l).map((i) => this.num(i) - 1)) : [];
        const loops = [outer, ...inner].filter((l) => l.length >= 3 && l.every(valid)).map((l) => l.map((i) => base + i));
        if (loops.length > 0) mesh.face(loops);
      }
    }
    if (e.args[2] instanceof Enum && e.args[2].value === 'T' && e.type === 'IFCTRIANGULATEDFACESET') mesh.orientOutwards(start);
    if (e.type === 'IFCPOLYGONALFACESET' && e.args[1] instanceof Enum && e.args[1].value === 'T') mesh.orientOutwards(start);
  }

  /** Adds one representation item (what cannot be shown is counted in `skipped`). */
  private item(value: StepValue | undefined, m: Mat4, out: (style: Style) => MeshBuilder, inherited: Style, depth = 0): void {
    const e = this.entity(value);
    if (!e || depth > 12) return;
    const style = this.itemStyles.get(e.id) ?? inherited;
    switch (e.type) {
      case 'IFCFACETEDBREP':
      case 'IFCFACETEDBREPWITHVOIDS': {
        const mesh = out(style);
        const start = mesh.indices.length;
        const cache = new Map<number, number>();
        const shells = [e.args[0], ...(e.type === 'IFCFACETEDBREPWITHVOIDS' ? this.list(e.args[1]) : [])];
        shells.forEach((shellRef) => {
          const shell = this.entity(shellRef);
          if (shell) this.faces(this.list(shell.args[0]), mesh, m, cache);
        });
        mesh.orientOutwards(start);
        return;
      }
      case 'IFCSHELLBASEDSURFACEMODEL':
        for (const shellRef of this.list(e.args[0])) {
          const shell = this.entity(shellRef);
          if (shell) this.faces(this.list(shell.args[0]), out(style), m, new Map());
        }
        return;
      case 'IFCFACEBASEDSURFACEMODEL':
        for (const setRef of this.list(e.args[0])) {
          const set = this.entity(setRef);
          if (set) this.faces(this.list(set.args[0]), out(style), m, new Map());
        }
        return;
      case 'IFCCLOSEDSHELL':
      case 'IFCOPENSHELL':
      case 'IFCCONNECTEDFACESET':
        this.faces(this.list(e.args[0]), out(style), m, new Map());
        return;
      case 'IFCTRIANGULATEDFACESET':
      case 'IFCTRIANGULATEDIRREGULARNETWORK':
      case 'IFCPOLYGONALFACESET':
        this.faceSet(e, out(style), m);
        return;
      case 'IFCEXTRUDEDAREASOLID':
      case 'IFCEXTRUDEDAREASOLIDTAPERED':
        this.extrusion(e, out(style), m);
        return;
      case 'IFCBLOCK':
        this.block(e, out(style), m);
        return;
      case 'IFCBOOLEANRESULT':
      case 'IFCBOOLEANCLIPPINGRESULT': {
        const operator = e.args[0] instanceof Enum ? e.args[0].value : '';
        this.simplified++;
        this.item(e.args[1], m, out, style, depth + 1);
        if (operator === 'UNION') this.item(e.args[2], m, out, style, depth + 1);
        return;
      }
      case 'IFCMAPPEDITEM': {
        const source = this.entity(e.args[0]);
        const representation = this.entity(source?.args[1]);
        if (!source || !representation) return;
        const mm = multiply(multiply(m, this.operator(e.args[1])), this.axis3(source.args[0]));
        for (const inner of this.list(representation.args[3])) this.item(inner, mm, out, style, depth + 1);
        return;
      }
      default:
        this.skip(e.type);
    }
  }

  // --- orientation and position of the site

  private trueNorth(): number {
    for (const id of this.ids('IFCGEOMETRICREPRESENTATIONCONTEXT')) {
      const e = this.entities.get(id)!;
      const north = this.entity(e.args[5]);
      if (!north) continue;
      const c = this.list(north.args[0]);
      const x = this.num(c[0]);
      const y = this.num(c[1]);
      if (Math.hypot(x, y) < 1e-9) continue;
      return Math.round(((Math.atan2(x, y) * 180) / Math.PI) * 100) / 100;
    }
    return 0;
  }

  private location(): { latitude: number; longitude: number } | null {
    const site = this.ids('IFCSITE')[0];
    if (site === undefined) return null;
    const e = this.entities.get(site)!;
    const angle = (value: StepValue | undefined): number | null => {
      const parts = this.list(value).map((v) => this.num(v));
      if (parts.length < 2) return null;
      const [d = 0, m = 0, s = 0, micro = 0] = parts;
      return d + m / 60 + s / 3600 + micro / 3.6e9;
    };
    const latitude = angle(e.args[9]);
    const longitude = angle(e.args[10]);
    if (latitude === null || longitude === null || (latitude === 0 && longitude === 0)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude: Math.round(latitude * 1e5) / 1e5, longitude: Math.round(longitude * 1e5) / 1e5 };
  }

  // --- products

  private bodyRepresentations(shape: StepEntity): StepEntity[] {
    const reps = this.list(shape.args[2])
      .map((r) => this.entity(r))
      .filter((r): r is StepEntity => r !== null);
    const body = reps.filter((r) => this.text(r.args[1]).toLowerCase() === 'body');
    if (body.length > 0) return body;
    return reps.filter((r) => !['axis', 'footprint', 'box', 'annotation', 'profile', 'surface', 'curve', 'clearance', 'lighting'].includes(this.text(r.args[1]).toLowerCase()));
  }

  read(): IfcReadResult {
    const elements: IfcElement[] = [];
    for (const e of this.entities.values()) {
      if (e.args.length < 7 || NOT_SHOWN.has(e.type)) continue;
      const placementRef = e.args[5];
      const shape = this.entity(e.args[6]);
      if (!(placementRef instanceof Ref) || !shape || shape.type !== 'IFCPRODUCTDEFINITIONSHAPE') continue;
      const placement = this.entity(placementRef);
      if (!placement || (placement.type !== 'IFCLOCALPLACEMENT' && placement.type !== 'IFCGRIDPLACEMENT')) continue;

      const m = this.placement(placementRef);
      const materialEntity = this.materialEntity(this.materialOf.get(e.id) ?? this.materialOf.get(this.typeOf.get(e.id) ?? -1));
      const fallback = (materialEntity && this.materialStyles.get(materialEntity.id)) || NO_STYLE;
      const builders = new Map<string, { style: Style; mesh: MeshBuilder }>();
      const out = (style: Style) => {
        const key = style.color ? `${style.color.join(',')}/${style.opacity}` : 'none';
        let entry = builders.get(key);
        if (!entry) builders.set(key, (entry = { style, mesh: new MeshBuilder() }));
        return entry.mesh;
      };
      let layer: string | null = null;
      for (const rep of this.bodyRepresentations(shape)) {
        layer ??= this.layers.get(rep.id) ?? null;
        for (const item of this.list(rep.args[3])) {
          if (item instanceof Ref) layer ??= this.layers.get(item.id) ?? null;
          this.item(item, m, out, this.itemStyles.get(rep.id) ?? fallback);
        }
      }
      const pieces = [...builders.values()]
        .filter((b) => b.mesh.indices.length > 0)
        .map((b) => ({ color: b.style.color, opacity: b.style.opacity, positions: b.mesh.positions, indices: b.mesh.indices }));
      if (pieces.length === 0) continue;
      elements.push({
        id: e.id,
        type: e.type,
        name: this.text(e.args[2]).trim() || this.text(e.args[4]).trim(),
        material: materialEntity ? this.text(materialEntity.args[0]).trim() || null : null,
        layer: layer && layer.length > 0 ? layer : null,
        storey: this.storeyFor(e.id),
        pieces,
      });
    }
    const project = this.ids('IFCPROJECT')[0];
    const projectEntity = project === undefined ? null : this.entities.get(project)!;
    return {
      schema: this.file.schema,
      application: this.file.application,
      projectName: projectEntity ? this.text(projectEntity.args[2]).trim() || this.text(projectEntity.args[5]).trim() : '',
      trueNorthDeg: this.trueNorth(),
      location: this.location(),
      elements,
      skipped: this.skipped,
      simplified: this.simplified,
    };
  }
}

/** Circle arc through three points (IFC4 IfcArcIndex), sampled every 15°. */
function arcThrough(a: Vec2, b: Vec2, c: Vec2): Vec2[] {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return [a, b, c];
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - ux, a[1] - uy);
  const angle = (p: Vec2) => Math.atan2(p[1] - uy, p[0] - ux);
  const a0 = angle(a);
  let a1 = angle(b);
  let a2 = angle(c);
  // Go the way that passes the middle point.
  const ccw = (a1 - a0 + 4 * Math.PI) % (2 * Math.PI) < (a2 - a0 + 4 * Math.PI) % (2 * Math.PI);
  if (ccw) {
    while (a2 < a0) a2 += 2 * Math.PI;
  } else {
    while (a2 > a0) a2 -= 2 * Math.PI;
  }
  a1 = a2;
  const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / steps;
    return [ux + r * Math.cos(t), uy + r * Math.sin(t)] as Vec2;
  });
}

export function readIfc(file: StepFile): IfcReadResult {
  return new IfcReader(file).read();
}
