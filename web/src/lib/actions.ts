import type {
  BlindEntity,
  ClimateEntity,
  Entity,
  EntityCommand,
  LightEntity,
  MusicGroup,
  MusicGroupCommand,
  MusicPlayer,
  MusicPlayerCommand,
  PlayRequest,
} from '@home-hub/shared';
import { toast } from '../components/toast.tsx';
import { useHub } from '../store/hub.ts';
import { useSession } from '../store/session.ts';
import { post } from './api.ts';
import { haptic } from './platform.ts';

/**
 * Everything the user can do to a device goes through here: the screen
 * changes immediately (optimistic), the command goes to the hub, and if the
 * hub refuses, the screen goes back and says why.
 */

export async function sendCommand(entity: Entity, command: EntityCommand, optimistic?: Partial<Entity>): Promise<boolean> {
  if (!useSession.getState().can('home.control')) {
    toast.error('Dafür fehlt dir die Berechtigung.');
    return false;
  }
  const hub = useHub.getState();
  const before = hub.entities[entity.id];
  if (optimistic) hub.patchEntity(entity.id, optimistic);
  haptic();
  try {
    await post(`/api/entities/${encodeURIComponent(entity.id)}/command`, command);
    return true;
  } catch (err) {
    if (optimistic && before) useHub.getState().patchEntity(entity.id, before);
    toast.fromError(err);
    return false;
  }
}

export const light = {
  toggle: (entity: LightEntity) => sendCommand(entity, { action: entity.on ? 'turn_off' : 'turn_on' }, { on: !entity.on }),
  setBrightness: (entity: LightEntity, value: number) =>
    sendCommand(entity, { action: 'set_brightness', value }, { brightness: value, on: value > 0 } as Partial<LightEntity>),
  setColor: (entity: LightEntity, value: string) => sendCommand(entity, { action: 'set_color', value }, { color: value, on: true } as Partial<LightEntity>),
  setColorTemp: (entity: LightEntity, value: number) =>
    sendCommand(entity, { action: 'set_color_temp', value }, { colorTemp: value, on: true } as Partial<LightEntity>),
};

export const blind = {
  up: (entity: BlindEntity) => sendCommand(entity, { action: 'up' }, { motion: 'up' } as Partial<BlindEntity>),
  down: (entity: BlindEntity) => sendCommand(entity, { action: 'down' }, { motion: 'down' } as Partial<BlindEntity>),
  stop: (entity: BlindEntity) => sendCommand(entity, { action: 'stop' }, { motion: 'stopped' } as Partial<BlindEntity>),
  setPosition: (entity: BlindEntity, value: number) => sendCommand(entity, { action: 'set_position', value }, { position: value } as Partial<BlindEntity>),
  setTilt: (entity: BlindEntity, value: number) => sendCommand(entity, { action: 'set_tilt', value }, { tilt: value } as Partial<BlindEntity>),
};

export const climate = {
  setTarget: (entity: ClimateEntity, value: number) => sendCommand(entity, { action: 'set_target', value }, { target: value } as Partial<ClimateEntity>),
  setMode: (entity: ClimateEntity, value: ClimateEntity['mode']) => sendCommand(entity, { action: 'set_mode', value }, { mode: value } as Partial<ClimateEntity>),
};

export function toggleSwitch(entity: Extract<Entity, { kind: 'switch' }>): Promise<boolean> {
  return sendCommand(entity, { action: entity.on ? 'turn_off' : 'turn_on' }, { on: !entity.on });
}

export async function runAction(entity: Extract<Entity, { kind: 'action' }>): Promise<boolean> {
  const ok = await sendCommand(entity, { action: 'run' });
  if (ok) toast.success(`„${entity.name}“ gestartet`);
  return ok;
}

export function toggleClock(entity: Extract<Entity, { kind: 'clock' }>): Promise<boolean> {
  return sendCommand(entity, { action: entity.enabled ? 'disable' : 'enable' }, { enabled: !entity.enabled });
}

// --- Music ---------------------------------------------------------------------------------

function canControlMusic(): boolean {
  if (useSession.getState().can('music.control')) return true;
  toast.error('Dafür fehlt dir die Berechtigung.');
  return false;
}

export async function groupCommand(group: MusicGroup, command: MusicGroupCommand, optimistic?: Partial<MusicGroup>): Promise<boolean> {
  if (!canControlMusic()) return false;
  const before = useHub.getState().music;
  if (optimistic) {
    useHub.getState().patchMusic((music) => ({ ...music, groups: music.groups.map((g) => (g.id === group.id ? { ...g, ...optimistic } : g)) }));
  }
  try {
    await post(`/api/music/groups/${encodeURIComponent(group.id)}/command`, command);
    return true;
  } catch (err) {
    if (optimistic) useHub.getState().setMusic(before);
    toast.fromError(err);
    return false;
  }
}

export async function playerCommand(player: MusicPlayer, command: MusicPlayerCommand, optimistic?: Partial<MusicPlayer>): Promise<boolean> {
  if (!canControlMusic()) return false;
  const before = useHub.getState().music;
  if (optimistic) {
    useHub.getState().patchMusic((music) => ({ ...music, players: music.players.map((p) => (p.id === player.id ? { ...p, ...optimistic } : p)) }));
  }
  try {
    await post(`/api/music/players/${encodeURIComponent(player.id)}/command`, command);
    return true;
  } catch (err) {
    if (optimistic) useHub.getState().setMusic(before);
    toast.fromError(err);
    return false;
  }
}

export async function playMedia(groupId: string, request: PlayRequest & { title?: string }): Promise<boolean> {
  if (!canControlMusic()) return false;
  haptic();
  try {
    // Loading a playlist on a speaker can take a few seconds.
    await post(`/api/music/groups/${encodeURIComponent(groupId)}/play`, request, { timeoutMs: 30_000 });
    return true;
  } catch (err) {
    toast.fromError(err);
    return false;
  }
}
