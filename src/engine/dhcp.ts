import { formatIp } from './addr.ts';
import type { Device } from './device.ts';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from './dnsmasq.ts';
import type { DhcpMessage } from './packet.ts';
import type { Port } from './port.ts';

/** Seconds between DHCPDISCOVER retries, and how many are sent before giving up. */
const RETRY_MS = 3000;
const ATTEMPTS = 4;
const DEFAULT_ROUTE = { ip: 0, prefix: 0 };

export interface ClientIO {
  out(line: string): void;
  exit(): void;
}

/** Transaction ids derived from the MAC, so runs are reproducible. */
function xidFor(port: Port, attempt: number): number {
  return (Number.parseInt(port.mac.slice(-5).replace(':', ''), 16) << 4) + attempt;
}

/** Undoes the settings of a previous lease on `port`. */
function dropLease(device: Device, port: Port): void {
  const ip = device.ip;
  const lease = ip?.dhcpLeases.get(port.name);
  if (!ip || !lease) return;
  ip.removeAddress(port, lease.addr);
  if (
    lease.router !== undefined &&
    ip.staticRoutes.some((r) => r.dst.prefix === 0 && r.via === lease.router)
  ) {
    ip.removeRoute(DEFAULT_ROUTE);
  }
  if (lease.dns !== undefined) ip.setDns(ip.dns.filter((d) => d !== lease.dns));
  ip.dhcpLeases.delete(port.name);
}

/**
 * `dhclient -v IF`: DISCOVER, OFFER, REQUEST, ACK, then configures the address, the default
 * route and the name server. Returns an interrupt function, or an error message.
 */
export function dhclient(device: Device, port: Port, io: ClientIO): (() => void) | string {
  const ip = device.ip;
  if (!ip?.ports.includes(port)) return `dhclient: ${port.name}: not an IP interface`;
  const { scheduler } = device.fabric;
  let attempt = 0;
  let xid = 0;
  let timer: number | null = null;
  let offer: DhcpMessage | null = null;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== null) scheduler.cancel(timer);
    if (typeof socket !== 'string') socket.close();
    io.exit();
  };

  const base = (op: DhcpMessage['op']): DhcpMessage => ({
    app: 'dhcp',
    op,
    xid,
    chaddr: port.mac,
    yiaddr: 0,
    serverId: 0,
    hostname: device.name,
  });

  const discover = () => {
    if (attempt >= ATTEMPTS) {
      io.out('No DHCPOFFERS received.');
      finish();
      return;
    }
    xid = xidFor(port, attempt++);
    offer = null;
    io.out(
      `DHCPDISCOVER on ${port.name} to 255.255.255.255 port ${DHCP_SERVER_PORT} interval ${RETRY_MS / 1000}`,
    );
    if (typeof socket !== 'string') socket.broadcast(port, 0, DHCP_SERVER_PORT, base('discover'));
    timer = scheduler.schedule(RETRY_MS, discover);
  };

  const socket = ip.openUdp(
    (datagram, _from, ingress) => {
      const msg = datagram.data;
      if (
        done ||
        ingress !== port ||
        msg.app !== 'dhcp' ||
        msg.xid !== xid ||
        msg.chaddr !== port.mac
      )
        return;
      const server = formatIp(msg.serverId);
      if (msg.op === 'offer' && !offer) {
        offer = msg;
        io.out(`DHCPOFFER of ${formatIp(msg.yiaddr)} from ${server}`);
        io.out(
          `DHCPREQUEST for ${formatIp(msg.yiaddr)} on ${port.name} to 255.255.255.255 port ${DHCP_SERVER_PORT}`,
        );
        if (typeof socket !== 'string') {
          socket.broadcast(port, 0, DHCP_SERVER_PORT, {
            ...base('request'),
            requested: msg.yiaddr,
            serverId: msg.serverId,
          });
        }
      } else if (msg.op === 'ack' && offer && msg.lease) {
        dropLease(device, port);
        const addr = { ip: msg.yiaddr, prefix: msg.lease.prefix };
        ip.addAddress(port, addr);
        const { router, dns } = msg.lease;
        if (router !== undefined) {
          ip.removeRoute(DEFAULT_ROUTE);
          ip.addRoute(DEFAULT_ROUTE, router, port);
        }
        if (dns !== undefined) ip.setDns([dns, ...ip.dns.filter((d) => d !== dns)]);
        ip.dhcpLeases.set(port.name, { addr, server: msg.serverId, router, dns });
        io.out(`DHCPACK of ${formatIp(msg.yiaddr)} from ${server}`);
        io.out(
          `bound to ${formatIp(msg.yiaddr)} -- renewal in ${Math.floor(msg.lease.seconds / 2)} seconds.`,
        );
        finish();
      } else if (msg.op === 'nak') {
        io.out(`DHCPNAK from ${server}`);
        if (timer !== null) scheduler.cancel(timer);
        discover();
      }
    },
    undefined,
    DHCP_CLIENT_PORT,
  );
  if (typeof socket === 'string') return `dhclient: can't bind to dhcp address: ${socket}`;
  discover();
  return finish;
}

/** `dhclient -r IF`: tells the server and removes what the lease configured. */
export function dhcpRelease(device: Device, port: Port, io: Pick<ClientIO, 'out'>): void {
  const ip = device.ip;
  const lease = ip?.dhcpLeases.get(port.name);
  if (!ip || !lease) return;
  const socket = ip.openUdp(() => {}, undefined, DHCP_CLIENT_PORT);
  if (typeof socket !== 'string') {
    const release: DhcpMessage = {
      app: 'dhcp',
      op: 'release',
      xid: xidFor(port, 0),
      chaddr: port.mac,
      yiaddr: 0,
      serverId: lease.server,
    };
    io.out(
      `DHCPRELEASE of ${formatIp(lease.addr.ip)} on ${port.name} to ${formatIp(lease.server)} port ${DHCP_SERVER_PORT}`,
    );
    socket.send(lease.server, DHCP_SERVER_PORT, release);
    socket.close();
  }
  dropLease(device, port);
}
