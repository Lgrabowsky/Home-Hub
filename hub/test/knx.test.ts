import { afterEach, describe, expect, it } from 'vitest';
import type { ContactEntity, KnxSettings, KnxTelegramsResponse, LoginResponse } from '@home-hub/shared';
import { KnxIntegration } from '../src/integrations/knx.ts';
import { KnxRouting, KnxTunnel, searchInterfaces, type LinkStatus } from '../src/integrations/knx/link.ts';
import {
  MESSAGE_CODE,
  SERVICE,
  formatGroupAddress,
  formatIndividualAddress,
  frame,
  groupReadCemi,
  groupValueCemi,
  parseCemi,
  parseFrame,
  parseGroupAddress,
  parseIndividualAddress,
} from '../src/integrations/knx/protocol.ts';
import { createLogger } from '../src/log.ts';
import { startKnxSim, type KnxSim } from '../src/sim/knx-sim.ts';
import { createTestDeps, type TestDeps } from './deps.ts';
import { Client, createTestHub, setupAdmin, type TestHub } from './helpers.ts';

const log = createLogger('silent');
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sim(options: Partial<Parameters<typeof startKnxSim>[0]> = {}): Promise<KnxSim> {
  const started = await startKnxSim({
    contacts: [
      { address: '1/1/1', name: 'Fenster Bad' },
      { address: '1/1/2', name: 'Kellerfenster', invert: true },
      { address: '1/1/3', name: 'Fenster Flur' },
    ],
    ...options,
  });
  cleanups.push(() => started.close());
  return started;
}

const until = async (check: () => boolean, timeoutMs = 8000) => {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('KNXnet/IP protocol', () => {
  it('reads and writes group and individual addresses', () => {
    expect(parseGroupAddress('1/2/3')).toBe((1 << 11) | (2 << 8) | 3);
    expect(formatGroupAddress(parseGroupAddress('31/7/255')!)).toBe('31/7/255');
    expect(formatGroupAddress(parseGroupAddress('1/515')!)).toBe('1/2/3');
    for (const wrong of ['32/0/0', '1/8/0', '1/2/256', '1-2-3', '', 'a/b/c']) expect(parseGroupAddress(wrong)).toBeNull();
    expect(formatIndividualAddress(parseIndividualAddress('1.1.250')!)).toBe('1.1.250');
    expect(parseIndividualAddress('16.0.1')).toBeNull();
  });

  it('builds a GroupValue_Read exactly as the standard says and understands group telegrams', () => {
    expect(groupReadCemi(parseGroupAddress('1/1/1')!).toString('hex')).toBe('1100bce00000090101' + '0000');
    const write = parseCemi(groupValueCemi(parseGroupAddress('1/1/1')!, 1, 'write', MESSAGE_CODE.L_DATA_IND, parseIndividualAddress('1.1.12')!));
    expect(write).toMatchObject({ service: 'write', small: 1, destination: parseGroupAddress('1/1/1'), source: parseIndividualAddress('1.1.12') });
    const response = parseCemi(groupValueCemi(parseGroupAddress('1/1/2')!, 0, 'response'));
    expect(response).toMatchObject({ service: 'response', small: 0 });
    expect(parseCemi(groupReadCemi(5))).toMatchObject({ service: 'read', small: null });
    // A telegram to an individual address is not a group telegram.
    const individual = groupReadCemi(5);
    individual.writeUInt8(0x60, 3);
    expect(parseCemi(individual)).toBeNull();
    expect(parseFrame(frame(SERVICE.ROUTING_INDICATION, Buffer.from([1, 2, 3])))).toEqual({ service: SERVICE.ROUTING_INDICATION, body: Buffer.from([1, 2, 3]) });
    expect(parseFrame(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it('listens to a router and ignores its own read requests', () => {
    const routing = new KnxRouting(log, parseIndividualAddress('15.15.250')!);
    const seen: number[] = [];
    routing.on('telegram', (telegram) => seen.push(telegram.destination));
    routing.handle(frame(SERVICE.ROUTING_INDICATION, groupValueCemi(7, 1, 'write')));
    routing.handle(frame(SERVICE.ROUTING_INDICATION, groupReadCemi(8, MESSAGE_CODE.L_DATA_IND, parseIndividualAddress('15.15.250')!)));
    routing.handle(frame(SERVICE.TUNNELLING_REQUEST, groupValueCemi(9, 1, 'write')));
    expect(seen).toEqual([7]);
  });
});

describe('KNX tunnel', () => {
  it('connects, asks for states, hears changes, and comes back after the interface dropped it', async () => {
    const bus = await sim();
    const tunnel = new KnxTunnel(bus.host, bus.port, log);
    cleanups.push(() => tunnel.stop());
    const statuses: LinkStatus[] = [];
    const heard: string[] = [];
    tunnel.on('status', (status) => statuses.push(status));
    tunnel.on('telegram', (telegram) => heard.push(`${telegram.service} ${formatGroupAddress(telegram.destination)}=${telegram.small}`));
    tunnel.start();
    await until(() => tunnel.status.connected);
    expect(tunnel.status.address).toBe('1.1.251');

    await tunnel.read(parseGroupAddress('1/1/2')!);
    await until(() => heard.includes('response 1/1/2=1'));
    expect(bus.reads).toEqual(['1/1/2']);

    bus.setContact('Fenster Bad', true);
    await until(() => heard.includes('write 1/1/1=1'));

    bus.dropConnections();
    await until(() => !tunnel.status.connected);
    expect(tunnel.status.message).toBe('Die KNX-Schnittstelle hat die Verbindung beendet.');
    await until(() => tunnel.status.connected);
    bus.setContact('Fenster Bad', false);
    await until(() => heard.includes('write 1/1/1=0'));
  });

  it('says when the interface has no free tunnel', async () => {
    const bus = await sim({ maxConnections: 0 });
    const tunnel = new KnxTunnel(bus.host, bus.port, log);
    cleanups.push(() => tunnel.stop());
    tunnel.start();
    await until(() => tunnel.status.message.includes('keine freie Verbindung'));
    expect(tunnel.status.connected).toBe(false);
  });

  it('finds the interface by the KNXnet/IP search', async () => {
    const bus = await sim();
    expect(await searchInterfaces(500, { host: bus.host, port: bus.port })).toEqual([
      { host: '127.0.0.1', port: bus.port, name: 'KNX IP Demo-Schnittstelle', address: '1.1.250', tunnelling: true, routing: false },
    ]);
  });
});

describe('KNX contacts', () => {
  function settings(bus: KnxSim): KnxSettings {
    return {
      enabled: true,
      mode: 'tunnel',
      host: bus.host,
      port: bus.port,
      contacts: [
        { id: 'bad', address: '1/1/1', name: 'Fenster Bad', room: 'Bad', contactType: 'window', invert: false },
        { id: 'keller', address: '1/1/2', name: 'Kellerfenster', room: 'Keller', contactType: 'window', invert: true },
      ],
    };
  }

  it('become contacts of the house: state asked at the start, every change, and the last telegrams for the search', async () => {
    const bus = await sim();
    bus.setContact('Kellerfenster', true);
    const t: TestDeps = createTestDeps();
    cleanups.push(() => t.cleanup());
    const knx = new KnxIntegration(t.deps, settings(bus));
    cleanups.push(() => knx.stop());
    const contact = (id: string) => t.state.get(`knx:${id}`) as ContactEntity | undefined;

    knx.start();
    expect(contact('bad')).toMatchObject({ available: false, name: 'Fenster Bad', room: 'Bad', service: 'knx' });
    await until(() => contact('bad')?.available === true && contact('keller')?.available === true);
    expect(t.state.getService('knx').status).toBe('ok');
    // Asked for, so not known since when.
    expect(contact('bad')).toMatchObject({ open: false, changedAt: null });
    // Sends 0 for open.
    expect(contact('keller')).toMatchObject({ open: true });
    expect(bus.reads.sort()).toEqual(['1/1/1', '1/1/2']);

    bus.setContact('Fenster Bad', true);
    await until(() => contact('bad')?.open === true);
    expect(contact('bad')!.changedAt).toBeGreaterThan(0);

    // A window nobody set up yet: only in the telegrams.
    bus.setContact('Fenster Flur', true);
    await until(() => knx.recentTelegrams().telegrams.some((telegram) => telegram.address === '1/1/3'));
    expect(knx.recentTelegrams().telegrams.at(-1)).toMatchObject({ address: '1/1/3', service: 'write', value: 1, source: '1.1.12' });
    expect(t.state.all().filter((entity) => entity.service === 'knx')).toHaveLength(2);

    bus.dropConnections();
    await until(() => t.state.getService('knx').status === 'offline');
    expect(contact('bad')!.available).toBe(false);
    await until(() => contact('bad')?.available === true);
  });

  it('are tested from the settings page', async () => {
    const bus = await sim();
    expect(await KnxIntegration.test(settings(bus))).toEqual({ ok: true, message: `Verbunden mit der KNX-Schnittstelle ${bus.host}.`, details: ['Adresse des Hubs am Bus: 1.1.251'] });
    const busy = await sim({ maxConnections: 0 });
    expect(await KnxIntegration.test(settings(busy))).toMatchObject({ ok: false, message: expect.stringContaining('keine freie Verbindung') });
  });
});

describe('KNX over the API', () => {
  let hub: TestHub | null = null;
  afterEach(async () => {
    await hub?.destroy();
    hub = null;
  });

  it('is set up by an administrator; only administrators see the bus traffic', async () => {
    const bus = await sim();
    hub = await createTestHub();
    const { client: admin } = await setupAdmin(hub);
    await hub.start();
    await admin.put('/api/admin/settings/general', { hubName: 'Zuhause', requireTotp: false, sessionDays: 30 });

    const wrong = await admin.put('/api/admin/settings/knx', { enabled: true, mode: 'tunnel', host: bus.host, port: bus.port, contacts: [{ id: 'x', address: '1/9/1', name: 'X', room: '', contactType: 'window', invert: false }] });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ message: expect.stringContaining('Gruppenadresse') });
    expect((await admin.put('/api/admin/settings/knx', { enabled: true, mode: 'tunnel', host: '', port: 3671, contacts: [] })).statusCode).toBe(400);

    const saved = await admin.put('/api/admin/settings/knx', { enabled: true, mode: 'tunnel', host: bus.host, port: bus.port, contacts: [{ id: 'bad', address: '1/257', name: 'Fenster Bad', room: 'Bad', contactType: 'window', invert: false }] });
    expect(saved.statusCode).toBe(200);
    // Written as main/middle/sub.
    expect((saved.json() as { value: KnxSettings }).value.contacts[0]!.address).toBe('1/1/1');

    const contact = async () => ((await admin.get('/api/state')).json() as { entities: Record<string, ContactEntity> }).entities['knx:bad'];
    await expect.poll(contact, { timeout: 8000 }).toMatchObject({ available: true, open: false });
    bus.setContact('Fenster Treppe', true);
    bus.setContact('Fenster Flur', true);
    await expect.poll(async () => ((await admin.get('/api/admin/knx/telegrams')).json() as KnxTelegramsResponse).telegrams.map((telegram) => telegram.address), { timeout: 8000 }).toContain('1/1/3');
    const since = Date.now();
    expect(((await admin.get(`/api/admin/knx/telegrams?since=${since + 60_000}`)).json() as KnxTelegramsResponse).telegrams).toEqual([]);

    await admin.post('/api/users', { username: 'mia', role: 'member', password: 'a long member password', permissions: ['security.view'] });
    const member = new Client(hub);
    expect(((await member.post('/api/auth/login', { username: 'mia', password: 'a long member password', client: 'web' })).json() as LoginResponse).status).toBe('ok');
    expect((await member.get('/api/admin/knx/telegrams')).statusCode).toBe(403);
    expect((await member.post('/api/admin/knx/search')).statusCode).toBe(403);
    // The contact itself is there for whoever may see windows and doors.
    expect(((await member.get('/api/state')).json() as { entities: Record<string, unknown> }).entities['knx:bad']).toBeTruthy();

    hub.ctx.knxSearchTarget = { host: bus.host, port: bus.port };
    expect(((await admin.post('/api/admin/knx/search')).json() as { interfaces: unknown[] }).interfaces).toHaveLength(1);
  });
});
