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

/** Sunrise and sunset of the day of `date` (local), found by stepping through the day. */
export function sunTimes(date: Date, latitude: number, longitude: number): { rise: Date | null; set: Date | null } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  let rise: Date | null = null;
  let set: Date | null = null;
  let previous = sunPosition(start, latitude, longitude).altitude;
  for (let minutes = 5; minutes <= 24 * 60; minutes += 5) {
    const moment = new Date(start.getTime() + minutes * 60_000);
    const altitude = sunPosition(moment, latitude, longitude).altitude;
    // -0.833°: the upper rim touches the horizon, refraction included.
    if (previous < -0.833 && altitude >= -0.833 && !rise) rise = moment;
    if (previous >= -0.833 && altitude < -0.833 && !set) set = moment;
    previous = altitude;
  }
  return { rise, set };
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
