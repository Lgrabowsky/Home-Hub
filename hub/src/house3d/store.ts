import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { House3DMarker, House3DModel, House3DState, House3DView } from '@home-hub/shared';
import { HttpError } from '../http/errors.ts';
import type { Logger } from '../log.ts';
import { randomId, type Vault } from '../security/crypto.ts';
import type { SettingsStore } from '../settings.ts';
import { readIfc } from './ifc.ts';
import { buildHouseModel, ModelError } from './model.ts';
import { parseStep, StepError } from './step.ts';

/**
 * The 3D model of the house (Labs feature).
 *
 * The administrator uploads an IFC file; the hub converts it once into the
 * compact model the apps draw. Both files stay on the hub, encrypted with the
 * master key like the door pictures: `<data>/house3d/source.bin` (the IFC, so
 * a newer hub can convert it again) and `<data>/house3d/model.bin`. The
 * description, the view settings and where the devices sit are an encrypted
 * internal settings document.
 */

export const MAX_IFC_BYTES = 80 * 1024 * 1024;

/** Raise when the conversion improves: stored models are converted again from their IFC file. */
export const CONVERTER_VERSION = 1;

const SETTINGS_KEY = 'house3d';

interface Stored {
  model: House3DModel | null;
  converter: number;
  view: House3DView;
  markers: House3DMarker[];
}

/** Without a location the sun is placed for the middle of Germany. */
export const DEFAULT_VIEW: House3DView = { northDeg: 0, latitude: 51.16, longitude: 10.45, colors: {}, levelNames: {} };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Bitte eine Farbe im Format #rrggbb angeben.');
const key = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const viewSchema = z.object({
  northDeg: z.number().min(-360).max(360).default(0),
  latitude: z.number().min(-90, 'Breitengrad zwischen −90 und 90.').max(90, 'Breitengrad zwischen −90 und 90.').default(DEFAULT_VIEW.latitude),
  longitude: z.number().min(-180, 'Längengrad zwischen −180 und 180.').max(180, 'Längengrad zwischen −180 und 180.').default(DEFAULT_VIEW.longitude),
  colors: z
    .record(key, hex)
    .refine((v) => Object.keys(v).length <= 60, 'Zu viele Farben.')
    .default({}),
  levelNames: z
    .record(key, z.string().trim().max(30))
    .refine((v) => Object.keys(v).length <= 40, 'Zu viele Geschosse.')
    .default({}),
});

const coordinate = z.number().finite().min(-1e7).max(1e7);
export const markerSchema = z.object({
  position: z.tuple([coordinate, coordinate, coordinate]),
  level: key,
});

export class House3DStore {
  private readonly dir: string;
  private doc: Stored;
  private binary: Buffer | null = null;
  private source: Buffer | null = null;

  constructor(
    private readonly deps: {
      dataDir: string;
      vault: Vault;
      settings: SettingsStore;
      log: Logger;
      /** Demo mode: nothing is written to disk. */
      memoryOnly: boolean;
    },
  ) {
    this.dir = join(deps.dataDir, 'house3d');
    const stored = deps.memoryOnly ? null : deps.settings.getInternal<Stored>(SETTINGS_KEY);
    const view = viewSchema.safeParse(stored?.view ?? {});
    this.doc = {
      model: stored?.model ?? null,
      converter: stored?.converter ?? CONVERTER_VERSION,
      view: view.success ? view.data : { ...DEFAULT_VIEW },
      markers: Array.isArray(stored?.markers) ? stored.markers : [],
    };
  }

  get demo(): boolean {
    return this.deps.memoryOnly;
  }

  state(): House3DState {
    this.refresh();
    return { model: this.doc.model, view: this.doc.view, markers: this.doc.markers, demo: this.deps.memoryOnly };
  }

  /** The converted model (binary), null when none was uploaded. */
  model(): Buffer | null {
    this.refresh();
    const model = this.doc.model;
    if (!model) return null;
    if (this.binary) return this.binary;
    if (this.deps.memoryOnly) return null;
    try {
      this.binary = this.deps.vault.decryptFile(readFileSync(join(this.dir, 'model.bin')), `house3d/model/${model.version}`);
    } catch (err) {
      this.deps.log.warn({ err }, '3D model file could not be read');
      return null;
    }
    return this.binary;
  }

  /** Converts and stores an uploaded IFC file. Throws HttpError (German) for files it cannot use. */
  import(ifc: Buffer, fileName: string): House3DModel {
    if (ifc.length === 0) throw new HttpError(400, 'bad_request', 'Die Datei ist leer.');
    if (ifc.length > MAX_IFC_BYTES) throw new HttpError(413, 'too_large', `Die Datei ist zu groß (höchstens ${MAX_IFC_BYTES / 1024 / 1024} MB).`);
    const started = Date.now();
    const built = this.convert(ifc);
    const model: House3DModel = {
      ...built.info,
      version: randomId(8),
      fileName: cleanFileName(fileName),
      uploadedAt: Date.now(),
      fileBytes: ifc.length,
    };
    if (!this.deps.memoryOnly) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.write('source.bin', this.deps.vault.encryptFile(ifc, `house3d/source/${model.version}`));
      this.write('model.bin', this.deps.vault.encryptFile(built.binary, `house3d/model/${model.version}`));
    }
    this.binary = built.binary;
    this.source = this.deps.memoryOnly ? ifc : null;
    this.doc = { ...this.doc, model, converter: CONVERTER_VERSION };
    this.save();
    this.deps.log.info({ elements: model.elements, triangles: model.triangles, ms: Date.now() - started }, '3D model imported');
    return model;
  }

  remove(): void {
    this.doc = { ...this.doc, model: null };
    this.binary = null;
    this.source = null;
    if (!this.deps.memoryOnly) {
      rmSync(join(this.dir, 'model.bin'), { force: true });
      rmSync(join(this.dir, 'source.bin'), { force: true });
    }
    this.save();
  }

  setView(input: unknown): House3DView {
    const parsed = viewSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.');
    this.doc = { ...this.doc, view: parsed.data };
    this.save();
    return parsed.data;
  }

  setMarker(entityId: string, input: unknown): House3DMarker {
    const parsed = markerSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Ungültige Position.');
    const marker: House3DMarker = { entityId, position: parsed.data.position, level: parsed.data.level };
    if (this.doc.markers.length >= 1000 && !this.doc.markers.some((m) => m.entityId === entityId)) {
      throw new HttpError(400, 'bad_request', 'Es sind schon sehr viele Geräte platziert.');
    }
    this.doc = { ...this.doc, markers: [...this.doc.markers.filter((m) => m.entityId !== entityId), marker] };
    this.save();
    return marker;
  }

  removeMarker(entityId: string): void {
    this.doc = { ...this.doc, markers: this.doc.markers.filter((m) => m.entityId !== entityId) };
    this.save();
  }

  /** Demo mode: a generated house with its devices already in place. */
  loadDemo(ifc: string, markers: House3DMarker[]): void {
    this.import(Buffer.from(ifc, 'latin1'), 'Demo-Haus.ifc');
    this.doc = { ...this.doc, markers, view: { ...DEFAULT_VIEW, northDeg: 0 } };
  }

  // --- internals

  private convert(ifc: Buffer): ReturnType<typeof buildHouseModel> {
    try {
      // STEP files are ASCII; anything beyond that is written as escapes. latin1 never fails to decode.
      return buildHouseModel(readIfc(parseStep(ifc.toString('latin1'))));
    } catch (err) {
      if (err instanceof StepError || err instanceof ModelError) throw new HttpError(400, 'bad_ifc', err.message);
      this.deps.log.error({ err }, '3D model conversion failed');
      throw new HttpError(400, 'bad_ifc', 'Die IFC-Datei konnte nicht gelesen werden. Details stehen im Protokoll des Hubs.');
    }
  }

  /** A newer hub converts the stored IFC file again (better colours, fixes). */
  private refresh(): void {
    const model = this.doc.model;
    if (!model || this.doc.converter >= CONVERTER_VERSION) return;
    try {
      const source = this.deps.memoryOnly ? this.source : this.deps.vault.decryptFile(readFileSync(join(this.dir, 'source.bin')), `house3d/source/${model.version}`);
      if (!source) return;
      this.import(source, model.fileName);
      this.deps.log.info('3D model converted again after an update');
    } catch (err) {
      this.deps.log.warn({ err }, '3D model could not be converted again; keeping the old one');
      this.doc = { ...this.doc, converter: CONVERTER_VERSION };
    }
  }

  private write(name: string, data: Buffer): void {
    const file = join(this.dir, name);
    const temp = `${file}.tmp`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, file);
  }

  private save(): void {
    if (this.deps.memoryOnly) return;
    this.deps.settings.setInternal(SETTINGS_KEY, this.doc);
  }

  /** For tests: whether the encrypted files exist. */
  filesExist(): boolean {
    return existsSync(join(this.dir, 'model.bin')) && existsSync(join(this.dir, 'source.bin'));
  }
}

function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return clean || 'Modell.ifc';
}
