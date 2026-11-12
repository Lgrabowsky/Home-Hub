import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * In-process myGEKKO controller speaking the Query API the way firmware 879015
 * does: `/api/v1/var` (resource tree), `/api/v1/var/status` (values) and
 * `/api/v1/var/{system}/{element}/scmd/set?value=…` (commands), every call a
 * GET with the credentials as query parameters. Format strings, field layouts
 * and index numbers are those of real controller dumps; the household is
 * invented.
 *
 * It only speaks plain HTTP — like controllers with older firmware — so the
 * integration's https→http fallback is exercised on every connection.
 */

// ---------------------------------------------------------------------------
// Documentation strings of firmware 879015 (verbatim)
// ---------------------------------------------------------------------------

const INFO = 'elementInfo enum[0=ok,1=manualOff,2=manualOn,3=locked,4=alarm]()';

interface SystemSpec {
  /** Index of item0's sumstate in the controller's variable table. */
  index: number;
  sumstate: string;
  /** null = the elements are read-only. */
  scmd: string | null;
  groupSumstate: string;
  groupScmd: string | null;
}

const SPECS = {
  lights: {
    index: 100000,
    sumstate: `currentState enum[0=off,1=on](); dimLevel float[0.00,100.0](%); rgbColor int[24bit->R:23-16|G:15-8|B:7-0](); tunableWhiteLevel float[0.00,100.0](%); ${INFO}; rgbRedColor int[0, 255](red); rgbGreenColor int[0, 255](green); rgbBlueColor int[0, 255](blue); dimStateLevel float[0.00,100.0](%); `,
    scmd: '1|0|D100|T|C44782|TW100|SD100 (On,Off|0-100[%]|1|24BitRGB|0-100[%]|0-100[%])',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: '0|1 (Off|On)',
  },
  blinds: {
    index: 150000,
    sumstate: `currentState enum[-2=holdDown,-1=movingDown,0=stop,1=movingUp,2=holdUp](); positionLevel float[0.00,100.00](%); rotationLevel float[0.00,100.00](%); ${INFO}; rotationRange enum[90=ninety,180=hundredEighty](°); `,
    scmd: '-2|-1|0|1|2|T|P55.4|S32.4 (Hold_down|Down|Stop|Up|Hold_up|Toggle|Position|Angle)',
    groupSumstate: 'State[1=Up|-1=Down]',
    groupScmd: '2|-2 (Up|Down)',
  },
  vents: {
    index: 200000,
    sumstate:
      'workingLevel enum[0=off,1=level1,2=level2,3=level3,4=level4](); deviceModel enum[0=standard,1=pluggit,2=zimmerm/proxonV1,3=westaflex,4=stiebelLWZ,5=zimmerm/proxonV2](); workingMode #zimmermann:enum[0=off,1=ecoSummer,2=ecoWinter,3=comfort,4=stove]#proxon:[0=auto,1=manual,2=pluggitAuto,3=pluggitWeek](); bypassState enum[0=auto,1=manual,2=summer](); maximumWorkingLevel enum[0=off,1=level1,2=level2,3=level3,4=level4](); relativeHumidityLevel float[0.00,100.00](%); airQualityLevel float[0.00,100.00](%); co2Value float[0.00,100000.00](ppm); supplyAirTemperatureValue float[-100.00,100.00](°C); exhaustAirTemperatureValue float[-100.00,100.00](°C); outsideAirTemperatureValue float[-100.00,100.00](°C); outgoingAirTemperatureValue float[-100.00,100.00](°C); supplyAirWorkingLevel float[0.00,100.00](%); exhaustAirWorkingLevel float[0.00,100.00](%); elementInfo enum[0=auto,1=manualOff,2=manualOn,3=locked,4=alarm](); subWorkingMode #zimmermann:enum[0=middleTemp+offset,1=onlyOffset]#others:enum[0=exhaust,1=exhaust/supply,2=exhaust/supply/heatRecovery](); coolingModeState enum[0=off,1=on](); dehumidModeState enum[0=off,1=on](); bypassMode enum[0=auto,1=manual,2=summer](); ',
    scmd: '-1|1|2|3|4|T|BY0|BY1|BY2|C0|C1|D0|D1|Mx (Off|Level1|Level2|Level3|Level4|Toggle|BypassAuto|BypassManual|BypassSummer|Cool.Off|Cool.On|Dehumid.Off|Dehumid.On|OperatingMode[0..x])',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: '-1|1|2|3|4 (Off|Level1|Level2|Level3|Level4)',
  },
  loads: {
    index: 250000,
    sumstate: `currentState enum[0=off,1=onImpulse,2=onPermanent](); ${INFO}; `,
    scmd: '0|1|2|T (Off|OnImpulse|OnPermanent|Toggle)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: '0|2 (Off|On)',
  },
  roomtemps: {
    index: 300000,
    sumstate: `temperatureValue float[-100.00,100.00](°C); temperatureSetPointValue float[-100.00,100.00](°C); valveOpeningLevel float[0.00,100.00](%); workingMode #standard:enum[1=off,8=comfort,16=reduced,64=manual,256=standby]#knx:enum[0=auto,1=comfort,2=standby,3=economy,4=buildingProtection](); reserved null[reserved](); temperatureAdjustmentValue float[-100.00,100.00](°C); coolingModeState enum[0=off,1=on](); ${INFO}; relativeHumidityLevel float[0.00,100.00](%); airQualityLevel #co2:float[0.00,100.00](%)#quality:float[0.00,100.00](%)#voc:float[0,100000.00](ppm); floorTemperatureValue float[-100.00,100.00](°C); deviceModel enum[0=standard,3=knxDevice](); windowOpenStatus enum[0=close,1=open](); presenceStatus enum[0=noPresence,1=Presence](); `,
    scmd: 'M1|M2|M8|M16|M64|M256|K2.4|S22.5 (ModeOff|ModeOn|ModeComfort|ModeReduced|ModeManual|ModeStandby|TempAdjustment[°C]|Setpoint[°C])',
    groupSumstate: 'State[0=Off|1=On|2=Comfort|3=Reduced]',
    groupScmd: 'M1|M2|M8|M16 (Mode_Off|Mode_On|Mode_Comfort|Mode_Reduced)',
  },
  energycosts: {
    index: 450000,
    sumstate: `currentPowerValue float[0.00,...](powerUnit); totalEnergyTodayValue float[0.00,...](energyUnit); totalEnergyMonthValue float[0.00,...](energyUnit); totalEnergyValue float[0.00,...](energyUnit); nominalPowerValue float[0.00,...](powerUnit); energyUnit string[xh:x=kW,ml,l3,...](I.S.); powerUnit string[x:x=kW,ml,l3,...](I.S.); totalEnergyToday0h6hValue float[0.00,...](energyUnit); totalEnergyToday6h12hValue float[0.00,...](energyUnit); totalEnergyToday12h18hValue float[0.00,...](energyUnit); totalEnergyToday18h24hValue float[0.00,...](energyUnit); totalEnergyYesterday0h6hValue float[0.00,...](energyUnit); totalEnergyYesterday6h12hValue float[0.00,...](energyUnit); totalEnergyYesterday12h18hValue float[0.00,...](energyUnit); totalEnergyYesterday18h24hValue float[0.00,...](energyUnit); ${INFO}; totalEnergyThisYearValue float[0.00,...](energyUnit); totalEnergyInPeriodValue float[0.00,...](energyUnit); startDateTotalEnergyInPeriod string[dd.mm.yyyy hh:mm:ss](); counterDirection enum[0=consumption,1=production](); currentFlowTempValue float[0.00,...](°C); currentReturnTempValue float[0.00,...](°C); currentFlowRateValue float[0.00,...](l/h); totalVolumeValue float[0.00,...](m3); currentPowerP1Value float[0.00,...](kW); currentPowerP2Value float[0.00,...](kW); currentPowerP3Value float[0.00,...](kW); currentVoltageU1Value float[0.00,...](V); currentVoltageU2Value float[0.00,...](V); currentVoltageU3Value float[0.00,...](V); currentCurrentI1Value float[0.00,...](A); currentCurrentI2Value float[0.00,...](A); currentCurrentI3Value float[0.00,...](A); currentFrequencyValue float[0.00,...](Hz); currentPowerFactorValue float[0.00,1.00](); `,
    scmd: 'RP (ResetPeriod)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
  alarms_logics: {
    index: 500000,
    sumstate:
      'outputGate1 float[...,...](); outputGate2 float[...,...](); outputGate3 float[...,...](); outputGate4 float[...,...](); outputGate5 float[...,...](); outputGate6 float[...,...](); outputGateA float[...,...](); outputGateB float[...,...](); outputGateC float[...,...](); outputGateD float[...,...](); outputGateE float[...,...](); outputGateF float[...,...](); outputGateG float[...,...](); inputValue1_1 float[...,...](); inputValue1_2 float[...,...](); inputValue2_1 float[...,...](); inputValue2_2 float[...,...](); inputValue3_1 float[...,...](); inputValue3_2 float[...,...](); inputValue4_1 float[...,...](); inputValue4_2 float[...,...](); inputValue5_1 float[...,...](); inputValue5_2 float[...,...](); inputValue6_1 float[...,...](); inputValue6_2 float[...,...](); ',
    scmd: 'S44.7 (SetpointValue)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
  accessdoors: {
    index: 550000,
    sumstate: `accessControllerActionState enum[0=close,1=open,2=holdOpen,3=partiallyOpen,4=partiallyHoldOpen](); ${INFO}; accessState enum[0=closed,1=open](); gateRuntimeLevel int[0,100](%); accessType enum[0=door control,1=gate control,2=barrier control,3=gate operation,10=myGEKKO Net remote door](); `,
    scmd: '-3|-2|-1|1|2 (Stop|Close|Lock|Open|Hold open)',
    groupSumstate: 'State[0=Closed|1=Open]',
    groupScmd: null,
  },
  alarmsystem: {
    index: 650000,
    sumstate:
      'alarmState enum[0=ok,1=alarm](); zone1DeviceStatus enum[0=off,1=on](); zone1SharpState enum[0=unsharp,1=sharp](); zone1AlarmState enum[0=ok,2=alarmButUnsharp,3=alarm](); zone2DeviceStatus enum[0=off,1=on](); zone2SharpState enum[0=unsharp,1=sharp](); zone2AlarmState enum[0=ok,2=alarmButUnsharp,3=alarm](); deviceModel enum[1=standard,2=complex400_V1](); ',
    scmd: '1|2 (Zone 1 Sharp|Zone 2 Sharp)',
    groupSumstate: 'State[0=Off|1=Sharp]',
    groupScmd: '1 (Sharp)',
  },
  actions: {
    index: 850000,
    sumstate: `currentState enum[0=off,1=on](); startConditionState enum[0=off,1=on](); ${INFO}; `,
    scmd: '-1|1|T (Stop|Start|Toggle)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
  clocks: {
    index: 900000,
    sumstate: `currentState enum[0=off,1=on,2=onCoincidence](); startConditionState enum[0=off,1=on](); ${INFO}; `,
    scmd: '0|1|2 (Off|On|onCoincidence)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
  trends: {
    index: 1350000,
    sumstate: `${[1, 2, 3, 4]
      .map(
        (n) =>
          `variable${n}State enum[0=off,1=on](); variable${n}Type enum[0=logic,1=dIn,2=dOut,3=aIn,4=aOut,5=aIn2_10,6=pt100,7=pt1000](); variable${n}Name string[name](); variable${n}Value float[...,...](unit${n}); variable${n}Unit string[unitName](I.S.); `,
      )
      .join('')}${INFO}; `,
    scmd: 'S44.7 (SetpointValue)',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
  hotwater_systems: {
    index: 1950000,
    sumstate: `deviceModel enum[0=individual,1=buderus,2=stiebel,3=tecalor,4=vaillant](); coolingModeState enum[0=off,1=on](); waterTemperatureSetPointValue float[-100.00,100.00](°C); waterTemperatureTopValue float[-100.00,100.00](°C); waterTemperatureBottomValue float[-100.00,100.00](°C); collectorTemperatureValue float[-100.00,100.00](°C); currentState enum[0=off,1=on](); ${INFO}; `,
    scmd: '0|1|T100 (Off|On|Temperature[°C])',
    groupSumstate: 'State[0=Off|1=On]',
    groupScmd: null,
  },
} satisfies Record<string, SystemSpec>;

type SystemName = keyof typeof SPECS;

const GLOBALS_TREE = {
  network: {
    gekkoname: { description: 'Hostname of device', format: 'string[name]()', type: 'STRING', permission: 'READ', index: 1 },
    language: {
      description: 'Language of device. DE=German,IT=Italian,EN=English,NL=Dutch,ES=Spanish,FR=French,CS=Czech',
      format: 'enum[0=DE,1=IT,2=EN,3=NL,4=ES,5=FR,6=CS]()',
      type: 'AV',
      permission: 'READ',
      index: 2,
    },
    version: { description: 'Software version of device', format: 'int[0,...](version)', type: 'AO', permission: 'READ', index: 3 },
    hardware: { description: 'Hardware version of device', format: 'string[version]()', type: 'STRING', permission: 'READ', index: 4 },
  },
  alarm: {
    sumstate: { description: 'Global alarm state of device', format: 'enum[0=ok,1=unacknowledged,2=acknowledged,3=alarm]()', type: 'AO', permission: 'READ', index: 101 },
  },
  meteo: {
    twilight: { description: 'Current twilight value in lux (lx)', format: 'float[0.00,100000.00](lx)', type: 'AI', permission: 'READ', index: 201 },
    humidity: { description: 'Current relative humidity level', format: 'float[0.00,100.00](%)', type: 'AI', permission: 'READ', index: 202 },
    brightness: { description: 'Current brightness value in kilo lux (kLx)', format: 'float[0.00,100000.00](kLx)', type: 'AI', permission: 'READ', index: 203 },
    brightnessw: {
      description: 'Current brightness value from the west sensor in kilo lux (kLx)',
      format: 'float[0.00,100000.00](kLx)',
      type: 'AI',
      permission: 'READ',
      index: 204,
    },
    brightnesso: {
      description: 'Current brightness value from the east sensor in kilo lux (kLx)',
      format: 'float[0.00,100000.00](kLx)',
      type: 'AI',
      permission: 'READ',
      index: 205,
    },
    wind: { description: 'Current value of the wind in meter/second (m/s)', format: 'float[0.00,100000.00](m/s)', type: 'AI', permission: 'READ', index: 206 },
    temperature: {
      description: 'Current value of the temperature in degrees celsius (°C)',
      format: 'float[-100.00,100.00](°C)',
      type: 'AI',
      permission: 'READ',
      index: 207,
    },
    rain: { description: 'Current value of the accumulated rain in liter/hour (l/h)', format: 'float[0.00,100.00](l/h)', type: 'AI', permission: 'READ', index: 208 },
  },
};

export type MeteoKey = keyof typeof GLOBALS_TREE.meteo;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** HTTP status of a command: 200 done, 400 not a documented value, 444 documented but not executed. */
type CommandStatus = 200 | 400 | 444;

interface SimElement {
  key: string;
  name: string;
  /** Elements only; "..." is what the controller reports for an element that sits on no page. */
  page?: string;
  /** Further properties of the tree entry (zone names). */
  extra?: Record<string, string>;
  read(now: number): string;
  /** Missing = the element takes no commands (405). */
  write?(value: string, now: number): CommandStatus;
}

interface SimSystem {
  spec: SystemSpec;
  elements: SimElement[];
}

const f2 = (value: number) => value.toFixed(2);
const numberAfter = (value: string, prefix: string): number | null => {
  const match = new RegExp(`^${prefix}([-+]?\\d+(?:\\.\\d+)?)$`).exec(value);
  return match ? Number(match[1]) : null;
};

interface Light extends SimElement {
  on: boolean;
  /** Dim level in percent; null for a light that only switches. */
  dim: number | null;
  rgb: number | null;
  tunableWhite: number | null;
}

function light(key: string, name: string, page: string, features: { dim?: number; rgb?: number; tunableWhite?: number } = {}): Light {
  const self: Light = {
    key,
    name,
    page,
    on: false,
    dim: features.dim ?? (features.rgb !== undefined || features.tunableWhite !== undefined ? 100 : null),
    rgb: features.rgb ?? null,
    tunableWhite: features.tunableWhite ?? null,
    read() {
      // Real lights send 24 fields; only the first five and the last are documented/used:
      // "0;;;;0;;;;;;;;;;;;;;;;;;;0.00;"
      const level = self.on ? (self.dim ?? 100) : 0;
      const fields = [self.on ? '1' : '0', self.dim === null ? '' : f2(self.dim), self.rgb === null ? '' : String(self.rgb), self.tunableWhite === null ? '' : f2(self.tunableWhite), '0'];
      return `${fields.join(';')};${';'.repeat(18)}${f2(level)};`;
    },
    write(value) {
      if (value === '1') self.on = true;
      else if (value === '0') self.on = false;
      else if (value === 'T') self.on = !self.on;
      else {
        const dim = numberAfter(value, 'D') ?? numberAfter(value, 'SD');
        const rgb = numberAfter(value, 'C');
        const white = numberAfter(value, 'TW');
        if (dim !== null) {
          if (dim < 0 || dim > 100) return 400;
          if (self.dim !== null) self.dim = dim > 0 ? dim : self.dim;
          if (value.startsWith('D')) self.on = dim > 0;
        } else if (rgb !== null) {
          if (self.rgb === null) return 444;
          self.rgb = rgb & 0xffffff;
          self.on = true;
        } else if (white !== null) {
          if (self.tunableWhite === null) return 444;
          self.tunableWhite = Math.min(100, Math.max(0, white));
        } else {
          return 400;
        }
      }
      return 200;
    },
  };
  return self;
}

interface Blind extends SimElement {
  /** What the controller reports as currentState. */
  state: -2 | -1 | 0 | 1 | 2;
  position: number;
  tilt: number;
  locked: boolean;
  move: { from: number; to: number; startedAt: number; arrive: Blind['state'] } | null;
  lastDirection: 'up' | 'down';
  /** Brings position and state up to date. */
  settle(now: number): void;
}

function blind(key: string, name: string, page: string, travelMs: () => number): Blind {
  const start = (to: number, during: Blind['state'], arrive: Blind['state'], now: number) => {
    self.settle(now);
    if (to === self.position) {
      self.state = arrive;
      self.move = null;
      return;
    }
    self.lastDirection = to < self.position ? 'up' : 'down';
    self.move = { from: self.position, to, startedAt: now, arrive };
    self.state = during;
  };
  const self: Blind = {
    key,
    name,
    page,
    state: 0,
    position: 0,
    tilt: 0,
    locked: false,
    move: null,
    lastDirection: 'up',
    settle(now) {
      const move = self.move;
      if (!move) return;
      const duration = (Math.abs(move.to - move.from) / 100) * travelMs();
      const progress = duration <= 0 ? 1 : (now - move.startedAt) / duration;
      if (progress >= 1) {
        self.position = move.to;
        self.state = move.arrive;
        self.move = null;
        // Slats follow the travel: closed when the blind came down, open when it went up.
        if (move.to > move.from) self.tilt = 100;
        else self.tilt = 0;
      } else {
        self.position = move.from + (move.to - move.from) * progress;
      }
    },
    read(now) {
      self.settle(now);
      return `${self.state};${f2(self.position)};${f2(self.tilt)};${self.locked ? 3 : 0};90;`;
    },
    write(value, now) {
      const position = numberAfter(value, 'P');
      const angle = numberAfter(value, 'S');
      const known = ['-2', '-1', '0', '1', '2', 'T'].includes(value) || position !== null || angle !== null;
      if (!known) return 400;
      // A locked blind (wind alarm, manual lock) documents the command but does not execute it.
      if (self.locked) return 444;
      self.settle(now);
      if (value === '0') {
        self.move = null;
        self.state = 0;
      } else if (value === '2') {
        // "Hold up" stays reported after the blind has arrived (seen in real dumps: "2;0.00;0.00;0;180;").
        start(0, 2, 2, now);
      } else if (value === '-2') {
        start(100, -2, -2, now);
      } else if (value === '1') {
        start(0, 1, 0, now);
      } else if (value === '-1') {
        start(100, -1, 0, now);
      } else if (value === 'T') {
        if (self.move) {
          self.move = null;
          self.state = 0;
        } else if (self.lastDirection === 'up') {
          start(100, -1, 0, now);
        } else {
          start(0, 1, 0, now);
        }
      } else if (position !== null) {
        if (position < 0 || position > 100) return 400;
        start(position, position < self.position ? 1 : -1, 0, now);
      } else if (angle !== null) {
        if (angle < 0 || angle > 100) return 400;
        self.tilt = angle;
      }
      return 200;
    },
  };
  return self;
}

interface Load extends SimElement {
  state: 0 | 1 | 2;
  impulseUntil: number;
}

/** Length of an "on by impulse". */
const IMPULSE_MS = 1500;

function load(key: string, name: string, page: string): Load {
  const self: Load = {
    key,
    name,
    page,
    state: 0,
    impulseUntil: 0,
    read(now) {
      if (self.state === 1 && now >= self.impulseUntil) self.state = 0;
      return `${self.state};0;`;
    },
    write(value, now) {
      if (value === '0') self.state = 0;
      else if (value === '2') self.state = 2;
      else if (value === '1') {
        self.state = 1;
        self.impulseUntil = now + IMPULSE_MS;
      } else if (value === 'T') self.state = self.state === 0 ? 2 : 0;
      else return 400;
      return 200;
    },
  };
  return self;
}

interface RoomController extends SimElement {
  temperature: number;
  target: number;
  mode: number;
  humidity: number;
  adjustment: number;
  /** A window contact is wired to this room controller. */
  hasWindowContact: boolean;
  windowOpen: boolean;
}

function roomController(key: string, name: string, temperature: number, target: number, humidity: number, hasWindowContact = false): RoomController {
  const self: RoomController = {
    key,
    name,
    page: name,
    temperature,
    target,
    mode: 8,
    humidity,
    adjustment: 0,
    hasWindowContact,
    windowOpen: false,
    read() {
      const heating = self.mode !== 1 && !self.windowOpen;
      const valve = heating ? Math.min(100, Math.max(0, (self.target - self.temperature) * 60)) : 0;
      // Every room controller of firmware 879015 reports deviceModel;windowOpenStatus;presenceStatus —
      // with or without a wired window contact (then it simply stays 0).
      return `${f2(self.temperature)};${f2(self.target)};${f2(valve)};${self.mode};;${f2(self.adjustment)};0;0;${f2(self.humidity)};;;0;${self.windowOpen ? 1 : 0};0;`;
    },
    write(value) {
      const setpoint = numberAfter(value, 'S');
      const adjustment = numberAfter(value, 'K');
      if (['M1', 'M2', 'M8', 'M16', 'M64', 'M256'].includes(value)) self.mode = value === 'M2' ? 8 : Number(value.slice(1));
      else if (setpoint !== null) self.target = setpoint;
      else if (adjustment !== null) self.adjustment = adjustment;
      else return 400;
      return 200;
    },
  };
  return self;
}

/** A logic element used as a contact: its input is the reed contact, the gates pass it through. */
interface LogicContact extends SimElement {
  value: number;
}

function logic(key: string, name: string, page: string): LogicContact {
  const self: LogicContact = {
    key,
    name,
    page,
    value: 0,
    read() {
      const fields = new Array<number>(25).fill(0);
      // outputGate1, outputGateA, outputGateG and inputValue1_1 (see the format string).
      for (const index of [0, 6, 12, 13]) fields[index] = self.value;
      return `${fields.map(f2).join(';')};`;
    },
    write(value) {
      return numberAfter(value, 'S') === null ? 400 : 200;
    },
  };
  return self;
}

function fixed(key: string, name: string, page: string | undefined, value: string, writable = false): SimElement {
  return { key, name, page, read: () => value, ...(writable ? { write: (): CommandStatus => 444 } : {}) };
}

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

export interface MyGekkoSimOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  username?: string;
  password?: string;
  gekkoName?: string;
  /** Milliseconds a blind needs from fully open to fully closed. */
  blindTravelMs?: number;
  /**
   * Behave like live.my-gekko.com: the login is `username` + `key` + `gekkoid`,
   * an unknown id answers 410, and the first status answers carry no values yet
   * (the cloud only subscribes to the controller on the first query).
   */
  cloud?: { key: string; gekkoId: string; incompleteAnswers?: number };
  /** Lock the account after this many wrong logins in a row (null = never). Real controllers lock for 10 minutes. */
  lockout?: { attempts: number; durationMs: number } | null;
  /**
   * How the reed contacts of the zone "Hülle" show up in the Query API.
   * `named` (default): one logic element per contact on the page "Türen und Fenster".
   * `unnamed`: only as inputs of a single logic element without a telling name (its first output is
   * "any input open"), and no trend logs them — what the hub has to find out by watching.
   */
  contacts?: 'named' | 'unnamed';
}

export interface SimCommand {
  system: string;
  element: string;
  value: string;
  /** HTTP status the simulator answered with. */
  status: number;
}

export interface MyGekkoSim {
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** `127.0.0.1:<port>` — what goes into the hub's "host" setting. */
  readonly host: string;
  readonly username: string;
  readonly password: string;
  /** Every command call received, in order. */
  readonly commands: SimCommand[];
  /** Number of answered requests by kind. */
  readonly requests: { tree: number; status: number; command: number; other: number };
  /** Number of logins rejected with 403. */
  readonly forbiddenCount: number;
  /** Open TCP connections right now. */
  readonly connections: number;
  close(): Promise<void>;

  /** Names accepted by `setContact`. */
  contactNames(): string[];
  /** Opens or closes a window/door contact, e.g. "Fenster Küche", "Haustür", "Fenster Schlafzimmer". */
  setContact(name: string, open: boolean): void;
  isContactOpen(name: string): boolean;
  /** Arms the zone "Hülle"; refused (false) while a contact is open. */
  arm(): boolean;
  disarm(): void;
  readonly alarm: { armed: boolean; triggered: boolean };

  /** Stops answering (connection refused) / comes back on the same port. */
  setOffline(offline: boolean): Promise<void>;
  /** Accepts connections but never answers (a hanging controller). */
  setStalled(stalled: boolean): void;
  setCredentials(username: string, password: string): void;
  /** The next `count` requests are answered with `status` (e.g. 429). */
  failNext(status: number, count?: number): void;

  /** Current sumstate of an element, e.g. `sumstate('lights', 'item0')`. */
  sumstate(system: string, element: string): string;
  /** Element key by name, e.g. `find('lights', 'Stehlampe')` → `item1`. */
  find(system: string, name: string): string;
  setMeteo(key: MeteoKey, value: number): void;
  setRoomTemperature(name: string, temperature: number): void;
  /** Locks a blind (elementInfo 3): commands are then answered with 444. */
  lockBlind(name: string, locked: boolean): void;
  /** Adds a light on the controller — it shows up in the tree and in the status at once. */
  addLight(name: string, page: string): string;
  rename(system: string, element: string, name: string): void;
}

interface AlarmState {
  armed: boolean;
  triggered: boolean;
}

class Simulator implements MyGekkoSim {
  port = 0;
  username: string;
  password: string;
  readonly commands: SimCommand[] = [];
  readonly requests = { tree: 0, status: 0, command: 0, other: 0 };
  forbiddenCount = 0;
  readonly alarm: AlarmState = { armed: false, triggered: false };

  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly stalledResponses = new Set<ServerResponse>();
  private readonly systems = new Map<string, SimSystem>();
  private readonly meteo: Record<MeteoKey, number> = {
    twilight: 6000,
    humidity: 71,
    brightness: 18,
    brightnessw: 11,
    brightnesso: 21,
    wind: 2.4,
    temperature: 8.6,
    rain: 0,
  };
  private readonly gekkoName: string;
  private readonly cloud: MyGekkoSimOptions['cloud'];
  private readonly lockout: NonNullable<MyGekkoSimOptions['lockout']> | null;
  private blindTravelMs: number;
  private incompleteAnswers: number;
  private offline = false;
  private stalled = false;
  private failing: { status: number; count: number } | null = null;
  private wrongLogins = 0;
  private lockedUntil = 0;

  // Typed handles on the household.
  private readonly lights: Light[] = [];
  private readonly blinds: Blind[] = [];
  private readonly loads: Load[] = [];
  private readonly rooms: RoomController[] = [];
  private readonly logics: LogicContact[] = [];
  private readonly contactStyle: 'named' | 'unnamed';
  private readonly gate = { open: false };
  private blindGroupState = 0;

  constructor(options: MyGekkoSimOptions) {
    this.username = options.username ?? 'hub';
    this.password = options.password ?? 'gekko-demo-passwort';
    this.gekkoName = options.gekkoName ?? 'myGEKKO';
    this.cloud = options.cloud;
    this.lockout = options.lockout === undefined ? { attempts: 5, durationMs: 10 * 60_000 } : options.lockout;
    this.blindTravelMs = options.blindTravelMs ?? 18_000;
    this.incompleteAnswers = options.cloud?.incompleteAnswers ?? 0;
    this.contactStyle = options.contacts ?? 'named';
    this.buildHousehold();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  get connections(): number {
    return this.sockets.size;
  }

  // --- Household ------------------------------------------------------------------

  private buildHousehold(): void {
    const travel = () => this.blindTravelMs;

    this.lights.push(
      light('item0', 'Wohnzimmer Decke', 'Wohnzimmer', { dim: 80 }),
      light('item1', 'Stehlampe', 'Wohnzimmer', { dim: 40 }),
      light('item2', 'LED-Band', 'Wohnzimmer', { rgb: 0xff8a3d, dim: 60 }),
      light('item3', 'Küche Decke', 'Küche'),
      light('item4', 'Arbeitsplatte', 'Küche', { tunableWhite: 35, dim: 100 }),
      light('item5', 'Esstisch', 'Esszimmer', { dim: 70 }),
      light('item6', 'Schlafzimmer Decke', 'Schlafzimmer', { dim: 50 }),
      light('item7', 'Kinderzimmer Decke', 'Kinderzimmer'),
      light('item8', 'Bad Spiegel', 'Bad'),
      light('item9', 'Flur', 'Flur'),
      light('item10', 'Büro Decke', 'Büro'),
      // Element numbers have gaps on real controllers.
      light('item12', 'Terrasse', 'Außen'),
    );
    this.lights[3]!.on = true;
    this.lights[5]!.on = true;
    const groundFloor = () => this.lights.filter((l) => ['Wohnzimmer', 'Küche', 'Esszimmer', 'Flur'].includes(l.page ?? ''));
    const lightGroup = (key: string, name: string, members: () => Light[]): SimElement => ({
      key,
      name,
      read: () => (members().some((l) => l.on) ? '1' : '0'),
      write: (value) => {
        if (value !== '0' && value !== '1') return 400;
        for (const member of members()) member.on = value === '1';
        return 200;
      },
    });
    this.systems.set('lights', {
      spec: SPECS.lights,
      elements: [...this.lights, lightGroup('group0', 'Alle Lichter', () => this.lights), lightGroup('group1', 'Erdgeschoss', groundFloor)],
    });

    this.blinds.push(
      blind('item0', 'Jalousie Wohnzimmer links', 'Wohnzimmer', travel),
      blind('item1', 'Jalousie Wohnzimmer rechts', 'Wohnzimmer', travel),
      blind('item2', 'Jalousie Terrasse', 'Wohnzimmer', travel),
      blind('item3', 'Jalousie Küche', 'Küche', travel),
      blind('item4', 'Jalousie Esszimmer', 'Esszimmer', travel),
      blind('item5', 'Jalousie Schlafzimmer', 'Schlafzimmer', travel),
      blind('item6', 'Jalousie Kinderzimmer', 'Kinderzimmer', travel),
      blind('item7', 'Jalousie Bad', 'Bad', travel),
      blind('item8', 'Jalousie Büro', 'Büro', travel),
    );
    this.blinds[5]!.position = 100;
    this.blinds[5]!.tilt = 100;
    this.blinds[7]!.position = 60;
    this.blinds[7]!.tilt = 45;
    this.systems.set('blinds', {
      spec: SPECS.blinds,
      elements: [
        ...this.blinds,
        {
          key: 'group0',
          name: 'Alle Jalousien',
          read: () => String(this.blindGroupState),
          write: (value, now) => {
            if (value !== '2' && value !== '-2') return 400;
            this.blindGroupState = value === '2' ? 1 : -1;
            for (const member of this.blinds) member.write!(value, now);
            return 200;
          },
        },
      ],
    });

    this.loads.push(
      load('item0', 'Steckdose Terrasse', 'Außen'),
      load('item1', 'Gartenpumpe', 'Außen'),
      load('item2', 'Lüfter Bad', 'Bad'),
      load('item3', 'Steckdose Fernseher', 'Wohnzimmer'),
      load('item4', 'Kaffeemaschine', 'Küche'),
    );
    this.loads[3]!.state = 2;
    const garden = () => this.loads.slice(0, 2);
    this.systems.set('loads', {
      spec: SPECS.loads,
      elements: [
        ...this.loads,
        {
          key: 'group0',
          name: 'Garten',
          read: (now) => (garden().some((member) => !member.read(now).startsWith('0')) ? '1' : '0'),
          write: (value, now) => {
            if (value !== '0' && value !== '2') return 400;
            for (const member of garden()) member.write!(value, now);
            return 200;
          },
        },
      ],
    });

    this.rooms.push(
      roomController('item0', 'Wohnzimmer', 21.4, 21.5, 46),
      roomController('item1', 'Küche', 20.8, 20.5, 51),
      roomController('item2', 'Esszimmer', 21.1, 21.0, 47),
      roomController('item3', 'Schlafzimmer', 18.2, 18.0, 55, true),
      roomController('item4', 'Kinderzimmer', 20.3, 21.0, 49, true),
      roomController('item5', 'Bad', 22.6, 23.0, 62),
      roomController('item6', 'Büro', 20.9, 21.0, 44),
    );
    this.systems.set('roomtemps', { spec: SPECS.roomtemps, elements: [...this.rooms, fixed('group0', 'Grp 1', undefined, '1', true)] });

    for (const [index, name] of [
      'Fenster Küche',
      'Fenster Bad',
      'Terrassentür',
      'Haustür',
      'Fenster Büro',
      'Garagentor',
      'Fenster Wohnzimmer',
      'Fenster Esszimmer',
      'Kellertür',
      'Dachfenster Flur',
    ].entries()) {
      this.logics.push(logic(`item${index}`, name, 'Türen und Fenster'));
    }
    // Contacts known only as inputs of one logic element: inputValue1_1 … inputValue6_2 are fields 13 … 24.
    const combined: SimElement = {
      key: 'item7',
      name: 'Logik 7',
      page: 'Logik',
      read: () => {
        const fields = new Array<number>(25).fill(0);
        this.logics.slice(0, 12).forEach((contact, index) => (fields[13 + index] = contact.value));
        fields[0] = this.logics.some((contact) => contact.value !== 0) ? 1 : 0;
        return `${fields.map(f2).join(';')};`;
      },
      write: (value) => (numberAfter(value, 'S') === null ? 400 : 200),
    };
    this.systems.set('alarms_logics', {
      spec: SPECS.alarms_logics,
      elements: [
        ...(this.contactStyle === 'unnamed' ? [combined] : this.logics),
        // Ordinary logics that are no contacts.
        logic('item20', 'Heizung Sommerbetrieb', 'Heizung'),
        logic('item21', 'Beschattung Süd', '...'),
        fixed('group0', 'Grp 1', undefined, '1'),
      ],
    });

    this.systems.set('accessdoors', {
      spec: SPECS.accessdoors,
      elements: [
        {
          key: 'item0',
          name: 'Gartentor',
          page: 'Außen',
          // accessType 1 = gate control.
          read: () => `${this.gate.open ? 1 : 0};0;${this.gate.open ? 1 : 0};${this.gate.open ? 100 : 0};1;`,
          write: (value) => {
            if (!['-3', '-2', '-1', '1', '2'].includes(value)) return 400;
            if (value === '1' || value === '2') this.gate.open = true;
            if (value === '-2' || value === '-1') this.gate.open = false;
            return 200;
          },
        },
        fixed('group0', 'Grp 1', undefined, '0'),
      ],
    });

    this.systems.set('alarmsystem', {
      spec: SPECS.alarmsystem,
      elements: [
        {
          key: 'item0',
          name: 'Alarmanlage',
          page: '...',
          extra: { zone1: 'Hülle' },
          read: () => {
            const { armed, triggered } = this.alarm;
            const zoneAlarm = triggered ? 3 : !armed && this.zoneBreached() ? 2 : 0;
            // One zone: alarmState; deviceStatus; sharpState; alarmState of the zone; deviceModel.
            return `${triggered ? 1 : 0};1;${armed ? 1 : 0};${zoneAlarm};1;`;
          },
          write: (value) => {
            if (value !== '1' && value !== '2') return 400;
            // Only zone 1 exists; it cannot be armed while a contact is open.
            return value === '1' && this.arm() ? 200 : 444;
          },
        },
        fixed('group0', 'Grp 1', undefined, '0', true),
      ],
    });

    const action = (key: string, name: string, effect: (now: number) => void): SimElement => {
      let runningUntil = 0;
      return {
        key,
        name,
        page: '...',
        read: (now) => `${now < runningUntil ? 1 : 0};1;0;`,
        write: (value, now) => {
          if (value === '-1') runningUntil = 0;
          else if (value === '1' || (value === 'T' && now >= runningUntil)) {
            runningUntil = now + 2000;
            effect(now);
          } else if (value === 'T') runningUntil = 0;
          else return 400;
          return 200;
        },
      };
    };
    const lightsOff = () => this.lights.forEach((l) => (l.on = false));
    const byName = (name: string) => this.lights.find((l) => l.name === name)!;
    this.systems.set('actions', {
      spec: SPECS.actions,
      elements: [
        action('item0', 'Alles aus', () => {
          lightsOff();
          this.loads.forEach((l) => (l.state = 0));
        }),
        action('item1', 'Gute Nacht', (now) => {
          lightsOff();
          for (const b of this.blinds) b.write!('-2', now);
          this.blindGroupState = -1;
        }),
        action('item2', 'Kommen', () => {
          byName('Flur').on = true;
        }),
        action('item3', 'Gehen', lightsOff),
        action('item4', 'Kino', (now) => {
          byName('Wohnzimmer Decke').on = false;
          Object.assign(byName('Stehlampe'), { on: true, dim: 20 });
          byName('LED-Band').on = true;
          for (const b of this.blinds.filter((candidate) => candidate.page === 'Wohnzimmer')) b.write!('-2', now);
        }),
        action('item5', 'Lüften', () => {
          this.loads.find((l) => l.name === 'Lüfter Bad')!.state = 2;
        }),
        fixed('group0', 'Grp 1', undefined, '0'),
      ],
    });

    const clock = (key: string, name: string, page: string, initial: number): SimElement => {
      let state = initial;
      return {
        key,
        name,
        page,
        read: () => `${state};1;0;`,
        write: (value) => {
          if (!['0', '1', '2'].includes(value)) return 400;
          state = Number(value);
          return 200;
        },
      };
    };
    this.systems.set('clocks', {
      spec: SPECS.clocks,
      elements: [clock('item0', 'Gartenbewässerung', 'Außen', 1), clock('item1', 'Außenlicht', 'Außen', 1), clock('item2', 'Zirkulation', '...', 0), fixed('group0', 'Grp 1', undefined, '1')],
    });

    this.systems.set('energycosts', {
      spec: SPECS.energycosts,
      elements: [
        {
          key: 'item0',
          name: 'Stromzähler',
          page: '...',
          read: (now) => {
            // Base load plus what is switched on, so the value moves with the house.
            const power = 0.32 + this.lights.filter((l) => l.on).length * 0.04 + this.loads.filter((l) => !l.read(now).startsWith('0')).length * 0.35;
            return `${f2(power)};6.40;212.70;18342.60;10.00;kWh;kW;1.10;1.90;2.30;1.10;1.20;2.10;2.60;1.80;0;4120.30;9310.80;01.01.2024 00:00:00;0;;;;;-0.00;-0.00;-0.00;0.00;0.00;0.00;-0.00;-0.00;-0.00;;;`;
          },
          write: (value) => (value === 'RP' ? 200 : 400),
        },
        {
          key: 'item1',
          name: 'Photovoltaik',
          page: '...',
          read: () => '2.41;9.80;301.20;22107.40;8.00;kWh;kW;0.00;3.10;5.60;1.10;0.00;2.90;5.20;0.90;0;5230.10;11872.00;01.01.2024 00:00:00;1;;;;;-0.00;-0.00;-0.00;0.00;0.00;0.00;-0.00;-0.00;-0.00;;;',
          write: (value) => (value === 'RP' ? 200 : 400),
        },
        fixed('group0', 'Grp 1', undefined, '1'),
      ],
    });

    // The trend logs two contacts by name — not in the `unnamed` household.
    const logged: SimElement = {
      key: 'item0',
      name: 'Kontakte Erdgeschoss',
      page: '...',
      // Two digital inputs (type 1 = dIn) are logged: variable n value sits at field 3 + 5·(n−1).
      read: () => `1;1;Fenster Kueche;${f2(this.logicByName('Fenster Küche').value)};;1;1;Haustuer;${f2(this.logicByName('Haustür').value)};;0;0;;0.00;;0;0;;0.00;;0;`,
      write: (value) => (numberAfter(value, 'S') === null ? 400 : 200),
    };
    this.systems.set('trends', {
      spec: SPECS.trends,
      elements: [
        ...(this.contactStyle === 'unnamed' ? [] : [logged]),
        fixed('group0', 'Grp 1', undefined, '1'),
      ],
    });

    // Systems the hub does not map yet.
    this.systems.set('vents', {
      spec: SPECS.vents,
      elements: [fixed('item0', 'Wohnraumlüftung', '...', '2;5;2;0;4;46.00;;781.00;20.00;22.00;9.10;10.70;50.00;50.00;0;0;1;0;0;', true), fixed('group0', 'Grp 1', undefined, '1', true)],
    });
    this.systems.set('hotwater_systems', {
      spec: SPECS.hotwater_systems,
      elements: [fixed('item0', 'Warmwasser', '...', '3;0;48.00;48.70;48.00;60.00;0;0;', true), fixed('group0', 'Grp 1', undefined, '0')],
    });
  }

  private logicByName(name: string): LogicContact {
    return this.logics.find((l) => l.name === name)!;
  }

  /** Detectors of the zone "Hülle": the reed contacts and the windows wired to room controllers. */
  private zoneBreached(): boolean {
    return this.logics.some((l) => l.value !== 0) || this.rooms.some((room) => room.windowOpen);
  }

  // --- Handles --------------------------------------------------------------------

  contactNames(): string[] {
    return [...this.logics.map((l) => l.name), ...this.rooms.filter((room) => room.hasWindowContact).map((room) => `Fenster ${room.name}`), 'Gartentor'];
  }

  private contact(name: string): { get(): boolean; set(open: boolean): void; inZone: boolean } {
    const reed = this.logics.find((l) => l.name === name);
    if (reed) return { get: () => reed.value !== 0, set: (open) => (reed.value = open ? 1 : 0), inZone: true };
    const room = this.rooms.find((candidate) => candidate.hasWindowContact && `Fenster ${candidate.name}` === name);
    if (room) return { get: () => room.windowOpen, set: (open) => (room.windowOpen = open), inZone: true };
    if (name === 'Gartentor') return { get: () => this.gate.open, set: (open) => (this.gate.open = open), inZone: false };
    throw new Error(`myGEKKO simulator: unknown contact "${name}" (known: ${this.contactNames().join(', ')})`);
  }

  setContact(name: string, open: boolean): void {
    const contact = this.contact(name);
    contact.set(open);
    if (open && contact.inZone && this.alarm.armed) this.alarm.triggered = true;
  }

  isContactOpen(name: string): boolean {
    return this.contact(name).get();
  }

  arm(): boolean {
    if (this.zoneBreached()) return false;
    this.alarm.armed = true;
    return true;
  }

  disarm(): void {
    this.alarm.armed = false;
    this.alarm.triggered = false;
  }

  async setOffline(offline: boolean): Promise<void> {
    if (offline === this.offline) return;
    this.offline = offline;
    if (offline) await this.unlisten();
    else await this.listen(this.port);
  }

  setStalled(stalled: boolean): void {
    this.stalled = stalled;
    if (!stalled) {
      for (const res of this.stalledResponses) res.destroy();
      this.stalledResponses.clear();
    }
  }

  setCredentials(username: string, password: string): void {
    this.username = username;
    this.password = password;
  }

  failNext(status: number, count = 1): void {
    this.failing = count > 0 ? { status, count } : null;
  }

  private element(system: string, key: string): SimElement {
    const element = this.systems.get(system)?.elements.find((candidate) => candidate.key === key);
    if (!element) throw new Error(`myGEKKO simulator: no element ${system}/${key}`);
    return element;
  }

  sumstate(system: string, element: string): string {
    return this.element(system, element).read(Date.now());
  }

  find(system: string, name: string): string {
    const element = this.systems.get(system)?.elements.find((candidate) => candidate.name === name);
    if (!element) throw new Error(`myGEKKO simulator: no element named "${name}" in ${system}`);
    return element.key;
  }

  setMeteo(key: MeteoKey, value: number): void {
    this.meteo[key] = value;
  }

  setRoomTemperature(name: string, temperature: number): void {
    const room = this.rooms.find((candidate) => candidate.name === name);
    if (!room) throw new Error(`myGEKKO simulator: no room controller "${name}"`);
    room.temperature = temperature;
  }

  lockBlind(name: string, locked: boolean): void {
    const target = this.blinds.find((candidate) => candidate.name === name);
    if (!target) throw new Error(`myGEKKO simulator: no blind "${name}"`);
    target.locked = locked;
  }

  addLight(name: string, page: string): string {
    const numbers = this.lights.map((l) => Number(l.key.slice(4)));
    const added = light(`item${Math.max(...numbers) + 1}`, name, page);
    this.lights.push(added);
    const elements = this.systems.get('lights')!.elements;
    // Elements come before the groups, as in the controller's own listing.
    elements.splice(elements.findIndex((candidate) => candidate.key.startsWith('group')), 0, added);
    return added.key;
  }

  rename(system: string, element: string, name: string): void {
    this.element(system, element).name = name;
  }

  // --- Documents ------------------------------------------------------------------

  private treeDocument(): Record<string, unknown> {
    const tree: Record<string, unknown> = { globals: GLOBALS_TREE };
    for (const [name, system] of this.systems) {
      const { spec } = system;
      const node: Record<string, unknown> = {};
      for (const element of system.elements) {
        const number = Number(element.key.replace(/^\D+/, ''));
        if (element.key.startsWith('group')) {
          const index = spec.index * 10 + number * 100;
          node[element.key] = {
            name: element.name,
            sumstate: { description: 'Summary of the group states and their formats', format: spec.groupSumstate, type: 'AO', permission: 'READ', index },
            ...(spec.groupScmd
              ? { scmd: { description: 'Summary of the group commands and their formats', format: spec.groupScmd, type: 'AV', permission: 'WRITE', index: index + 1 } }
              : {}),
          };
        } else {
          node[element.key] = {
            name: element.name,
            page: element.page ?? '...',
            ...element.extra,
            sumstate: { description: 'Summary of the states and their formats', format: spec.sumstate, type: 'STRING', permission: 'READ' },
            ...(spec.scmd
              ? {
                  scmd: {
                    description: 'Summary of the commands and their formats',
                    format: spec.scmd,
                    type: 'STRING',
                    permission: 'WRITE',
                    index: spec.index + number * 100 + 70,
                  },
                }
              : {}),
          };
        }
      }
      tree[name] = node;
    }
    return tree;
  }

  private globalsStatus(): Record<string, unknown> {
    const meteo: Record<string, { value: string }> = {};
    for (const [key, value] of Object.entries(this.meteo)) meteo[key] = { value: value.toFixed(6) };
    return {
      network: {
        gekkoname: { value: this.gekkoName },
        language: { value: '0' },
        version: { value: '879015' },
        hardware: { value: 'Slide 2 (AC0DFE30D3A0)' },
      },
      alarm: { sumstate: { value: this.alarm.triggered ? '3' : '0' } },
      meteo,
    };
  }

  private systemStatus(system: SimSystem, now: number, withValues = true): Record<string, unknown> {
    const node: Record<string, unknown> = {};
    for (const element of system.elements) node[element.key] = { sumstate: { value: withValues ? element.read(now) : '' } };
    return node;
  }

  private statusDocument(now: number): Record<string, unknown> {
    const complete = this.incompleteAnswers <= 0;
    if (!complete) this.incompleteAnswers--;
    const status: Record<string, unknown> = { globals: complete ? this.globalsStatus() : { network: { gekkoname: { value: this.gekkoName } } } };
    for (const [name, system] of this.systems) status[name] = this.systemStatus(system, now, complete);
    return status;
  }

  // --- HTTP -----------------------------------------------------------------------

  private authorize(query: URLSearchParams, now: number): 200 | 403 | 410 {
    const secret = this.cloud ? query.get('key') : query.get('password');
    const expected = this.cloud ? this.cloud.key : this.password;
    const valid = query.get('username') === this.username && secret === expected;
    if (now < this.lockedUntil || !valid) {
      this.forbiddenCount++;
      if (!valid && this.lockout && ++this.wrongLogins >= this.lockout.attempts) this.lockedUntil = now + this.lockout.durationMs;
      return 403;
    }
    this.wrongLogins = 0;
    // The cloud knows the account but not this controller (or the controller is offline).
    if (this.cloud && query.get('gekkoid') !== this.cloud.gekkoId) return 410;
    return 200;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.stalled) {
      this.stalledResponses.add(res);
      res.once('close', () => this.stalledResponses.delete(res));
      return;
    }
    const send = (status: number, body?: unknown) => {
      if (body === undefined) {
        res.writeHead(status, { 'Content-Length': '0' }).end();
      } else if (typeof body === 'string') {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
      }
    };

    const url = new URL(req.url ?? '/', 'http://simulator');
    const path = url.pathname.replace(/\/+$/, '');
    const match = /^\/api\/v1\/var(?:\/(.*))?$/.exec(path);
    if (!match) {
      this.requests.other++;
      return send(404);
    }
    const segments = (match[1] ?? '').split('/').filter(Boolean).map(decodeURIComponent);
    const isCommand = segments.length === 4 && segments[2] === 'scmd' && segments[3] === 'set';
    const kind = isCommand ? 'command' : segments.length === 0 ? 'tree' : segments.length === 1 && segments[0] === 'status' ? 'status' : 'other';
    this.requests[kind]++;

    const now = Date.now();
    // Recorded with the status that is finally sent, so tests can also see rejected commands.
    const answer = (status: number, body?: unknown) => {
      if (isCommand) this.commands.push({ system: segments[0]!, element: segments[1]!, value: url.searchParams.get('value') ?? '', status });
      send(status, body);
    };

    // Every call of the Query API is a GET, commands included.
    if (req.method !== 'GET') return answer(405);
    if (this.failing) {
      const { status } = this.failing;
      if (--this.failing.count <= 0) this.failing = null;
      return answer(status);
    }
    const access = this.authorize(url.searchParams, now);
    if (access !== 200) return answer(access);

    if (kind === 'tree') return answer(200, this.treeDocument());
    if (kind === 'status') return answer(200, this.statusDocument(now));

    const system = this.systems.get(segments[0] ?? '');
    if (!system) return answer(404);
    if (segments.length === 1) return answer(200, (this.treeDocument()[segments[0]!] as Record<string, unknown>) ?? {});
    if (segments.length === 2 && segments[1] === 'status') return answer(200, this.systemStatus(system, now));
    const element = system.elements.find((candidate) => candidate.key === segments[1]);
    if (!element) return answer(404);
    if (segments.length === 3 && segments[2] === 'status') return answer(200, { sumstate: { value: element.read(now) } });
    if (!isCommand) return answer(404);

    const writable = element.key.startsWith('group') ? system.spec.groupScmd !== null : system.spec.scmd !== null;
    if (!writable || !element.write) return answer(405);
    const value = url.searchParams.get('value');
    if (value === null || value === '') return answer(400);
    const status = element.write(value, now);
    return answer(status, status === 200 ? 'OK' : undefined);
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private unlisten(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
      for (const res of this.stalledResponses) res.destroy();
      this.stalledResponses.clear();
      for (const socket of this.sockets) socket.destroy();
    });
  }

  async close(): Promise<void> {
    this.offline = true;
    await this.unlisten();
  }
}

/** Starts a simulated myGEKKO on 127.0.0.1. */
export async function startMyGekkoSim(options: MyGekkoSimOptions = {}): Promise<MyGekkoSim> {
  const simulator = new Simulator(options);
  await simulator.listen(options.port ?? 0);
  return simulator;
}
