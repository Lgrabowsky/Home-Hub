import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { SECRET_SET, type IntegrationSettingsMap, type SettingsKey } from '@home-hub/shared';
import type { Db } from './db.ts';
import type { Vault } from './security/crypto.ts';
import { HttpError } from './http/errors.ts';

// Messages of the built-in checks ("too small", "invalid option" …) reach the administrator: speak German.
z.config(z.locales.de());

/**
 * Hub configuration that the administrator edits in the app.
 *
 * Every document is stored encrypted as a whole (it contains device addresses,
 * user names and passwords). Passwords never travel back to a client: reads
 * are masked with SECRET_SET and writes carrying SECRET_SET keep the stored
 * value.
 */

const host = z
  .string()
  .trim()
  .max(253)
  .regex(/^$|^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:\d{1,5})?$/, 'Bitte nur Hostname oder IP-Adresse angeben (ohne http://).');
const requiredHost = host.refine((v) => v.length > 0, 'Adresse fehlt.');
const deviceId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Die Kennung darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten.');
const name = z.string().trim().min(1, 'Name fehlt.').max(60);
const room = z.string().trim().max(60).default('');
const secret = z.string().max(500).default('');

function uniqueIds<T extends { id: string }>(devices: T[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  devices.forEach((device, index) => {
    if (seen.has(device.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `Die Kennung „${device.id}“ ist doppelt vergeben.` });
    seen.add(device.id);
  });
}

const schemas = {
  general: z.object({
    hubName: z.string().trim().min(1).max(40).default('Zuhause'),
    floors: z
      .array(z.object({ name: z.string().trim().min(1, 'Name des Stockwerks fehlt.').max(40), rooms: z.array(z.string().trim().min(1).max(60)).max(100).default([]) }))
      .max(20)
      .default([]),
    requireTotp: z.boolean().default(true),
    sessionDays: z.number().int().min(1).max(365).default(30),
  }),

  mygekko: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['local', 'cloud']).default('local'),
      host: host.default(''),
      username: z.string().trim().max(200).default(''),
      password: secret,
      gekkoId: z.string().trim().max(100).default(''),
      autoContacts: z.boolean().default(true),
      contactKeywords: z.string().trim().max(300).default('fenster, tür, tuer, garagentor, gartentor, hoftor, einfahrt, kontakt, magnet, terrasse, balkon, hülle, huelle'),
      doorKeywords: z.string().trim().max(300).default('tür, tuer, garagentor, gartentor, hoftor, einfahrt, eingang, door'),
      contactZone: z.string().trim().max(60).default('Hülle'),
      contacts: z
        .array(
          z.object({
            id: deviceId,
            source: z
              .string()
              .trim()
              .regex(/^[a-z_]{2,40}\/(item|group)\d{1,5}$/, 'Ungültige Quelle (erwartet z. B. alarms_logics/item12).'),
            field: z.number().int().min(0).max(99).default(0),
            openWhen: z.enum(['nonzero', 'zero']).default('nonzero'),
            name,
            contactType: z.enum(['window', 'door', 'garage', 'motion', 'other']).default('window'),
            room,
            zone: z.string().trim().max(60).default(''),
          }),
        )
        .max(200)
        .default([])
        .superRefine(uniqueIds),
    })
    .superRefine((value, ctx) => {
      if (!value.enabled) return;
      if (!value.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'Benutzername fehlt.' });
      if (!value.password) ctx.addIssue({ code: 'custom', path: ['password'], message: value.mode === 'cloud' ? 'API-Schlüssel fehlt.' : 'Passwort fehlt.' });
      if (value.mode === 'local' && !value.host) ctx.addIssue({ code: 'custom', path: ['host'], message: 'Adresse des myGEKKO fehlt.' });
      if (value.mode === 'cloud' && !value.gekkoId) ctx.addIssue({ code: 'custom', path: ['gekkoId'], message: 'myGEKKO-ID fehlt.' });
    }),

  doorbird: z.object({
    enabled: z.boolean().default(false),
    retentionDays: z.number().int().min(1).max(3650).default(90),
    devices: z
      .array(
        z.object({
          id: deviceId,
          name,
          host: requiredHost,
          username: z.string().trim().min(1, 'Benutzername fehlt.').max(100),
          password: secret,
          room,
          relayNames: z.record(z.string().max(40), z.string().trim().max(40)).default({}),
          hiddenRelays: z.array(z.string().max(40)).max(20).default([]),
        }),
      )
      .max(8)
      .default([])
      .superRefine(uniqueIds),
  }),

  reolink: z.object({
    enabled: z.boolean().default(false),
    devices: z
      .array(
        z.object({
          id: deviceId,
          name,
          host: requiredHost,
          port: z.number().int().min(0).max(65535).default(0),
          https: z.boolean().default(false),
          username: z.string().trim().min(1, 'Benutzername fehlt.').max(100),
          password: secret,
          channel: z.number().int().min(0).max(63).default(0),
          room,
          rtspPort: z.number().int().min(1).max(65535).default(554),
          streamProtocol: z.enum(['rtsp', 'flv']).default('rtsp'),
        }),
      )
      .max(32)
      .default([])
      .superRefine(uniqueIds),
  }),

  sonos: z.object({
    enabled: z.boolean().default(false),
    hosts: z.array(requiredHost).max(32).default([]),
    spotifyRegion: z.enum(['EU', 'US']).default('EU'),
  }),

  spotify: z
    .object({
      enabled: z.boolean().default(false),
      clientId: z
        .string()
        .trim()
        .max(64)
        .regex(/^[0-9a-zA-Z]*$/, 'Die Client-ID besteht nur aus Buchstaben und Ziffern.')
        .default(''),
      clientSecret: secret,
      market: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, 'Bitte einen Ländercode mit zwei Buchstaben angeben (z. B. DE).')
        .default('DE'),
    })
    .superRefine((value, ctx) => {
      if (value.enabled && !value.clientId) ctx.addIssue({ code: 'custom', path: ['clientId'], message: 'Client-ID fehlt.' });
    }),
} satisfies { [K in SettingsKey]: z.ZodType<IntegrationSettingsMap[K]> };

export const SETTINGS_KEYS = Object.keys(schemas) as SettingsKey[];

export function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as string[]).includes(key);
}

/** Visits every secret field of a settings document. */
function mapSecrets<K extends SettingsKey>(
  key: K,
  value: IntegrationSettingsMap[K],
  fn: (secretValue: string, path: string, deviceId: string | null) => string,
): IntegrationSettingsMap[K] {
  const copy = structuredClone(value) as IntegrationSettingsMap[K];
  switch (key) {
    case 'mygekko': {
      const v = copy as IntegrationSettingsMap['mygekko'];
      v.password = fn(v.password, 'password', null);
      break;
    }
    case 'spotify': {
      const v = copy as IntegrationSettingsMap['spotify'];
      v.clientSecret = fn(v.clientSecret, 'clientSecret', null);
      break;
    }
    case 'doorbird':
    case 'reolink': {
      const v = copy as IntegrationSettingsMap['doorbird'] | IntegrationSettingsMap['reolink'];
      for (const device of v.devices) device.password = fn(device.password, 'password', device.id);
      break;
    }
    default:
      break;
  }
  return copy;
}

export function maskSecrets<K extends SettingsKey>(key: K, value: IntegrationSettingsMap[K]): IntegrationSettingsMap[K] {
  return mapSecrets(key, value, (secretValue) => (secretValue ? SECRET_SET : ''));
}

/** How the administrator knows the fields (the labels of the settings forms). */
const FIELD_LABELS: Record<string, string> = {
  hubName: 'Name',
  sessionDays: 'Angemeldet bleiben',
  floors: 'Stockwerke',
  rooms: 'Räume',
  host: 'Adresse',
  hosts: 'Adressen',
  username: 'Benutzername',
  password: 'Passwort',
  gekkoId: 'myGEKKO-ID',
  contactKeywords: 'Stichwörter für Kontakte',
  doorKeywords: 'Stichwörter für Türen',
  contactZone: 'Zone',
  contacts: 'Kontakte',
  devices: 'Geräte',
  id: 'Kennung',
  name: 'Name',
  room: 'Raum',
  zone: 'Zone',
  source: 'Element am myGEKKO',
  field: 'Wert Nr.',
  retentionDays: 'Aufbewahren',
  relayNames: 'Türöffner',
  port: 'Port',
  rtspPort: 'RTSP-Port',
  channel: 'Kanal',
  clientId: 'Client-ID',
  clientSecret: 'Client-Secret',
  market: 'Land',
};

/**
 * Validation errors in the words of the form: "„Haustür“ › Adresse: …" rather
 * than "devices.0.host: …". List entries are named after their `name`.
 */
function formatIssues(error: z.ZodError, input: unknown): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const parts: string[] = [];
      let node: unknown = input;
      for (const segment of issue.path) {
        node = typeof node === 'object' && node !== null ? (node as Record<PropertyKey, unknown>)[segment as PropertyKey] : undefined;
        if (typeof segment === 'number') {
          const entryName = typeof node === 'object' && node !== null ? (node as { name?: unknown }).name : undefined;
          const label = typeof entryName === 'string' && entryName.trim() !== '' ? `„${entryName.trim().slice(0, 60)}“` : `Nr. ${segment + 1}`;
          // "Geräte › „Haustür“" says nothing more than "„Haustür“".
          if (parts.length > 0) parts[parts.length - 1] = label;
          else parts.push(label);
        } else if (typeof segment === 'string') {
          parts.push(FIELD_LABELS[segment] ?? segment);
        }
      }
      return parts.length > 0 ? `${parts.join(' › ')}: ${issue.message}` : issue.message;
    })
    .join(' · ');
}

export interface SettingsEvents {
  changed: [key: SettingsKey];
}

export class SettingsStore extends EventEmitter<SettingsEvents> {
  private readonly cache = new Map<string, unknown>();
  /** Demo mode pins integration settings in memory. */
  private readonly overrides = new Map<SettingsKey, unknown>();

  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {
    super();
  }

  private readRaw(key: string): unknown {
    if (this.cache.has(key)) return this.cache.get(key);
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    let value: unknown;
    if (row) {
      try {
        value = JSON.parse(this.vault.decryptText(row.value, `settings/${key}`));
      } catch (err) {
        throw new Error(
          `Die gespeicherte Einstellung „${key}“ lässt sich nicht entschlüsseln. Wurde HUB_MASTER_KEY bzw. master.key geändert?`,
          { cause: err },
        );
      }
    }
    this.cache.set(key, value);
    return value;
  }

  private writeRaw(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      this.vault.encryptText(JSON.stringify(value), `settings/${key}`),
      Date.now(),
    );
    this.cache.set(key, value);
  }

  /** Returns the settings including secrets — for use inside the hub only. */
  get<K extends SettingsKey>(key: K): IntegrationSettingsMap[K] {
    if (this.overrides.has(key)) return this.overrides.get(key) as IntegrationSettingsMap[K];
    const stored = this.readRaw(key) ?? {};
    const parsed = schemas[key].safeParse(stored);
    if (parsed.success) return parsed.data as IntegrationSettingsMap[K];
    // A stored document that no longer validates (e.g. after an update) must not
    // take the hub down: fall back to defaults with the integration disabled.
    return schemas[key].parse({}) as IntegrationSettingsMap[K];
  }

  /** Settings as shown to an administrator: secrets replaced by a placeholder. */
  getMasked<K extends SettingsKey>(key: K): IntegrationSettingsMap[K] {
    return maskSecrets(key, this.get(key));
  }

  isOverridden(key: SettingsKey): boolean {
    return this.overrides.has(key);
  }

  override<K extends SettingsKey>(key: K, value: Partial<IntegrationSettingsMap[K]>): void {
    this.overrides.set(key, schemas[key].parse({ ...this.get(key), ...value }));
  }

  /** Validates input from the admin UI; SECRET_SET placeholders are resolved against the stored values. */
  prepare<K extends SettingsKey>(key: K, input: unknown): IntegrationSettingsMap[K] {
    const parsed = schemas[key].safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'invalid_settings', formatIssues(parsed.error, input));
    const current = this.get(key);
    const currentSecrets = new Map<string, string>();
    mapSecrets(key, current, (secretValue, path, id) => {
      currentSecrets.set(`${id ?? ''}/${path}`, secretValue);
      return secretValue;
    });
    return mapSecrets(key, parsed.data as IntegrationSettingsMap[K], (secretValue, path, id) =>
      secretValue === SECRET_SET ? (currentSecrets.get(`${id ?? ''}/${path}`) ?? '') : secretValue,
    );
  }

  set<K extends SettingsKey>(key: K, input: unknown): IntegrationSettingsMap[K] {
    if (this.overrides.has(key)) {
      throw new HttpError(409, 'demo_mode', 'Im Demo-Modus sind die Geräte simuliert und können nicht geändert werden.');
    }
    const value = this.prepare(key, input);
    this.writeRaw(key, value);
    this.emit('changed', key);
    return value;
  }

  // --- Internal state (tokens etc.), never exposed through the settings API ----

  getInternal<T>(key: string): T | null {
    return (this.readRaw(`internal:${key}`) as T | undefined) ?? null;
  }

  setInternal(key: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.run('DELETE FROM settings WHERE key = ?', `internal:${key}`);
      this.cache.delete(`internal:${key}`);
      return;
    }
    this.writeRaw(`internal:${key}`, value);
  }
}
