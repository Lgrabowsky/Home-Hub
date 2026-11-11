import { crc32, deflateSync } from 'node:zlib';

/**
 * Procedural pictures for the simulators (demo mode and tests): camera views
 * with a live timestamp and album covers. Pure JavaScript PNG output — no
 * image files in the repository and no native dependencies.
 */

export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Rgb = readonly [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c: Rgb, f: number): Rgb => [c[0] * f, c[1] * f, c[2] * f];

/** Small deterministic random generator so a seed always gives the same picture. */
function random(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// 5x7 bitmap font: each glyph is 7 rows of 5 bits.
const FONT: Record<string, number[]> = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12], A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  ':': [0, 4, 4, 0, 4, 4, 0], '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ' ': [0, 0, 0, 0, 0, 0, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '&': [12, 18, 20, 8, 21, 18, 13], '+': [0, 4, 4, 31, 4, 4, 0],
};

function fontText(text: string): string {
  return text
    .toUpperCase()
    .replace(/Ä/g, 'AE')
    .replace(/Ö/g, 'OE')
    .replace(/Ü/g, 'UE')
    .replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9:\-. /&+]/g, ' ');
}

class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 3);
  }

  set(x: number, y: number, c: Rgb, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (Math.floor(y) * this.width + Math.floor(x)) * 3;
    this.data[i] = this.data[i]! * (1 - alpha) + c[0] * alpha;
    this.data[i + 1] = this.data[i + 1]! * (1 - alpha) + c[1] * alpha;
    this.data[i + 2] = this.data[i + 2]! * (1 - alpha) + c[2] * alpha;
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, alpha = 1): void {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.width, x + w); xx++) this.set(xx, yy, c, alpha);
    }
  }

  gradient(y0: number, y1: number, top: Rgb, bottom: Rgb): void {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, y1); y++) {
      const c = mix(top, bottom, (y - y0) / Math.max(1, y1 - y0));
      for (let x = 0; x < this.width; x++) this.set(x, y, c);
    }
  }

  circle(cx: number, cy: number, r: number, c: Rgb, alpha = 1): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c, alpha);
      }
    }
  }

  /** Filled quadrilateral between two horizontal edges (for paths in perspective). */
  trapezoid(yTop: number, xTopL: number, xTopR: number, yBottom: number, xBotL: number, xBotR: number, c: Rgb): void {
    for (let y = Math.floor(yTop); y < yBottom; y++) {
      const t = (y - yTop) / Math.max(1, yBottom - yTop);
      const left = xTopL + (xBotL - xTopL) * t;
      const right = xTopR + (xBotR - xTopR) * t;
      for (let x = Math.floor(left); x < right; x++) this.set(x, y, c);
    }
  }

  text(text: string, x: number, y: number, size: number, c: Rgb): number {
    let cursor = x;
    for (const char of fontText(text)) {
      const glyph = FONT[char] ?? FONT[' ']!;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row]! & (16 >> col)) this.rect(cursor + col * size, y + row * size, size, size, c);
        }
      }
      cursor += 6 * size;
    }
    return cursor;
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

export type SceneKind = 'door' | 'side-door' | 'garden' | 'driveway' | 'terrace';

export interface SceneOptions {
  kind: SceneKind;
  /** Shown in the overlay like on a real camera, e.g. the device name. */
  label: string;
  time?: Date;
  /** Somebody is standing in front of the camera. */
  person?: boolean;
  width?: number;
  height?: number;
  /** Pan position −1 … 1 (PTZ cameras): shifts the scene horizontally. */
  pan?: number;
  /** Spotlight / door light is on. */
  light?: boolean;
}

function stamp(time: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${time.getFullYear()}-${p(time.getMonth() + 1)}-${p(time.getDate())} ${p(time.getHours())}:${p(time.getMinutes())}:${p(time.getSeconds())}`;
}

/** A stylised camera picture with a timestamp overlay, as PNG. */
export function renderScene(options: SceneOptions): Buffer {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const time = options.time ?? new Date();
  const canvas = new Canvas(width, height);
  const hour = time.getHours() + time.getMinutes() / 60;
  // 1 at noon, 0 at night, with soft dawn/dusk.
  const daylight = Math.max(0, Math.min(1, (Math.cos(((hour - 13) / 12) * Math.PI) + 0.35) / 1.1));
  const lit = Math.min(1, daylight * 0.85 + 0.15 + (options.light ? 0.35 : 0));
  const shade = (c: Rgb): Rgb => scale(c, lit);
  const horizon = Math.round(height * 0.42);
  const shift = Math.round((options.pan ?? 0) * width * 0.25);
  const rand = random(options.kind);

  const skyTop = mix([8, 12, 30], [70, 140, 220], daylight);
  const skyBottom = mix([24, 28, 52], [190, 220, 245], daylight);
  canvas.gradient(0, horizon, skyTop, skyBottom);
  if (daylight < 0.25) {
    for (let i = 0; i < 40; i++) canvas.set(Math.floor(rand() * width), Math.floor(rand() * horizon * 0.9), [230, 230, 255], 0.8);
  } else {
    canvas.circle(width * 0.8 - shift * 0.2, horizon * (1.1 - daylight * 0.8), 18, [255, 240, 190], 0.9);
  }

  const lawn: Rgb = [70, 130, 70];
  const paving: Rgb = [150, 146, 140];
  const hedge: Rgb = [40, 92, 52];

  switch (options.kind) {
    case 'door':
    case 'side-door': {
      canvas.gradient(horizon, height, shade(scale(lawn, 0.8)), shade(lawn));
      // Path leading to the camera, hedges on both sides, the street beyond.
      canvas.rect(0, horizon - 6, width, 10, shade([95, 95, 100]));
      canvas.trapezoid(horizon, width * 0.46 - shift, width * 0.54 - shift, height, width * 0.2 - shift, width * 0.8 - shift, shade(paving));
      canvas.rect(-shift, horizon - 34, width * 0.3, 40, shade(hedge));
      canvas.rect(width * 0.72 - shift, horizon - 34, width * 0.4, 40, shade(hedge));
      if (options.kind === 'side-door') {
        canvas.rect(width * 0.05 - shift, horizon - 70, 46, 110, shade([120, 90, 60])); // shed
        canvas.rect(width * 0.05 - shift + 14, horizon - 20, 18, 60, shade([70, 50, 35]));
      } else {
        canvas.rect(width * 0.84 - shift, horizon - 4, 26, 34, shade([60, 62, 70])); // letter box
        canvas.rect(width * 0.84 - shift + 4, horizon + 4, 18, 3, shade([20, 20, 24]));
      }
      break;
    }
    case 'driveway': {
      canvas.gradient(horizon, height, shade([120, 118, 114]), shade([165, 160, 152]));
      canvas.rect(0, horizon - 40, width, 44, shade(hedge));
      // A parked car.
      const x = width * 0.3 - shift;
      canvas.rect(x, horizon + 60, 190, 52, shade([40, 70, 130]));
      canvas.rect(x + 30, horizon + 30, 120, 36, shade([55, 90, 160]));
      canvas.rect(x + 40, horizon + 36, 44, 24, shade([170, 200, 225]));
      canvas.rect(x + 94, horizon + 36, 44, 24, shade([170, 200, 225]));
      canvas.circle(x + 40, horizon + 114, 17, shade([25, 25, 28]));
      canvas.circle(x + 150, horizon + 114, 17, shade([25, 25, 28]));
      break;
    }
    case 'terrace': {
      canvas.gradient(horizon, height * 0.7, shade(scale(lawn, 0.85)), shade(lawn));
      canvas.rect(0, height * 0.7, width, height * 0.3, shade([160, 130, 100]));
      for (let x = -shift % 40; x < width; x += 40) canvas.rect(x, height * 0.7, 2, height * 0.3, shade([130, 104, 78]));
      canvas.rect(width * 0.55 - shift, height * 0.58, 110, 8, shade([230, 230, 225])); // table
      canvas.rect(width * 0.55 - shift + 50, height * 0.58, 10, 60, shade([200, 200, 196]));
      canvas.circle(width * 0.18 - shift, horizon - 26, 44, shade([36, 104, 60]));
      canvas.rect(width * 0.18 - shift - 5, horizon + 10, 10, 40, shade([90, 62, 40]));
      break;
    }
    default: {
      // garden
      canvas.gradient(horizon, height, shade(scale(lawn, 0.8)), shade([86, 150, 82]));
      for (const [fx, r] of [
        [0.15, 46],
        [0.42, 30],
        [0.88, 52],
      ] as const) {
        canvas.rect(width * fx - shift - 5, horizon - 10, 10, 46, shade([90, 62, 40]));
        canvas.circle(width * fx - shift, horizon - 34, r, shade([34, 100 + r, 58]));
      }
      canvas.rect(width * 0.6 - shift, horizon + 70, 120, 6, shade([200, 60, 60])); // a bench
      canvas.rect(width * 0.6 - shift + 8, horizon + 76, 6, 26, shade([150, 44, 44]));
      canvas.rect(width * 0.6 - shift + 104, horizon + 76, 6, 26, shade([150, 44, 44]));
      break;
    }
  }

  if (options.person) {
    const cx = width * 0.5 - shift * 0.5;
    const feet = height * 0.96;
    canvas.rect(cx - 34, feet - 150, 68, 150, shade([60, 80, 120]));
    canvas.circle(cx, feet - 176, 30, shade([224, 180, 150]));
    canvas.rect(cx - 30, feet - 208, 60, 16, shade([70, 50, 40]));
  }

  // Overlay like on a real camera.
  canvas.rect(0, 0, width, 22, [0, 0, 0], 0.45);
  canvas.text(options.label, 8, 4, 2, [255, 255, 255]);
  const timeText = stamp(time);
  canvas.text(timeText, width - timeText.length * 12 - 8, 4, 2, [255, 255, 255]);
  return canvas.png();
}

const COVER_PALETTES: [Rgb, Rgb, Rgb][] = [
  [[250, 112, 72], [255, 196, 92], [60, 30, 70]],
  [[36, 72, 160], [96, 196, 220], [240, 240, 250]],
  [[30, 120, 90], [200, 230, 120], [20, 40, 40]],
  [[120, 50, 150], [240, 120, 180], [30, 20, 60]],
  [[230, 60, 80], [40, 40, 60], [250, 220, 200]],
  [[20, 30, 50], [250, 180, 60], [240, 240, 240]],
  [[0, 150, 170], [250, 240, 200], [240, 90, 70]],
  [[80, 80, 90], [200, 200, 210], [250, 200, 60]],
];

/** A square cover picture derived from `seed` (same seed, same cover). */
export function renderCover(seed: string, title = '', size = 320): Buffer {
  const rand = random(seed);
  const [a, b, c] = COVER_PALETTES[Math.floor(rand() * COVER_PALETTES.length)]!;
  const canvas = new Canvas(size, size);
  canvas.gradient(0, size, a, b);
  const style = Math.floor(rand() * 3);
  if (style === 0) {
    for (let i = 0; i < 5; i++) canvas.circle(rand() * size, rand() * size, size * (0.08 + rand() * 0.22), i % 2 ? c : scale(a, 0.7), 0.55);
  } else if (style === 1) {
    for (let i = 0; i < 7; i++) canvas.rect(0, (size / 7) * i + rand() * 10, size, size / 20 + rand() * 12, i % 2 ? c : scale(b, 0.8), 0.6);
  } else {
    for (let i = 0; i < 6; i++) {
      const s = size * (0.15 + rand() * 0.3);
      canvas.rect(rand() * (size - s), rand() * (size - s), s, s, i % 2 ? c : scale(a, 0.6), 0.5);
    }
  }
  if (title) {
    canvas.rect(0, size - 46, size, 46, [0, 0, 0], 0.5);
    canvas.text(title.slice(0, Math.floor((size - 24) / 12)), 12, size - 32, 2, [255, 255, 255]);
  }
  return canvas.png();
}
