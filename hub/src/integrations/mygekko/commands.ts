import { clamp, type ClimateEntity, type Entity, type EntityCommand } from '@home-hub/shared';
import { HttpError } from '../../http/errors.ts';
import { TARGET_RANGE, accepts } from './entities.ts';
import type { TreeItem } from './protocol.ts';

/**
 * Translation of the hub's commands into `scmd` values.
 *
 * Only values the element documents are ever produced: every failed API call
 * raises an alarm pop-up on the controller's display, so anything that does
 * not fit the element is refused here with a message for the user instead.
 */

export interface CommandPlan {
  /** Value for `…/scmd/set?value=`. */
  value: string;
  /** What the entity will look like once the controller has executed the command. */
  optimistic: Partial<Entity>;
}

function unsupported(message: string): HttpError {
  return new HttpError(400, 'unsupported', message);
}

function numeric(command: { value: number }, min: number, max: number): number {
  if (typeof command.value !== 'number' || !Number.isFinite(command.value)) throw new HttpError(400, 'bad_request', 'Der Wert ist keine gültige Zahl.');
  return clamp(command.value, min, max);
}

/** Standard room controllers: 1 off, 8 comfort, 16 reduced, 64 manual, 256 standby. */
const CLIMATE_MODES: Partial<Record<ClimateEntity['mode'], string>> = {
  off: 'M1',
  comfort: 'M8',
  reduced: 'M16',
  manual: 'M64',
  standby: 'M256',
};

function translate(entity: Entity, item: TreeItem, command: EntityCommand): CommandPlan {
  const name = `„${entity.name}“`;
  const mismatch = () => unsupported(`Das geht bei ${name} nicht.`);

  switch (entity.kind) {
    case 'light': {
      if (entity.isGroup) {
        // Light groups document `0|1` only — no toggle, no dimming.
        switch (command.action) {
          case 'turn_on':
            return { value: '1', optimistic: { on: true } };
          case 'turn_off':
            return { value: '0', optimistic: { on: false } };
          case 'toggle':
            return { value: entity.on ? '0' : '1', optimistic: { on: !entity.on } };
          default:
            throw unsupported(`Die Lichtgruppe ${name} lässt sich nur ein- und ausschalten.`);
        }
      }
      switch (command.action) {
        case 'turn_on':
          return { value: '1', optimistic: { on: true } };
        case 'turn_off':
          return { value: '0', optimistic: { on: false } };
        case 'toggle':
          return { value: 'T', optimistic: { on: !entity.on } };
        case 'set_brightness': {
          if (!entity.features.dim) throw unsupported(`${name} lässt sich nicht dimmen.`);
          const level = Math.round(numeric(command, 0, 100));
          if (level <= 0) return { value: '0', optimistic: { on: false } };
          return { value: `D${level}`, optimistic: { on: true, brightness: level } };
        }
        case 'set_color': {
          if (!entity.features.color) throw unsupported(`${name} kann keine Farben.`);
          const hex = /^#([0-9a-f]{6})$/i.exec(command.value)?.[1];
          if (!hex) throw new HttpError(400, 'bad_request', 'Das ist keine gültige Farbe.');
          return { value: `C${parseInt(hex, 16)}`, optimistic: { color: `#${hex.toLowerCase()}` } };
        }
        case 'set_color_temp': {
          if (!entity.features.colorTemp) throw unsupported(`Bei ${name} lässt sich die Farbtemperatur nicht einstellen.`);
          const level = Math.round(numeric(command, 0, 100));
          return { value: `TW${level}`, optimistic: { colorTemp: level } };
        }
        default:
          throw mismatch();
      }
    }

    case 'blind': {
      if (entity.isGroup) {
        // Blind groups document `2|-2` only; anything else would raise an alarm on the controller.
        switch (command.action) {
          case 'up':
            return { value: '2', optimistic: {} };
          case 'down':
            return { value: '-2', optimistic: {} };
          default:
            throw unsupported(`Die Gruppe ${name} lässt sich nur ganz hoch- oder herunterfahren.`);
        }
      }
      switch (command.action) {
        case 'up':
          return { value: '2', optimistic: { motion: entity.position === 0 ? 'stopped' : 'up' } };
        case 'down':
          return { value: '-2', optimistic: { motion: entity.position === 100 ? 'stopped' : 'down' } };
        case 'stop':
          return { value: '0', optimistic: { motion: 'stopped' } };
        case 'set_position': {
          if (!entity.features.position) throw unsupported(`${name} lässt sich nur ganz hoch- oder herunterfahren.`);
          const target = numeric(command, 0, 100);
          const from = entity.position;
          const motion = from === null || Math.round(target) === from ? entity.motion : target > from ? 'down' : 'up';
          return { value: `P${target.toFixed(1)}`, optimistic: { motion } };
        }
        case 'set_tilt': {
          if (!entity.features.tilt) throw unsupported(`${name} hat keine verstellbaren Lamellen.`);
          const tilt = numeric(command, 0, 100);
          return { value: `S${tilt.toFixed(1)}`, optimistic: { tilt: Math.round(tilt) } };
        }
        default:
          throw mismatch();
      }
    }

    case 'switch':
      switch (command.action) {
        case 'turn_on':
          // 2 = on permanently (1 would only give an impulse).
          return { value: '2', optimistic: { on: true } };
        case 'turn_off':
          return { value: '0', optimistic: { on: false } };
        case 'toggle':
          // Load groups document `0|2` only, so the hub toggles them itself.
          return { value: item.isGroup ? (entity.on ? '0' : '2') : 'T', optimistic: { on: !entity.on } };
        default:
          throw mismatch();
      }

    case 'climate':
      switch (command.action) {
        case 'set_target': {
          if (!entity.features.target) throw unsupported(`Bei ${name} lässt sich die Solltemperatur nicht einstellen.`);
          // One decimal is the resolution of the controller.
          const target = Math.round(numeric(command, TARGET_RANGE.min, TARGET_RANGE.max) * 10) / 10;
          return { value: `S${target.toFixed(1)}`, optimistic: { target } };
        }
        case 'set_mode': {
          const value = CLIMATE_MODES[command.value];
          if (!entity.features.mode || !value) throw unsupported(`Diese Betriebsart gibt es bei ${name} nicht.`);
          return { value, optimistic: { mode: command.value } };
        }
        default:
          throw mismatch();
      }

    case 'action':
      switch (command.action) {
        case 'run':
          if (!entity.features.start) throw unsupported(`${name} lässt sich nicht starten.`);
          return { value: '1', optimistic: { active: true } };
        case 'stop':
          if (!entity.features.stop) throw unsupported(`${name} lässt sich nicht stoppen.`);
          return { value: '-1', optimistic: { active: false } };
        default:
          throw mismatch();
      }

    case 'clock':
      if (!entity.features.toggle) throw unsupported(`${name} lässt sich nicht schalten.`);
      switch (command.action) {
        case 'enable':
          return { value: '1', optimistic: { enabled: true } };
        case 'disable':
          return { value: '0', optimistic: { enabled: false } };
        default:
          throw mismatch();
      }

    default:
      throw unsupported(`${name} zeigt nur einen Zustand an und lässt sich nicht bedienen.`);
  }
}

/**
 * Works out what to send for `command`. Throws `HttpError(400)` with a German
 * message when the command does not fit the entity, its features or what the
 * element itself documents.
 */
export function planCommand(entity: Entity, item: TreeItem, command: EntityCommand): CommandPlan {
  const plan = translate(entity, item, command);
  if (!item.writable) throw new HttpError(400, 'unsupported', `„${entity.name}“ lässt sich nicht schalten.`);
  if (!accepts(item, plan.value)) throw new HttpError(400, 'unsupported', `Diesen Befehl kennt der myGEKKO für „${entity.name}“ nicht.`);
  return plan;
}

/** Commands whose newest instance replaces older ones still waiting (a toggle is not one: every tap counts). */
export function isSuperseding(command: EntityCommand): boolean {
  return command.action !== 'toggle';
}
