import { createSocket, type RemoteInfo } from 'node:dgram';
import {
  MESSAGE_CODE,
  SERVICE,
  formatGroupAddress,
  frame,
  groupValueCemi,
  hpai,
  parseCemi,
  parseConnectionHeader,
  parseFrame,
  parseGroupAddress,
  parseIndividualAddress,
  readHpai,
  tunnellingAck,
  tunnellingRequest,
} from '../integrations/knx/protocol.ts';

/**
 * A KNX IP interface with a few window contacts on its bus (demo and tests).
 * It speaks KNXnet/IP tunnelling over UDP on 127.0.0.1 like a real interface:
 * connections, acknowledgements, confirmations, heartbeats, the search — and
 * the contacts answer GroupValue_Read with their state.
 */

export interface KnxSimContact {
  address: string;
  name: string;
  open?: boolean;
  /** Sends 0 for open (like DPT 1.009 binary inputs). */
  invert?: boolean;
}

export interface KnxSimOptions {
  contacts: KnxSimContact[];
  /** How many tunnels the interface offers (real ones: 1–8). */
  maxConnections?: number;
  /** A temperature telegram now and then, like a real bus (demo). */
  noise?: boolean;
}

export interface KnxSim {
  readonly host: string;
  readonly port: number;
  /** Group addresses the interface was asked to read. */
  readonly reads: string[];
  contactNames(): string[];
  isContactOpen(name: string): boolean;
  /** Opens or closes a contact: it sends its new state. False when there is no such contact. */
  setContact(name: string, open: boolean): boolean;
  /** Ends every tunnel from the interface's side (it was restarted …). */
  dropConnections(): void;
  readonly connections: number;
  close(): Promise<void>;
}

interface Client {
  channel: number;
  address: string;
  port: number;
  sequence: number;
}

const OWN_ADDRESS = parseIndividualAddress('1.1.250')!;
const CONTACT_SOURCE = parseIndividualAddress('1.1.12')!;
const SENSOR_SOURCE = parseIndividualAddress('1.1.20')!;

export async function startKnxSim(options: KnxSimOptions): Promise<KnxSim> {
  const contacts = options.contacts.map((contact) => ({ ...contact, ga: parseGroupAddress(contact.address)!, open: contact.open ?? false }));
  const clients = new Map<number, Client>();
  const reads: string[] = [];
  let nextChannel = 1;
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;

  const send = (data: Buffer, to: { address: string; port: number }) => socket.send(data, to.port, to.address);
  const toClients = (cemi: Buffer) => {
    for (const client of clients.values()) {
      send(tunnellingRequest(client.channel, client.sequence, cemi), client);
      client.sequence = (client.sequence + 1) & 0xff;
    }
  };
  const valueOf = (contact: (typeof contacts)[number]) => (contact.open !== Boolean(contact.invert) ? 1 : 0);

  socket.on('message', (data: Buffer, from: RemoteInfo) => {
    const parsed = parseFrame(data);
    if (!parsed) return;
    const { service, body } = parsed;
    switch (service) {
      case SERVICE.SEARCH_REQUEST: {
        const target = readHpai(body, 0);
        if (!target) return;
        const dib = Buffer.alloc(54);
        dib.writeUInt8(54, 0);
        dib.writeUInt8(0x01, 1);
        dib.writeUInt8(0x02, 2); // TP1
        dib.writeUInt16BE(OWN_ADDRESS, 4);
        dib.write('KNX IP Demo-Schnittstelle', 24, 'latin1');
        const families = Buffer.from([0x06, 0x02, 0x02, 0x01, 0x04, 0x01]);
        send(frame(SERVICE.SEARCH_RESPONSE, Buffer.concat([hpai('127.0.0.1', port), dib, families])), { address: target.ip === '0.0.0.0' ? from.address : target.ip, port: target.port || from.port });
        return;
      }
      case SERVICE.CONNECT_REQUEST: {
        if (clients.size >= (options.maxConnections ?? 4)) {
          send(frame(SERVICE.CONNECT_RESPONSE, Buffer.from([0, 0x24])), from);
          return;
        }
        const channel = nextChannel++;
        clients.set(channel, { channel, address: from.address, port: from.port, sequence: 0 });
        const crd = Buffer.from([0x04, 0x04, (OWN_ADDRESS + channel) >> 8, (OWN_ADDRESS + channel) & 0xff]);
        send(frame(SERVICE.CONNECT_RESPONSE, Buffer.concat([Buffer.from([channel, 0]), hpai('127.0.0.1', port), crd])), from);
        return;
      }
      case SERVICE.CONNECTIONSTATE_REQUEST: {
        const channel = body[0] ?? 0;
        send(frame(SERVICE.CONNECTIONSTATE_RESPONSE, Buffer.from([channel, clients.has(channel) ? 0 : 0x21])), from);
        return;
      }
      case SERVICE.DISCONNECT_REQUEST: {
        const channel = body[0] ?? 0;
        clients.delete(channel);
        send(frame(SERVICE.DISCONNECT_RESPONSE, Buffer.from([channel, 0])), from);
        return;
      }
      case SERVICE.TUNNELLING_REQUEST: {
        const header = parseConnectionHeader(body);
        if (!header) return;
        const client = clients.get(header.channel);
        send(tunnellingAck(header.channel, header.sequence, client ? 0 : 0x21), from);
        if (!client) return;
        const telegram = parseCemi(header.rest);
        if (!telegram || telegram.messageCode !== MESSAGE_CODE.L_DATA_REQ) return;
        // Went over the bus: confirmation to the sender.
        const confirmation = Buffer.from(header.rest);
        confirmation.writeUInt8(MESSAGE_CODE.L_DATA_CON, 0);
        send(tunnellingRequest(client.channel, client.sequence, confirmation), client);
        client.sequence = (client.sequence + 1) & 0xff;
        if (telegram.service === 'read') {
          reads.push(formatGroupAddress(telegram.destination));
          const contact = contacts.find((entry) => entry.ga === telegram.destination);
          if (contact) setTimeout(() => toClients(groupValueCemi(contact.ga, valueOf(contact), 'response', MESSAGE_CODE.L_DATA_IND, CONTACT_SOURCE)), 15);
        }
        return;
      }
      default:
        return;
    }
  });

  // A temperature (two bytes, DPT 9) every few seconds: something else is going on on the bus, too.
  let noise: NodeJS.Timeout | null = null;
  if (options.noise) {
    const temperature = parseGroupAddress('3/0/1')!;
    noise = setInterval(() => {
      const cemi = Buffer.concat([groupValueCemi(temperature, 0, 'write', MESSAGE_CODE.L_DATA_IND, SENSOR_SOURCE), Buffer.from([0x0c, 0x1a])]);
      cemi.writeUInt8(0x03, 8);
      toClients(cemi);
    }, 7000);
    noise.unref();
  }

  return {
    host: '127.0.0.1',
    port,
    reads,
    contactNames: () => contacts.map((contact) => contact.name),
    isContactOpen: (name) => contacts.find((contact) => contact.name === name)?.open ?? false,
    setContact(name, open) {
      const contact = contacts.find((entry) => entry.name === name);
      if (!contact) return false;
      contact.open = open;
      toClients(groupValueCemi(contact.ga, valueOf(contact), 'write', MESSAGE_CODE.L_DATA_IND, CONTACT_SOURCE));
      return true;
    },
    dropConnections() {
      for (const client of clients.values()) send(frame(SERVICE.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([client.channel, 0]), hpai('127.0.0.1', port)])), client);
      clients.clear();
    },
    get connections() {
      return clients.size;
    },
    async close() {
      if (noise) clearInterval(noise);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
