import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const percent = z.number().min(0).max(100);

/** Every command a device can take, as the apps send it. */
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('turn_on') }),
  z.object({ action: z.literal('turn_off') }),
  z.object({ action: z.literal('toggle') }),
  z.object({ action: z.literal('set_brightness'), value: percent }),
  z.object({ action: z.literal('set_color'), value: color }),
  z.object({ action: z.literal('set_color_temp'), value: z.number().min(0).max(100) }),
  z.object({ action: z.literal('up') }),
  z.object({ action: z.literal('down') }),
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('set_position'), value: percent }),
  z.object({ action: z.literal('set_tilt'), value: percent }),
  z.object({ action: z.literal('set_target'), value: z.number().min(4).max(35) }),
  z.object({ action: z.literal('set_mode'), value: z.enum(['off', 'comfort', 'reduced', 'manual', 'standby', 'unknown']) }),
  z.object({ action: z.literal('run') }),
  z.object({ action: z.literal('enable') }),
  z.object({ action: z.literal('disable') }),
  z.object({ action: z.literal('set_clock_mode'), value: z.enum(['off', 'on', 'auto']) }),
  z.object({ action: z.literal('open') }),
  z.object({ action: z.literal('hold_open') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('lock') }),
]);
