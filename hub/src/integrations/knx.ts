import type { ContactEntity, KnxSettings, KnxTelegramInfo, KnxTelegramsResponse, TestResult } from '@home-hub/shared';
import { describeError } from '../util/http.ts';
import { KnxRouting, KnxTunnel, type KnxLink, type LinkStatus } from './knx/link.ts';
import { formatGroupAddress, formatIndividualAddress, parseGroupAddress, type GroupTelegram } from './knx/protocol.ts';
import type { Integration, IntegrationDeps } from './types.ts';

/**
 * Window and door contacts straight from the KNX bus.
 *
 * Many installations report the magnet contacts only to the alarm system of
 * the building controller, which does not hand them out one by one. On the
 * KNX bus each contact has its group address; the hub listens there (through
 * a KNX IP interface or router), asks every known contact for its state when
 * it connects, and keeps the last telegrams so an administrator can find out
 * which address belongs to which window ("Kontakt suchen").
 *
 * The hub only listens and asks (GroupValue_Read); it never switches anything
 * on the bus.
 */

const OWNER = 'knx';
const TELEGRAM_BUFFER = 400;
/** Gap between the read requests after connecting, to keep the bus calm. */
const READ_GAP_MS = 120;
/** States are asked for again now and then, in case a telegram was missed. */
const REFRESH_MS = 30 * 60_000;

export class KnxIntegration implements Integration {
  private link: KnxLink | null = null;
  private readonly telegrams: KnxTelegramInfo[] = [];
  /** Last known state per group address (true = 1). */
  private readonly values = new Map<number, { value: boolean; at: number | null }>();
  private readonly contacts: { setting: KnxSettings['contacts'][number]; address: number }[];
  private refresh: NodeJS.Timeout | null = null;
  private readsRunning = false;
  private telegramCount = 0;

  constructor(
    private readonly deps: IntegrationDeps,
    private readonly settings: KnxSettings,
    /** Tests and the demo: a link of their own. */
    private readonly makeLink?: () => KnxLink,
  ) {
    this.contacts = settings.contacts
      .map((setting) => ({ setting, address: parseGroupAddress(setting.address) }))
      .filter((entry): entry is { setting: KnxSettings['contacts'][number]; address: number } => entry.address !== null);
  }

  start(): void {
    const { state, log } = this.deps;
    state.setService('knx', 'starting', 'Verbinde mit dem KNX-Bus …');
    this.publish();
    const link = this.makeLink?.() ?? (this.settings.mode === 'routing' ? new KnxRouting(log) : new KnxTunnel(this.settings.host, this.settings.port, log));
    this.link = link;
    link.on('status', (status) => this.onStatus(status));
    link.on('telegram', (telegram) => this.onTelegram(telegram));
    link.start();
    this.refresh = setInterval(() => void this.readAll(), REFRESH_MS);
    this.refresh.unref();
  }

  async stop(): Promise<void> {
    if (this.refresh) clearInterval(this.refresh);
    await this.link?.stop();
    this.link = null;
  }

  setActive(): void {
    /* Telegrams arrive by themselves; nothing to poll. */
  }

  private onStatus(status: LinkStatus): void {
    this.deps.state.setService('knx', status.connected ? 'ok' : 'offline', status.message);
    if (status.connected) void this.readAll();
    else this.publish();
  }

  /** Asks every known contact for its state (the devices answer with a GroupValue_Response). */
  private async readAll(): Promise<void> {
    if (this.readsRunning || !this.link?.status.connected) return;
    this.readsRunning = true;
    try {
      for (const address of new Set(this.contacts.map((contact) => contact.address))) {
        if (!this.link?.status.connected) break;
        await this.link.read(address).catch((err: unknown) => this.deps.log.debug({ err: describeError(err), address: formatGroupAddress(address) }, 'KNX read failed'));
        await new Promise((resolve) => setTimeout(resolve, READ_GAP_MS));
      }
    } finally {
      this.readsRunning = false;
    }
  }

  private onTelegram(telegram: GroupTelegram): void {
    this.telegramCount++;
    this.telegrams.push({
      ts: Date.now(),
      source: formatIndividualAddress(telegram.source),
      address: formatGroupAddress(telegram.destination),
      service: telegram.service,
      value: telegram.small,
      data: telegram.data.toString('hex'),
    });
    if (this.telegrams.length > TELEGRAM_BUFFER) this.telegrams.splice(0, this.telegrams.length - TELEGRAM_BUFFER);
    if (telegram.service === 'read') return;
    // A contact sends one bit; a longer value on the same address is not a contact state.
    const bit = telegram.small !== null ? telegram.small !== 0 : telegram.data.length === 1 ? telegram.data[0] !== 0 : null;
    if (bit === null) return;
    const before = this.values.get(telegram.destination);
    // An answer to the hub's question says how it is, not since when.
    const at = before ? (before.value === bit ? before.at : Date.now()) : telegram.service === 'write' ? Date.now() : null;
    this.values.set(telegram.destination, { value: bit, at });
    if (this.contacts.some((contact) => contact.address === telegram.destination)) this.publish();
  }

  private publish(): void {
    const connected = this.link?.status.connected ?? false;
    const entities: ContactEntity[] = this.contacts.map(({ setting, address }) => {
      const known = this.values.get(address);
      const open = known ? known.value !== setting.invert : false;
      return {
        id: `knx:${setting.id}`,
        kind: 'contact',
        name: setting.name,
        room: setting.room || null,
        // Unknown until the contact answered or reported once.
        available: connected && known !== undefined,
        service: 'knx',
        open,
        contactType: setting.contactType,
        zone: null,
        fault: false,
        changedAt: known?.at ?? null,
        linkedEntityId: null,
      };
    });
    this.deps.state.replace(OWNER, entities);
  }

  /** The last telegrams, newest last (administrators: finding contacts). */
  recentTelegrams(since = 0): KnxTelegramsResponse {
    const status = this.link?.status;
    return { connected: status?.connected ?? false, message: status?.message ?? '', telegrams: this.telegrams.filter((telegram) => telegram.ts > since) };
  }

  diagnostics(): unknown {
    const status = this.link?.status;
    return {
      mode: this.settings.mode,
      host: this.settings.mode === 'tunnel' ? `${this.settings.host}:${this.settings.port}` : 'multicast',
      connected: status?.connected ?? false,
      message: status?.message ?? null,
      address: status?.address ?? null,
      contacts: this.contacts.length,
      contactsKnown: this.contacts.filter((contact) => this.values.has(contact.address)).length,
      telegrams: this.telegramCount,
    };
  }

  /** Connects once and reports what happened (settings page). */
  static async test(settings: KnxSettings, makeLink?: () => KnxLink): Promise<TestResult> {
    const noop = () => undefined;
    const log = { info: noop, warn: noop, debug: noop, error: noop, child: () => log } as unknown as IntegrationDeps['log'];
    const link = makeLink?.() ?? (settings.mode === 'routing' ? new KnxRouting(log) : new KnxTunnel(settings.host, settings.port, log));
    try {
      const status = await new Promise<LinkStatus>((resolve) => {
        const timer = setTimeout(() => resolve(link.status), 12_000);
        link.on('status', (next) => {
          clearTimeout(timer);
          resolve(next);
        });
        link.start();
      });
      if (!status.connected) return { ok: false, message: status.message, details: [] };
      if (settings.mode === 'routing') {
        // Listening alone proves nothing: wait a moment for traffic of the router.
        let seen = 0;
        link.on('telegram', () => seen++);
        await new Promise((resolve) => setTimeout(resolve, 4000));
        return seen > 0
          ? { ok: true, message: `Der Hub hört den KNX-Bus mit (${seen} Telegramme in 4 Sekunden).`, details: [] }
          : { ok: false, message: 'Im Netz war in 4 Sekunden kein KNX-Telegramm zu hören. Gibt es einen KNX IP-Router, und ist Routing an ihm eingeschaltet?', details: [] };
      }
      return { ok: true, message: `Verbunden mit der KNX-Schnittstelle ${settings.host}.`, details: status.address ? [`Adresse des Hubs am Bus: ${status.address}`] : [] };
    } finally {
      await link.stop();
    }
  }
}
