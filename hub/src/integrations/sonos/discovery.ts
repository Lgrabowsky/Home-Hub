import { createSocket } from 'node:dgram';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH = ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 1', 'ST: urn:schemas-upnp-org:device:ZonePlayer:1', '', ''].join('\r\n');

/**
 * Looks for Sonos players with SSDP and returns their `host:port`.
 * Never throws: a machine without a multicast route (containers, VPN-only
 * hosts) simply finds nothing.
 */
export function discoverPlayers(timeoutMs = 2500): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    let done = false;
    let socket: ReturnType<typeof createSocket>;
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const timers: NodeJS.Timeout[] = [];
    const finish = () => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found]);
    };
    socket.on('error', finish);
    socket.on('message', (message) => {
      const answer = message.toString('latin1');
      if (!/ZonePlayer|Sonos/i.test(answer)) return;
      const location = /^LOCATION:\s*(\S+)/im.exec(answer)?.[1];
      if (!location) return;
      try {
        const url = new URL(location);
        found.add(`${url.hostname}:${url.port || '1400'}`);
      } catch {
        /* not a URL */
      }
    });
    socket.bind(0, () => {
      const send = () => {
        if (done) return;
        socket.send(SEARCH, SSDP_PORT, SSDP_ADDRESS, (err) => {
          // No route for multicast: there is nothing to wait for.
          if (err && found.size === 0) finish();
        });
      };
      send();
      // UDP gets lost; ask a second time.
      timers.push(setTimeout(send, 400));
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}
