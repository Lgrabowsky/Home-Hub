import {
  Blinds,
  CalendarClock,
  Camera,
  CloudRain,
  DoorClosed,
  DoorOpen,
  Droplets,
  Fan,
  Gauge,
  Lightbulb,
  LampCeiling,
  PlayCircle,
  Plug,
  Power,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Thermometer,
  Warehouse,
  Wind,
  Zap,
  Bell,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react';
import type { ContactEntity, Entity, SensorEntity, SwitchEntity } from '@home-hub/shared';

export function switchIcon(entity: SwitchEntity): LucideIcon {
  switch (entity.variant) {
    case 'socket':
      return Plug;
    case 'fan':
      return Fan;
    case 'pump':
      return Droplets;
    default:
      return Power;
  }
}

export function sensorIcon(entity: SensorEntity): LucideIcon {
  switch (entity.sensorType) {
    case 'temperature':
      return Thermometer;
    case 'humidity':
      return Droplets;
    case 'wind':
      return Wind;
    case 'brightness':
      return Sun;
    case 'rain':
      return CloudRain;
    case 'power':
    case 'energy':
      return Zap;
    default:
      return Gauge;
  }
}

export function contactIcon(entity: ContactEntity): LucideIcon {
  if (entity.contactType === 'garage') return Warehouse;
  if (entity.contactType === 'door') return entity.open ? DoorOpen : DoorClosed;
  return entity.open ? SquareDashed : ShieldCheck;
}

export function entityIcon(entity: Entity): LucideIcon {
  switch (entity.kind) {
    case 'light':
      return entity.isGroup ? LampCeiling : Lightbulb;
    case 'blind':
      return Blinds;
    case 'switch':
      return switchIcon(entity);
    case 'climate':
      return Thermometer;
    case 'action':
      return PlayCircle;
    case 'clock':
      return CalendarClock;
    case 'contact':
      return contactIcon(entity);
    case 'alarm':
      return entity.triggered || entity.breached ? ShieldAlert : ShieldCheck;
    case 'sensor':
      return sensorIcon(entity);
    case 'camera':
      return Camera;
    case 'door':
      return Bell;
  }
}
