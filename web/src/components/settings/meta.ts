import { Building2, Cctv, DoorClosed, Music2, SlidersHorizontal, Speaker, type LucideIcon } from 'lucide-react';
import type { IntegrationSettingsMap, ServiceId, SettingsKey } from '@home-hub/shared';
import type { Tone } from '../ui.tsx';

export interface Area {
  key: SettingsKey;
  title: string;
  purpose: string;
  icon: LucideIcon;
  tone: Tone;
  /** The live service this area configures (none for the general settings). */
  service: ServiceId | null;
  testable: boolean;
}

/** The areas an administrator sets up — vendor names appear here (and only here) because this is where they matter. */
export const AREAS: Area[] = [
  { key: 'general', title: 'Allgemein', purpose: 'Name deines Zuhauses und Regeln für die Anmeldung', icon: SlidersHorizontal, tone: 'accent', service: null, testable: false },
  { key: 'mygekko', title: 'Gebäude (myGEKKO)', purpose: 'Licht, Jalousien, Heizung, Szenen, Fenster- und Türkontakte', icon: Building2, tone: 'warm', service: 'mygekko', testable: true },
  { key: 'doorbird', title: 'Türstationen (DoorBird)', purpose: 'Klingel, Gegensprechen, Türöffner und Verlauf', icon: DoorClosed, tone: 'ok', service: 'doorbird', testable: true },
  { key: 'reolink', title: 'Kameras (Reolink)', purpose: 'Live-Bild, Schwenken und Gegensprechen', icon: Cctv, tone: 'cool', service: 'reolink', testable: true },
  { key: 'sonos', title: 'Lautsprecher (Sonos)', purpose: 'Musik in allen Räumen', icon: Speaker, tone: 'music', service: 'sonos', testable: true },
  { key: 'spotify', title: 'Spotify', purpose: 'Suchen und Stöbern in deiner Musik', icon: Music2, tone: 'music', service: 'spotify', testable: true },
];

export function areaOf(key: string | undefined): Area | null {
  return AREAS.find((area) => area.key === key) ?? null;
}

export interface FormProps<K extends SettingsKey> {
  value: IntegrationSettingsMap[K];
  /** What the hub has stored (secrets masked). */
  saved: IntegrationSettingsMap[K];
  onChange(next: IntegrationSettingsMap[K]): void;
  /** Runs a connection test with the given (unsaved) settings. */
  test(value: IntegrationSettingsMap[K]): Promise<import('@home-hub/shared').TestResult>;
  /** True while the settings on the hub differ from the form. */
  dirty: boolean;
  /** Saves the form; resolves to false when the hub rejected it. */
  save(): Promise<boolean>;
}
