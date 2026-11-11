import type { MyGekkoSettings, TestResult } from '@home-hub/shared';
import { sleep } from '../../util/http.ts';
import { GekkoClient, isGekkoError } from './client.ts';
import { ROOM_WINDOW_FIELD, resolveContacts } from './contacts.ts';
import { loginBlockedUntil, noteRejection } from './lockout.ts';
import { describeFailure, missingSetting } from './messages.ts';
import { filled, parseStatus, parseTree, splitSumstate, type GekkoStatus, type GekkoTree } from './protocol.ts';

/**
 * The "test connection" button of the admin UI: one status read, one tree read,
 * and a summary of what the hub would make of this controller.
 */

interface SelfTestOptions {
  timing: { requestTimeoutMs: number; authPauseMs: number; cloudSettleMs: number; httpsRetryMs: number };
  cloudBaseUrl?: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const SYSTEM_LABELS: Record<string, [one: string, many: string]> = {
  lights: ['Licht', 'Lichter'],
  blinds: ['Jalousie', 'Jalousien'],
  loads: ['Schaltgerät', 'Schaltgeräte'],
  roomtemps: ['Raumregler', 'Raumregler'],
  actions: ['Aktion', 'Aktionen'],
  clocks: ['Zeitschaltuhr', 'Zeitschaltuhren'],
  energycosts: ['Energiezähler', 'Energiezähler'],
};

const UNMAPPED_LABELS: Record<string, string> = {
  vents: 'Lüftung',
  hotwater_systems: 'Warmwasser',
  hotwater_circulations: 'Zirkulation',
  heatingsystems: 'Heizung',
  heatingcircuits: 'Heizkreise',
  energymanager: 'Energiemanager',
  multirooms: 'Multiroom',
  cams: 'Kameras',
  door_intercom: 'Türsprechstellen',
  smsemail: 'Benachrichtigungen',
  emobils: 'Ladestationen',
  pools: 'Pool',
  saunas: 'Sauna',
  stoves: 'Ofen',
  controlcircuits: 'Regelkreise',
  air_handling_unit: 'Klimagerät',
  trends: 'Analysen',
  alarms_logics: 'Logiken',
  accessdoors: 'Zutritt',
};

function itemsOf(tree: GekkoTree, system: string) {
  return [...(tree.systems.get(system)?.values() ?? [])];
}

function describeElements(tree: GekkoTree, status: GekkoStatus, settings: MyGekkoSettings): string[] {
  const lines: string[] = [];

  const found: string[] = [];
  for (const [system, [one, many]] of Object.entries(SYSTEM_LABELS)) {
    const items = itemsOf(tree, system);
    const groups = items.filter((item) => item.isGroup).length;
    const single = items.length - groups;
    if (single === 0) continue;
    const showsGroups = system === 'lights' || system === 'blinds' || system === 'loads';
    found.push(plural(single, one, many) + (showsGroups && groups > 0 ? ` (+ ${plural(groups, 'Gruppe', 'Gruppen')})` : ''));
  }
  lines.push(found.length > 0 ? `Gefunden: ${found.join(', ')}.` : 'Es wurden keine Lichter, Jalousien oder anderen bedienbaren Elemente gefunden.');

  const zones: string[] = [];
  for (const item of itemsOf(tree, 'alarmsystem')) {
    if (item.isGroup) continue;
    zones.push(item.zone1 ?? item.name);
    if (item.hasZone2) zones.push(item.zone2 ?? `${item.name} · Zone 2`);
  }
  lines.push(
    zones.length > 0
      ? `Alarmanlage: ${plural(zones.length, 'Zone', 'Zonen')} (${zones.join(', ')}). Der Hub zeigt sie nur an und schaltet sie nie.`
      : 'Keine Alarmanlage gefunden.',
  );

  const values = new Map<string, string[]>();
  for (const [key, raw] of status.values) values.set(key, splitSumstate(raw));
  const contacts = resolveContacts(tree, values, settings, new Set());
  const explicit = contacts.filter((contact) => !contact.auto);
  const automatic = contacts.filter((contact) => contact.auto);
  if (explicit.length > 0) lines.push(`Eigene Kontakt-Zuordnungen: ${explicit.length}.`);
  if (!settings.autoContacts) {
    lines.push('Die automatische Erkennung von Fenster- und Türkontakten ist ausgeschaltet.');
  } else {
    if (automatic.length > 0) {
      const names = automatic.slice(0, 6).map((contact) => contact.name);
      const rest = automatic.length - names.length;
      lines.push(`Automatisch erkannte Kontakte: ${automatic.length} (${names.join(', ')}${rest > 0 ? ` und ${rest} weitere` : ''}).`);
    } else {
      lines.push('Es wurden keine Fenster- oder Türkontakte automatisch erkannt. Sie lassen sich in den Einstellungen von Hand zuordnen.');
    }
    const windows = itemsOf(tree, 'roomtemps').filter((item) => !item.isGroup && filled(values.get(`roomtemps/${item.key}`)?.[ROOM_WINDOW_FIELD])).length;
    if (windows > 0) {
      lines.push(
        `${plural(windows, 'Raumregler meldet', 'Raumregler melden')} einen Fensterstatus. Als Kontakt erscheint ein Raumregler, sobald sein Fenster einmal geöffnet wurde.`,
      );
    }
  }

  const unmapped: string[] = [];
  for (const [system, items] of tree.systems) {
    if (system in SYSTEM_LABELS || system === 'alarmsystem') continue;
    if (contacts.some((contact) => contact.source.startsWith(`${system}/`))) continue;
    const count = [...items.values()].filter((item) => !item.isGroup).length;
    if (count > 0) unmapped.push(`${UNMAPPED_LABELS[system] ?? system} (${count})`);
  }
  if (unmapped.length > 0) lines.push(`Noch nicht in der App: ${unmapped.join(', ')}.`);
  return lines;
}

function transportLine(client: GekkoClient): string {
  switch (client.transport) {
    case 'cloud':
      return 'Verbindung: über die myGEKKO-Cloud.';
    case 'https':
      return 'Verbindung: direkt im Heimnetz, verschlüsselt (HTTPS).';
    default:
      return 'Verbindung: direkt im Heimnetz über HTTP – dieser myGEKKO bietet kein HTTPS an, die Zugangsdaten gehen unverschlüsselt durchs Heimnetz.';
  }
}

export async function runConnectionTest(settings: MyGekkoSettings, options: SelfTestOptions): Promise<TestResult> {
  const fail = (message: string, details: string[] = []): TestResult => ({ ok: false, message, details });
  const missing = missingSetting(settings);
  if (missing) return fail(missing);

  const { timing } = options;
  const blockedUntil = loginBlockedUntil(settings, Date.now(), timing.authPauseMs);
  if (blockedUntil !== null) {
    const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60_000));
    return fail(`Der myGEKKO hat die Anmeldung eben erst abgelehnt. Damit er das Konto nicht sperrt, wartet der Hub noch etwa ${plural(minutes, 'Minute', 'Minuten')} bis zum nächsten Versuch.`, [
      'Nach mehreren falschen Anmeldungen sperrt der myGEKKO das Konto für 10 Minuten.',
    ]);
  }

  let client: GekkoClient;
  try {
    client = new GekkoClient(settings, { timeoutMs: timing.requestTimeoutMs, httpsRetryMs: timing.httpsRetryMs, cloudBaseUrl: options.cloudBaseUrl });
  } catch (err) {
    return fail(describeFailure(err, settings.mode));
  }

  try {
    let status: GekkoStatus | null;
    try {
      status = parseStatus(await client.readStatus());
      if (status && client.mode === 'cloud' && !status.network.gekkoName && status.values.size === 0) {
        // The cloud subscribes to the controller on the first query; its first answer may be empty.
        await sleep(timing.cloudSettleMs);
        status = parseStatus(await client.readStatus());
      }
    } catch (err) {
      if (isGekkoError(err) && err.kind === 'auth') {
        noteRejection(settings, Date.now());
        return fail(describeFailure(err, settings.mode), ['Bitte erst die Angaben prüfen: Nach mehreren falschen Anmeldungen sperrt der myGEKKO das Konto für 10 Minuten.']);
      }
      return fail(describeFailure(err, settings.mode));
    }
    if (!status || (!status.hasGlobals && status.values.size === 0)) {
      return fail(settings.mode === 'cloud' ? 'Die myGEKKO-Cloud liefert keine Werte für diesen myGEKKO.' : 'Unter dieser Adresse antwortet kein myGEKKO.');
    }

    const { gekkoName, version, hardware } = status.network;
    const message = `Verbunden mit ${gekkoName ? `„${gekkoName}“` : 'dem myGEKKO'}${version ? ` (Firmware ${version})` : ''}.`;
    const details = [transportLine(client)];
    if (hardware) details.push(`Gerät: ${hardware}.`);

    try {
      const tree = parseTree(await client.readTree());
      if (!tree) throw new Error('not a resource tree');
      details.push(...describeElements(tree, status, settings));
    } catch (err) {
      details.push(`Die Liste der Elemente konnte nicht gelesen werden: ${describeFailure(err, settings.mode)}`);
    }
    return { ok: true, message, details };
  } finally {
    client.destroy();
  }
}
