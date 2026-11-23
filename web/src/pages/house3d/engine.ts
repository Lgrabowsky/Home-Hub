import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PointLight,
  Raycaster,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
} from 'three';
import type { House3DLevel, House3DView } from '@home-hub/shared';
import type { ParsedModel } from './data.ts';
import { daylight, sunPosition } from '@home-hub/shared';

/**
 * The 3D house: WebGL scene, daylight, how the house opens, and the gestures.
 *
 * Model coordinates are metres, Z up, ground at 0 (as the hub writes them).
 * The scene is Y up; the model sits in a group turned by −90° about X, so a
 * model point (x, y, z) is the world point (x, z, −y).
 *
 * Zooming is semantic, like in the design: from the whole house (k = 1) the
 * roof lifts and the storeys move apart, cut open at sill height (k ≈ 1.6);
 * further in one storey stays and the others float away (k ≈ 2.6); beyond
 * that the zoom is free, down to a metre in front of a wall.
 */

export type ViewMode = 'overview' | 'open' | 'floor';

export interface EngineStatus {
  mode: ViewMode;
  /** The storey that is opened (index into the model's levels). */
  level: number;
  /** Zoom factor (1 = whole house). */
  zoom: number;
  night: boolean;
}

export interface PickResult {
  level: number;
  /** IFC-independent model coordinates (metres, Z up, ground 0) of the tapped point. */
  point: [number, number, number];
}

export interface Lamp {
  id: string;
  position: [number, number, number];
  level: number;
  /** 0 = off … 1 = full. */
  brightness: number;
}

interface Callbacks {
  onStatus(status: EngineStatus): void;
  onTap(hit: PickResult | null): void;
}

interface LevelRuntime {
  info: House3DLevel;
  group: Group;
  meshes: Mesh[];
  materials: MeshStandardMaterial[];
  glass: MeshStandardMaterial[];
  plane: Plane;
  /** Height step when the house opens (storeys above the ground floor). */
  rank: number;
  center: Vector3;
  // Smoothed state, chased towards the targets every frame.
  lift: number;
  clip: number;
  opacity: number;
}

interface Overlay {
  el: HTMLElement;
  position: Vector3;
  level: number;
  kind: 'marker' | 'tag';
}

const DEG = Math.PI / 180;
const ANCHORS = [1, 1.6, 2.6];
const PHI_MIN = 12;
const PHI_MAX = 80;
const ROT_PER_PX = 0.42;
const TILT_PER_PX = 0.24;
const GAP = 1.8;
const LIFT = 7;
const FOV = 35;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function normDeg(a: number): number {
  return ((((a % 360) + 540) % 360) - 180);
}

function radialTexture(stops: [number, string][]): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
}

interface Tween {
  from: { dist: number; theta: number; phi: number; pan: Vector3 };
  to: { dist: number; theta: number; phi: number; pan: Vector3 };
  start: number;
  duration: number;
}

interface Gesture {
  x: number;
  y: number;
  ax: number;
  ay: number;
  mode: null | 'rot' | 'tilt' | 'free' | 'pan';
  rawPhi: number;
  samples: { t: number; theta: number }[];
}

interface Pinch {
  dist: number;
  startDist: number;
  angle: number;
  theta: number;
  twist: boolean;
  mid: Vector2;
}

export class HouseEngine {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 1000);
  private readonly root = new Group();
  private readonly sun = new DirectionalLight(0xffffff, 3);
  private readonly hemi = new HemisphereLight(0xdfeaff, 0x8a7a5c, 1);
  private readonly lampLights: PointLight[] = [];
  private readonly glowTexture = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(255,240,210,0.55)'],
    [1, 'rgba(255,220,170,0)'],
  ]);
  private readonly raycaster = new Raycaster();
  private ground: Mesh | null = null;
  private levels: LevelRuntime[] = [];
  private lampSprites = new Map<string, { sprite: Sprite; lamp: Lamp }>();
  private overlays = new Map<string, Overlay>();
  private compass: HTMLElement | null = null;

  // Camera rig (world, Y up). theta/phi in radians, phi measured from straight down.
  private theta = -32 * DEG;
  private phi = 55 * DEG;
  private dist = 50;
  private readonly pan = new Vector3();
  private d0 = 50;
  private radius = 15;
  private readonly center = new Vector3();
  private cur = 0;

  // View settings.
  private northDeg = 0;
  private latitude = 51.16;
  private longitude = 10.45;
  private time: Date | null = null;
  private night = 0;
  private colors: Record<string, string> = {};

  // Interaction.
  private readonly pointers = new Map<number, { x: number; y: number; button: number; type: string }>();
  private gesture: Gesture | null = null;
  private pinch: Pinch | null = null;
  private spin = 0;
  private tween: Tween | null = null;
  private moved = false;
  private live = false;
  private wheelTimer = 0;

  private raf = 0;
  private lastFrame = 0;
  private dirty = true;
  private disposed = false;
  private status: EngineStatus = { mode: 'overview', level: 0, zoom: 1, night: false };
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly canvasHost: HTMLElement,
    private readonly callbacks: Callbacks,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    canvasHost.appendChild(this.renderer.domElement);

    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    // Shadows as outdoors: the sky still lights what the sun does not reach.
    this.sun.shadow.intensity = 0.78;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    for (let i = 0; i < 4; i++) {
      const light = new PointLight(0xffc98a, 0, 7, 2);
      this.lampLights.push(light);
      this.scene.add(light);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    container.addEventListener('pointerdown', this.onPointerDown);
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerup', this.onPointerUp);
    container.addEventListener('pointercancel', this.onPointerUp);
    container.addEventListener('wheel', this.onWheel, { passive: false });
    container.addEventListener('keydown', this.onKey);
    container.addEventListener('click', this.onClickCapture, true);
    container.addEventListener('contextmenu', this.onContextMenu);
    this.resize();
  }

  // --- model --------------------------------------------------------------------------------

  setModel(model: ParsedModel, view: House3DView): void {
    this.clearModel();
    const { info } = model;
    this.levels = info.levels.map((level) => {
      const group = new Group();
      this.root.add(group);
      return { info: level, group, meshes: [], materials: [], glass: [], plane: new Plane(new Vector3(0, -1, 0), 1e6), rank: 0, center: new Vector3(), lift: 0, clip: 0, opacity: 1 };
    });

    // Storeys above the ground floor move apart when the house opens.
    const storeys = this.levels.filter((l) => l.info.kind === 'storey');
    const groundIndex = Math.max(0, storeys.findIndex((l) => l.info.floorZ >= -0.6));
    storeys.forEach((l, i) => (l.rank = Math.max(0, i - groundIndex)));
    const roof = this.levels.find((l) => l.info.kind === 'roof');
    if (roof) roof.rank = storeys.length - groundIndex + 1.5;
    this.cur = this.levels.indexOf(storeys[groundIndex] ?? this.levels[0]!);

    const materialInfo = new Map(info.materials.map((m) => [m.key, m]));
    for (const g of model.groups) {
      const level = this.levels[g.level];
      if (!level) continue;
      const positions = new Float32Array(model.buffer, model.dataOffset + g.positionOffset, g.vertexCount * 3);
      const indices = new Uint32Array(model.buffer, model.dataOffset + g.indexOffset, g.indexCount);
      const indexed = new BufferGeometry();
      indexed.setAttribute('position', new BufferAttribute(positions, 3));
      indexed.setIndex(new BufferAttribute(indices, 1));
      // Separate corners per triangle: crisp faces and correct normals for light and shadow.
      const geometry = indexed.toNonIndexed();
      indexed.dispose();
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mat = materialInfo.get(g.material);
      const glass = (mat?.opacity ?? 1) < 0.95;
      const material = new MeshStandardMaterial({
        color: new Color(this.colorFor(g.material, mat?.color ?? '#cccccc')),
        roughness: glass ? 0.15 : g.material === 'stahl' || g.material === 'dach' ? 0.55 : 0.88,
        metalness: g.material === 'stahl' ? 0.35 : 0,
        side: DoubleSide,
        shadowSide: BackSide,
        transparent: glass,
        opacity: glass ? (mat?.opacity ?? 0.35) : 1,
        depthWrite: !glass,
        clippingPlanes: [level.plane],
        clipShadows: true,
      });
      material.userData = { key: g.material, glass, baseOpacity: material.opacity, defaultColor: mat?.color ?? '#cccccc' };
      if (!glass) this.addSectionCaps(material);
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = !glass;
      mesh.receiveShadow = !glass;
      mesh.userData = { level: g.level };
      level.group.add(mesh);
      level.meshes.push(mesh);
      level.materials.push(material);
      if (glass) level.glass.push(material);
    }
    for (const level of this.levels) {
      const first = level.meshes[0]?.geometry.boundingBox;
      if (first) {
        const box = first.clone();
        for (const mesh of level.meshes) box.union(mesh.geometry.boundingBox!);
        const c = box.getCenter(new Vector3());
        level.center.set(c.x, c.z, -c.y);
      }
    }

    // Size of the scene, the ground and where the camera starts.
    const min = info.bounds.min;
    const max = info.bounds.max;
    this.radius = Math.max(4, 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - Math.max(min[2], -1)));
    this.center.set((min[0] + max[0]) / 2, (Math.max(min[2], 0) + max[2]) / 2, -(min[1] + max[1]) / 2);
    const ground = new Mesh(
      new CircleGeometry(this.radius * 3.2, 96),
      new MeshStandardMaterial({
        color: new Color('#7d9a58'),
        roughness: 1,
        transparent: true,
        depthWrite: false,
        alphaMap: radialTexture([
          [0, '#ffffff'],
          [0.55, '#ffffff'],
          [1, '#000000'],
        ]),
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.center.x, -0.01, this.center.z);
    ground.receiveShadow = true;
    ground.renderOrder = -1;
    this.ground = ground;
    this.scene.add(ground);

    this.applyView(view);
    this.fit();
    // A short sweep into the starting view, as in the design.
    this.dist = this.d0 * 1.25;
    this.theta = -78 * DEG;
    this.phi = 48 * DEG;
    this.flyTo({ dist: this.d0, theta: -32 * DEG, phi: 55 * DEG, pan: new Vector3() }, 1600);
    this.invalidate();
  }

  private clearModel(): void {
    for (const level of this.levels) {
      for (const mesh of level.meshes) mesh.geometry.dispose();
      for (const material of level.materials) material.dispose();
      this.root.remove(level.group);
    }
    for (const { sprite } of this.lampSprites.values()) sprite.material.dispose();
    this.lampSprites.clear();
    this.levels = [];
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      (this.ground.material as MeshStandardMaterial).alphaMap?.dispose();
      (this.ground.material as MeshStandardMaterial).dispose();
      this.ground = null;
    }
  }

  /** Back faces seen through a cut are drawn as a flat section surface. */
  private addSectionCaps(material: MeshStandardMaterial): void {
    const cap = { value: new Color(0x6b6259) };
    material.userData.cap = cap;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.capColor = cap;
      shader.fragmentShader = `uniform vec3 capColor;\n${shader.fragmentShader}`.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n\tif ( ! gl_FrontFacing ) gl_FragColor = vec4( capColor, gl_FragColor.a );',
      );
    };
  }

  private colorFor(key: string, fallback: string): string {
    const custom = this.colors[key];
    return custom && /^#[0-9a-f]{6}$/i.test(custom) ? custom : fallback;
  }

  applyView(view: House3DView): void {
    this.northDeg = view.northDeg;
    this.latitude = view.latitude;
    this.longitude = view.longitude;
    this.colors = view.colors;
    for (const level of this.levels) {
      for (const material of level.materials) {
        material.color.set(this.colorFor(material.userData.key as string, material.userData.defaultColor as string));
      }
    }
    this.updateSun();
    this.invalidate();
  }

  /** null = now (the light follows the clock). */
  setTime(time: Date | null): void {
    this.time = time;
    this.updateSun();
    this.invalidate();
  }

  setLamps(lamps: Lamp[]): void {
    const seen = new Set<string>();
    for (const lamp of lamps) {
      seen.add(lamp.id);
      const level = this.levels[lamp.level];
      if (!level) continue;
      let entry = this.lampSprites.get(lamp.id);
      if (!entry) {
        const sprite = new Sprite(new SpriteMaterial({ map: this.glowTexture, color: 0xffd9a0, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
        level.group.add(sprite);
        entry = { sprite, lamp };
        this.lampSprites.set(lamp.id, entry);
      }
      entry.lamp = lamp;
      entry.sprite.position.set(lamp.position[0], lamp.position[1], lamp.position[2]);
      const size = 0.9 + 1.3 * lamp.brightness;
      entry.sprite.scale.set(size, size, size);
    }
    for (const [id, entry] of this.lampSprites) {
      if (seen.has(id)) continue;
      entry.sprite.parent?.remove(entry.sprite);
      entry.sprite.material.dispose();
      this.lampSprites.delete(id);
    }
    this.invalidate();
  }

  // --- overlays (device markers, storey tags) positioned on top of the canvas -------------------

  setOverlay(id: string, el: HTMLElement | null, position?: [number, number, number], level?: number, kind: Overlay['kind'] = 'marker'): void {
    if (!el || !position || level === undefined) {
      this.overlays.delete(id);
      return;
    }
    this.overlays.set(id, { el, position: new Vector3(position[0], position[1], position[2]), level, kind });
    this.invalidate();
  }

  setCompass(el: HTMLElement | null): void {
    this.compass = el;
    this.invalidate();
  }

  // --- navigation ------------------------------------------------------------------------------

  get levelCount(): number {
    return this.levels.length;
  }

  overview(): void {
    this.flyTo({ dist: this.d0, pan: new Vector3() });
  }

  open(): void {
    this.flyTo({ dist: this.d0 / 1.6, pan: new Vector3() });
  }

  showLevel(index: number): void {
    const level = this.levels[index];
    if (!level || level.info.kind !== 'storey') return;
    this.cur = index;
    this.flyTo({ dist: this.d0 / 2.6, pan: new Vector3() });
  }

  back(): void {
    const k = this.k;
    if (k > 2.9 || this.pan.lengthSq() > 0.01) this.flyTo({ dist: this.d0 / 2.6, pan: new Vector3() });
    else if (k > 2) this.open();
    else this.overview();
  }

  zoomStep(direction: 1 | -1): void {
    const dist = this.goal.dist;
    const k = this.d0 / dist;
    if (direction > 0) {
      const next = ANCHORS.find((a) => a > k + 0.05);
      this.flyTo({ dist: next ? this.d0 / next : Math.max(this.minDist, dist / 1.8) });
    } else {
      const previous = [...ANCHORS].reverse().find((a) => a < k - 0.05);
      if (k > 2.9) this.flyTo({ dist: Math.min(this.d0 / 2.6, dist * 1.8) });
      else this.flyTo({ dist: previous ? this.d0 / previous : Math.min(this.maxDist, dist * 1.4), pan: previous && previous <= 1.6 ? new Vector3() : undefined });
    }
  }

  rotateBy(deg: number): void {
    this.flyTo({ theta: this.goal.theta + deg * DEG }, 500);
  }

  /** Where the camera is heading: repeated steps add up instead of restarting from halfway. */
  private get goal(): { dist: number; theta: number; phi: number } {
    return this.tween ? this.tween.to : { dist: this.dist, theta: this.theta, phi: this.phi };
  }

  /** Back to the starting angle (the shortest way round). */
  resetView(): void {
    const target = -32 * DEG;
    const delta = normDeg((this.theta - target) / DEG) * DEG;
    this.flyTo({ theta: this.theta - delta, phi: 55 * DEG }, 700);
  }

  // --- internals: camera -----------------------------------------------------------------------

  private get k(): number {
    return this.d0 / this.dist;
  }

  private get minDist(): number {
    return 0.9;
  }

  private get maxDist(): number {
    return this.d0 * 1.6;
  }

  private fit(): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    const halfV = (FOV / 2) * DEG;
    const halfH = Math.atan(Math.tan(halfV) * (width / height));
    const k = this.dist > 0 && this.d0 > 0 ? this.k : 1;
    this.d0 = (this.radius / Math.sin(Math.min(halfV, halfH))) * 1.12;
    this.dist = this.d0 / k;
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.levels.length > 0) this.fit();
    this.invalidate();
  }

  private semantic(): { o: number; g: number } {
    const k = this.k;
    return { o: smoothstep(1.12, 1.55, k), g: smoothstep(1.95, 2.45, k) };
  }

  private semanticTarget(o: number, g: number): Vector3 {
    const top = this.levels.reduce((acc, l) => Math.max(acc, l.info.topZ + l.rank * GAP), 0);
    const overview = this.center.clone();
    const opened = new Vector3(this.center.x, (Math.max(0, this.center.y - this.radius) + top) / 2, this.center.z);
    const level = this.levels[this.cur];
    const floor = level ? new Vector3(level.center.x, level.info.cutZ - 0.4, level.center.z) : overview;
    return overview.lerp(opened, o).lerp(floor, g);
  }

  private flyTo(to: Partial<Tween['to']>, duration = 750): void {
    this.spin = 0;
    this.tween = {
      from: { dist: this.dist, theta: this.theta, phi: this.phi, pan: this.pan.clone() },
      to: { dist: clamp(to.dist ?? this.dist, this.minDist, this.maxDist), theta: to.theta ?? this.theta, phi: to.phi ?? this.phi, pan: to.pan ?? this.pan.clone() },
      start: performance.now(),
      duration,
    };
    this.invalidate();
  }

  private zoomAround(newDist: number, screen: Vector2 | null): void {
    const clamped = clamp(newDist, this.minDist, this.maxDist);
    // In the free range the point under the fingers stays where it is.
    if (screen && this.d0 / clamped > 2.6) {
      const hit = this.raycast(screen);
      if (hit) {
        const target = this.currentTarget();
        const point = hit.point;
        const next = point.clone().add(target.clone().sub(point).multiplyScalar(clamped / this.dist));
        const { o, g } = this.semanticAt(this.d0 / clamped);
        this.pan.copy(next.sub(this.semanticTarget(o, g)));
        this.limitPan();
      }
    }
    this.dist = clamped;
  }

  private semanticAt(k: number): { o: number; g: number } {
    return { o: smoothstep(1.12, 1.55, k), g: smoothstep(1.95, 2.45, k) };
  }

  private limitPan(): void {
    const max = this.radius * 1.3;
    if (this.pan.length() > max) this.pan.setLength(max);
  }

  private currentTarget(): Vector3 {
    const { o, g } = this.semantic();
    return this.semanticTarget(o, g).add(this.pan);
  }

  private panBy(dx: number, dy: number): void {
    const height = this.container.clientHeight || 1;
    const perPixel = (2 * this.dist * Math.tan((FOV / 2) * DEG)) / height;
    const right = new Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
    const forward = new Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta));
    this.pan.addScaledVector(right, -dx * perPixel).addScaledVector(forward, dy * perPixel / Math.max(0.35, Math.cos(this.phi)));
    this.limitPan();
  }

  // --- internals: light ----------------------------------------------------------------------------

  private updateSun(): void {
    const when = this.time ?? new Date();
    const position = sunPosition(when, this.latitude, this.longitude);
    const light = daylight(position.altitude);
    this.night = 1 - light.day;

    const n = this.northDeg * DEG;
    const north = [Math.sin(n), Math.cos(n)];
    const east = [Math.cos(n), -Math.sin(n)];
    const a = position.azimuth * DEG;
    const h = Math.max(position.altitude, 3) * DEG;
    const mx = Math.cos(h) * (Math.cos(a) * north[0]! + Math.sin(a) * east[0]!);
    const my = Math.cos(h) * (Math.cos(a) * north[1]! + Math.sin(a) * east[1]!);
    const mz = Math.sin(h);
    const dir = new Vector3(mx, mz, -my).normalize();

    const r = this.radius;
    this.sun.position.copy(this.center).addScaledVector(dir, r * 3);
    this.sun.target.position.copy(this.center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 1.25;
    cam.right = cam.top = r * 1.25;
    cam.near = r * 0.5;
    cam.far = r * 6;
    cam.updateProjectionMatrix();

    this.sun.color.set('#fff4e4').lerp(new Color('#ffad6b'), light.warm * 0.85);
    this.sun.intensity = 3.1 * light.direct;
    this.sun.castShadow = light.direct > 0.02;
    this.hemi.color.set('#6574a3').lerp(new Color('#dfe9ff'), light.day).lerp(new Color('#ffd8b8'), light.warm * 0.35 * light.day);
    this.hemi.groundColor.set('#2a2c36').lerp(new Color('#8c7b5d'), light.day);
    this.hemi.intensity = 1.05 + 0.25 * light.day;
    this.renderer.toneMappingExposure = 1 + 0.35 * this.night;

    for (const level of this.levels) {
      for (const material of level.materials) {
        const cap = material.userData.cap as { value: Color } | undefined;
        if (cap) cap.value.copy(material.color).multiplyScalar(0.28 + 0.32 * light.day);
      }
    }
    this.container.style.background = this.skyGradient(light.day, light.warm);
  }

  private skyGradient(day: number, warm: number): string {
    const mix = (a: string, b: string, t: number) => new Color(a).lerp(new Color(b), t);
    const top = mix('#0b1020', '#bcd2e6', day).lerp(new Color('#c9b9cf'), warm * 0.55 * day);
    const bottom = mix('#1b2335', '#eef2f1', day).lerp(new Color('#f3d2ae'), warm * 0.65 * day);
    return `linear-gradient(180deg, #${top.getHexString()} 0%, #${bottom.getHexString()} 100%)`;
  }

  // --- frame ----------------------------------------------------------------------------------

  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.disposed) {
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;
    let animating = false;

    if (this.tween) {
      const t = clamp((now - this.tween.start) / this.tween.duration, 0, 1);
      const e = easeInOut(t);
      const { from, to } = this.tween;
      this.dist = lerp(from.dist, to.dist, e);
      this.theta = lerp(from.theta, to.theta, e);
      this.phi = lerp(from.phi, to.phi, e);
      this.pan.copy(from.pan).lerp(to.pan, e);
      if (t >= 1) this.tween = null;
      animating = true;
    }
    if (Math.abs(this.spin) > 0.00004) {
      this.theta += this.spin * dt;
      this.spin *= Math.exp(-dt / 340);
      animating = true;
    } else {
      this.spin = 0;
    }
    if (!this.gesture && !this.pinch) {
      // A tilt pulled past its limit springs back.
      const limited = clamp(this.phi, PHI_MIN * DEG, PHI_MAX * DEG);
      if (Math.abs(limited - this.phi) > 0.0005) {
        this.phi += (limited - this.phi) * (1 - Math.exp(-dt / 110));
        animating = true;
      } else {
        this.phi = limited;
      }
    }

    // Storeys chase their targets: lift, section height, opacity.
    const { o, g } = this.semantic();
    const follow = 1 - Math.exp(-dt / 120);
    for (const [index, level] of this.levels.entries()) {
      const kind = level.info.kind;
      const above = index > this.cur && kind === 'storey';
      const explode = o * (1 - g);
      let lift = level.rank * GAP * explode;
      let clip = 0;
      let opacity = 1;
      if (kind === 'storey') {
        if (index === this.cur) clip = Math.max(o, g);
        else if (above) clip = o;
        else clip = o * (1 - g);
        if (above) {
          lift += LIFT * g;
          opacity = 1 - g;
        }
      } else if (kind === 'roof') {
        lift += 3 * o + LIFT * g;
        opacity = 1 - o;
      }
      const prev = [level.lift, level.clip, level.opacity];
      level.lift += (lift - level.lift) * follow;
      level.clip += (clip - level.clip) * follow;
      level.opacity += (opacity - level.opacity) * follow;
      if (Math.abs(level.lift - lift) < 0.002) level.lift = lift;
      if (Math.abs(level.clip - clip) < 0.001) level.clip = clip;
      if (Math.abs(level.opacity - opacity) < 0.002) level.opacity = opacity;
      if (level.lift !== prev[0] || level.clip !== prev[1] || level.opacity !== prev[2]) animating = true;
      this.applyLevel(level);
    }
    if (this.ground) {
      const basement = (this.levels[this.cur]?.info.floorZ ?? 0) < -1;
      const opacity = basement ? 1 - g : 1;
      const material = this.ground.material as MeshStandardMaterial;
      material.opacity += (opacity - material.opacity) * follow;
      if (Math.abs(material.opacity - opacity) < 0.002) material.opacity = opacity;
      else animating = true;
      this.ground.visible = material.opacity > 0.01;
    }

    // Camera.
    const target = this.currentTarget();
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(target.x + this.dist * sinPhi * Math.sin(this.theta), target.y + this.dist * Math.cos(this.phi), target.z + this.dist * sinPhi * Math.cos(this.theta));
    this.camera.near = clamp(this.dist * 0.02, 0.03, 2);
    this.camera.far = this.dist + this.radius * 8;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);

    this.updateLamps(target);
    this.renderer.render(this.scene, this.camera);
    this.updateOverlays(o, g);
    this.reportStatus(o, g);

    if (animating || this.live || this.dirty) {
      this.dirty = false;
      if (animating || this.live) this.raf = requestAnimationFrame(this.frame);
    }
  };

  private applyLevel(level: LevelRuntime): void {
    level.group.position.z = level.lift;
    const top = level.info.topZ + 0.5;
    const height = level.clip <= 0.001 ? 1e6 : lerp(top, level.info.cutZ, level.clip);
    level.plane.constant = height + level.lift;
    const visible = level.opacity > 0.01;
    level.group.visible = visible;
    for (const material of level.materials) {
      const glass = material.userData.glass as boolean;
      const base = material.userData.baseOpacity as number;
      const fading = level.opacity < 0.999;
      if (!glass && material.transparent !== fading) {
        material.transparent = fading;
        material.needsUpdate = true;
      }
      material.opacity = base * level.opacity;
    }
  }

  private updateLamps(target: Vector3): void {
    const night = this.night;
    const candidates: { lamp: Lamp; world: Vector3; distance: number }[] = [];
    for (const { sprite, lamp } of this.lampSprites.values()) {
      const level = this.levels[lamp.level];
      const shown = level && level.opacity > 0.3 && lamp.brightness > 0 && night > 0.05;
      sprite.visible = Boolean(shown);
      sprite.material.opacity = shown ? night * (0.35 + 0.65 * lamp.brightness) * (level?.opacity ?? 1) : 0;
      if (!shown || !level) continue;
      const world = new Vector3(lamp.position[0], lamp.position[2] + level.lift, -lamp.position[1]);
      // Lamps above the section of an opened storey are hidden by the cut: let them light anyway, they belong to the room.
      candidates.push({ lamp, world, distance: world.distanceTo(target) });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    this.lampLights.forEach((light, i) => {
      const c = candidates[i];
      if (!c) {
        light.intensity = 0;
        return;
      }
      light.position.copy(c.world);
      light.intensity = night * (1.5 + 5 * c.lamp.brightness);
    });
    // Windows glow where lights are on in the storey.
    for (const [index, level] of this.levels.entries()) {
      if (level.glass.length === 0) continue;
      const lamps = [...this.lampSprites.values()].filter((entry) => entry.lamp.level === index);
      const lit = lamps.length === 0 ? 0 : lamps.filter((entry) => entry.lamp.brightness > 0).length / lamps.length;
      for (const material of level.glass) {
        material.emissive.set('#ffc07a');
        material.emissiveIntensity = night * lit * 1.4;
      }
    }
  }

  private updateOverlays(o: number, g: number): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const v = new Vector3();
    for (const overlay of this.overlays.values()) {
      const level = this.levels[overlay.level];
      if (!level) continue;
      let alpha: number;
      if (overlay.kind === 'tag') alpha = level.info.kind === 'storey' ? o * (1 - g) : 0;
      else if (level.info.kind === 'outside') alpha = 1 - g;
      else if (level.info.kind === 'roof') alpha = 1 - o;
      else alpha = overlay.level === this.cur ? g : 0;
      v.set(overlay.position.x, overlay.position.z + level.lift, -overlay.position.y).project(this.camera);
      const inside = v.z < 1 && v.x > -1.15 && v.x < 1.15 && v.y > -1.15 && v.y < 1.15;
      if (!inside) alpha = 0;
      let x = ((v.x + 1) / 2) * width;
      const y = ((1 - v.y) / 2) * height;
      if (overlay.kind === 'tag') {
        // Storey tags stay readable at the edge instead of sliding out of the picture.
        const half = overlay.el.offsetWidth / 2 + 8;
        x = clamp(x, half, width - half);
      }
      const style = overlay.el.style;
      style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      style.opacity = alpha.toFixed(3);
      style.visibility = alpha < 0.02 ? 'hidden' : 'visible';
      style.pointerEvents = alpha > 0.5 ? 'auto' : 'none';
    }
    if (this.compass) {
      // Where north is on the screen, for the needle.
      const n = this.northDeg * DEG;
      const north = new Vector3(Math.sin(n), 0, -Math.cos(n));
      const forward = new Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta));
      const right = new Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
      const angle = Math.atan2(north.dot(right), north.dot(forward)) / DEG;
      this.compass.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    }
  }

  private reportStatus(o: number, g: number): void {
    const mode: ViewMode = g > 0.5 ? 'floor' : o > 0.5 ? 'open' : 'overview';
    const next: EngineStatus = { mode, level: this.cur, zoom: Math.round(this.k * 10) / 10, night: this.night > 0.5 };
    const s = this.status;
    if (s.mode !== next.mode || s.level !== next.level || s.night !== next.night || (s.zoom > 2.9) !== (next.zoom > 2.9)) {
      this.status = next;
      this.callbacks.onStatus(next);
    } else {
      this.status = next;
    }
  }

  // --- picking -------------------------------------------------------------------------------

  private raycast(screen: Vector2): Intersection | null {
    const rect = this.container.getBoundingClientRect();
    const ndc = new Vector2(((screen.x - rect.left) / rect.width) * 2 - 1, -((screen.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.levels.filter((l) => l.group.visible && l.opacity > 0.5).flatMap((l) => l.meshes.filter((m) => !(m.material as MeshStandardMaterial).userData.glass));
    for (const hit of this.raycaster.intersectObjects(meshes, false)) {
      const level = this.levels[hit.object.userData.level as number];
      // Parts above the section are invisible: look through them.
      if (level && hit.point.y > level.plane.constant + 0.001) continue;
      return hit;
    }
    return null;
  }

  private tap(x: number, y: number): void {
    const hit = this.raycast(new Vector2(x, y));
    if (!hit) {
      this.callbacks.onTap(null);
      return;
    }
    const levelIndex = hit.object.userData.level as number;
    const level = this.levels[levelIndex]!;
    // A few centimetres off the surface, so a device sits in front of the wall it was placed on.
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new Vector3(0, 1, 0);
    const p = hit.point.clone().addScaledVector(normal, 0.05);
    this.callbacks.onTap({ level: levelIndex, point: [p.x, -p.z, p.y - level.lift] });
  }

  /** Default reaction to a tap on the house (when nothing is being placed). */
  handleTap(hit: PickResult | null): void {
    if (!hit) return;
    const level = this.levels[hit.level];
    if (!level) return;
    const { o, g } = this.semantic();
    if (g > 0.5) {
      // Inside a storey: move closer to the tapped spot.
      const point = new Vector3(hit.point[0], hit.point[2] + level.lift, -hit.point[1]);
      const nextDist = Math.max(this.minDist, this.dist / 1.7);
      const { o: o2, g: g2 } = this.semanticAt(this.d0 / nextDist);
      const pan = point.sub(this.semanticTarget(o2, g2));
      pan.y = 0;
      if (pan.length() > this.radius * 1.3) pan.setLength(this.radius * 1.3);
      this.flyTo({ dist: nextDist, pan });
    } else if (level.info.kind === 'storey' && o > 0.5) {
      this.showLevel(hit.level);
    } else if (level.info.kind === 'roof' || o <= 0.5) {
      if (level.info.kind === 'storey') this.cur = hit.level;
      this.open();
    }
  }

  // --- gestures --------------------------------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    if ((event.target as HTMLElement).closest('[data-no-gesture]')) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, button: event.button, type: event.pointerType });
    const wasMoving = this.spin !== 0 || this.tween !== null;
    this.spin = 0;
    this.tween = null;
    if (this.pointers.size === 1) {
      // A tap that stops a turning house should not also open something.
      this.moved = wasMoving;
      const pan = event.pointerType === 'mouse' && (event.button === 2 || event.button === 1 || event.shiftKey);
      this.gesture = { x: event.clientX, y: event.clientY, ax: 0, ay: 0, mode: pan ? 'pan' : null, rawPhi: this.phi, samples: [{ t: performance.now(), theta: this.theta }] };
    } else if (this.pointers.size === 2) {
      this.gesture = null;
      this.moved = true;
      const [a, b] = this.twoPointers();
      this.pinch = {
        dist: this.dist,
        startDist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x) / DEG,
        theta: this.theta,
        twist: false,
        mid: new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      this.live = true;
      this.capture(event);
    }
    this.invalidate();
  };

  private twoPointers(): [{ x: number; y: number }, { x: number; y: number }] {
    const list = [...this.pointers.values()];
    return [list[0]!, list[1]!];
  }

  private capture(event: PointerEvent): void {
    try {
      this.container.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = this.twoPointers();
      const p = this.pinch;
      const spread = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.zoomAround((p.dist * p.startDist) / spread, mid);
      const angle = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
      let turn = normDeg(angle - p.angle);
      if (!p.twist && Math.abs(turn) > 12) {
        p.twist = true;
        p.angle = angle;
        p.theta = this.theta;
        turn = 0;
      }
      if (p.twist) this.theta = p.theta + turn * DEG;
      // Both fingers moving together: slide the house.
      this.panBy(mid.x - p.mid.x, mid.y - p.mid.y);
      p.mid.copy(mid);
      this.invalidate();
      return;
    }

    const g = this.gesture;
    if (!g) return;
    let dx = event.clientX - g.x;
    let dy = event.clientY - g.y;
    g.x = event.clientX;
    g.y = event.clientY;
    g.ax += dx;
    g.ay += dy;
    if (!g.mode || (g.mode === 'pan' && !this.live)) {
      const ax = Math.abs(g.ax);
      const ay = Math.abs(g.ay);
      if (ax + ay < 7) return;
      // The first millimetres decide the direction, so a sideways swipe does not wobble the tilt.
      if (!g.mode) g.mode = ax > ay * 1.4 ? 'rot' : ay > ax * 1.4 ? 'tilt' : 'free';
      this.moved = true;
      this.live = true;
      this.capture(event);
      dx = g.ax;
      dy = g.ay;
    }
    if (g.mode === 'pan') {
      this.panBy(dx, dy);
    } else {
      if (g.mode === 'rot' && Math.abs(g.ay) > 56) g.mode = 'free';
      if (g.mode === 'tilt' && Math.abs(g.ax) > 56) g.mode = 'free';
      if (g.mode !== 'tilt') this.theta -= dx * ROT_PER_PX * DEG;
      if (g.mode !== 'rot') {
        g.rawPhi -= dy * TILT_PER_PX * DEG;
        // Past the limits the tilt follows reluctantly, and springs back when let go.
        const lo = PHI_MIN * DEG;
        const hi = PHI_MAX * DEG;
        this.phi = g.rawPhi < lo ? lo - (lo - g.rawPhi) * 0.3 : g.rawPhi > hi ? hi + (g.rawPhi - hi) * 0.3 : g.rawPhi;
      }
      const t = performance.now();
      g.samples.push({ t, theta: this.theta });
      while (g.samples.length > 2 && t - g.samples[0]!.t > 110) g.samples.shift();
    }
    this.invalidate();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.gesture = null;
        this.live = this.pointers.size > 0;
        this.snap();
      }
      return;
    }
    const g = this.gesture;
    this.gesture = null;
    this.live = false;
    if (!g) return;
    if (!g.mode) {
      // A tap (markers handle their own clicks).
      if (event.type === 'pointerup' && !this.moved) this.tap(event.clientX, event.clientY);
      this.invalidate();
      return;
    }
    if (g.mode !== 'tilt' && g.mode !== 'pan') {
      // Let a swipe coast out.
      const first = g.samples[0]!;
      const last = g.samples[g.samples.length - 1]!;
      const now = performance.now();
      if (now - last.t < 70 && last.t - first.t > 0) this.spin = clamp((last.theta - first.theta) / (last.t - first.t), -0.02, 0.02);
    }
    this.invalidate();
  };

  private onClickCapture = (event: MouseEvent): void => {
    // After a swipe the click that follows must not press a device marker.
    if (this.moved) {
      event.stopPropagation();
      event.preventDefault();
      this.moved = false;
    }
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private snap(): void {
    const k = this.k;
    if (k < 0.8 || k > 2.9) return;
    const best = ANCHORS.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a));
    this.flyTo({ dist: this.d0 / best, pan: best <= 1.6 ? new Vector3() : undefined }, 450);
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.spin = 0;
    this.tween = null;
    window.clearTimeout(this.wheelTimer);
    this.live = true;
    if (!event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      this.theta += (event.shiftKey ? event.deltaY : event.deltaX) * 0.004;
    } else {
      const factor = Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      this.zoomAround(this.dist * factor, new Vector2(event.clientX, event.clientY));
    }
    this.wheelTimer = window.setTimeout(() => {
      this.live = false;
      this.snap();
      this.invalidate();
    }, 260);
    this.invalidate();
  };

  private onKey = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement) !== this.container) return;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        this.rotateBy(event.key === 'ArrowLeft' ? 15 : -15);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        this.flyTo({ phi: clamp(this.goal.phi + (event.key === 'ArrowUp' ? 5 : -5) * DEG, PHI_MIN * DEG, PHI_MAX * DEG) }, 300);
        break;
      case '+':
      case '=':
        event.preventDefault();
        this.zoomStep(1);
        break;
      case '-':
        event.preventDefault();
        this.zoomStep(-1);
        break;
      default:
    }
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.wheelTimer);
    this.resizeObserver.disconnect();
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerup', this.onPointerUp);
    this.container.removeEventListener('pointercancel', this.onPointerUp);
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('keydown', this.onKey);
    this.container.removeEventListener('click', this.onClickCapture, true);
    this.container.removeEventListener('contextmenu', this.onContextMenu);
    this.clearModel();
    this.glowTexture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
