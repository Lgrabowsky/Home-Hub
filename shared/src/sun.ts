/**
 * Position of the sun for a place and a moment — computed on the device,
 * nothing is looked up online. Astronomical formulas as in Vladimir
 * Agafonkin's SunCalc (BSD-2-Clause), accurate to a fraction of a degree,
 * which is far more than shadows on a house need.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;

function toDays(date: Date): number {
  return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(m: number): number {
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const perihelion = RAD * 102.9372;
  return m + center + perihelion + Math.PI;
}

export interface SunPosition {
  /** Degrees clockwise from north (90 = east, 180 = south). */
  azimuth: number;
  /** Degrees above the horizon (negative: below). */
  altitude: number;
}

export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const d = toDays(date);
  const l = eclipticLongitude(solarMeanAnomaly(d));
  const dec = Math.asin(Math.sin(l) * Math.sin(OBLIQUITY));
  const ra = Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));
  const hourAngle = RAD * (280.16 + 360.9856235 * d) - lw - ra;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  // Measured from south towards west in the formula; turned into "from north, clockwise".
  const fromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { azimuth: ((fromSouth / RAD + 180) % 360 + 360) % 360, altitude: altitude / RAD };
}

/**
 * Sunrise and sunset between two instants (usually one day), found by stepping
 * through it in 10 minute steps and narrowing down to the minute. The upper rim
 * of the sun touching the horizon (−0.833°, refraction included) counts.
 */
export function sunCrossings(fromMs: number, toMs: number, latitude: number, longitude: number): { rise: number | null; set: number | null } {
  const HORIZON = -0.833;
  const altitude = (ms: number) => sunPosition(new Date(ms), latitude, longitude).altitude - HORIZON;
  const refine = (a: number, b: number) => {
    let lo = a;
    let hi = b;
    const rising = altitude(a) < 0;
    while (hi - lo > 30_000) {
      const mid = (lo + hi) / 2;
      if (altitude(mid) < 0 === rising) lo = mid;
      else hi = mid;
    }
    return Math.round(hi / 60_000) * 60_000;
  };
  let rise: number | null = null;
  let set: number | null = null;
  const step = 10 * 60_000;
  let previous = altitude(fromMs);
  for (let t = fromMs + step; t <= toMs; t += step) {
    const value = altitude(t);
    if (previous < 0 && value >= 0 && rise === null) rise = refine(t - step, t);
    if (previous >= 0 && value < 0 && set === null) set = refine(t - step, t);
    previous = value;
  }
  return { rise, set };
}

/** Sunrise and sunset of the day of `date` in the device's own time zone. */
export function sunTimes(date: Date, latitude: number, longitude: number): { rise: Date | null; set: Date | null } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const { rise, set } = sunCrossings(start.getTime(), end.getTime(), latitude, longitude);
  return { rise: rise === null ? null : new Date(rise), set: set === null ? null : new Date(set) };
}

export interface Daylight {
  /** 0 = night … 1 = full day. */
  day: number;
  /** How golden the light is (low sun) 0…1. */
  warm: number;
  /** 0…1, how bright direct sunlight is. */
  direct: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function daylight(altitude: number): Daylight {
  const day = smoothstep(-7, 4, altitude);
  const direct = smoothstep(-1, 12, altitude);
  const warm = altitude > 0 ? 1 - smoothstep(4, 24, altitude) : day * 0.7;
  return { day, warm, direct };
}
