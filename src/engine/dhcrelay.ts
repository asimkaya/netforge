import { parseIp, type Ip } from './addr.ts';
import type { Fabric } from './device.ts';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from './dnsmasq.ts';
import type { IpStack, UdpSocket } from './ip.ts';
import type { UdpDatagram } from './packet.ts';
import type { Port } from './port.ts';

const USAGE = [
  'Usage: dhcrelay [-4] [-d] [-q] [-a] [-D] [-A <length>] [-c <hops>] [-p <port>]',
  '                [-pf <pid-file>] [--no-pid]',
  '                [-m append|replace|forward|discard]',
  '                [-i interface0 [ ... -i interfaceN]',
  '                server0 [ ... serverN]',
];

const BIND_ERROR = [
  "Can't bind to dhcp address: Address already in use",
  'Please make sure there is no other dhcp server',
  "running and that there's no entry for dhcp or",
  'bootps in /etc/inetd.conf.   Also make sure you',
  'are not running HP JetAdmin software, which',
  'includes a bootp server.',
];

/**
 * The ISC `dhcrelay` agent: forwards DHCP broadcasts from the networks it listens on to the
 * DHCP servers, stamping giaddr with the address of the interface the client is behind, and
 * hands the server's replies back to that network. Simplified: no hop count, no option 82.
 */
export class DhcpRelay {
  private constructor(
    readonly stack: IpStack,
    /** The command-line arguments, kept to save and restore the service. */
    readonly args: readonly string[],
    /** The `-i` interfaces; empty means every interface that has an address. */
    readonly interfaces: readonly Port[],
    readonly servers: readonly Ip[],
    readonly socket: UdpSocket,
  ) {}

  /** Parses `[-i IF]... SERVER...` and starts relaying. Returns the log lines, or the error. */
  static start(
    fabric: Fabric,
    stack: IpStack,
    args: readonly string[],
    find: (name: string) => Port | undefined,
  ): { relay: DhcpRelay; lines: string[] } | string[] {
    const names: string[] = [];
    const servers: Ip[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (arg === '-i') {
        const name = args[++i];
        if (name === undefined) return USAGE;
        names.push(name);
      } else if (arg === '-4' || arg === '-d' || arg === '-q') {
        // Accepted: here the relay always runs in the background and speaks IPv4.
      } else if (arg.startsWith('-')) {
        return USAGE;
      } else {
        const ip = parseIp(arg);
        if (ip === null) return [`dhcrelay: Cannot resolve server name "${arg}"`];
        servers.push(ip);
      }
    }
    if (servers.length === 0) return ['No servers specified.', ...USAGE];
    const interfaces: Port[] = [];
    for (const name of names) {
      const port = find(name);
      if (!port || !stack.ports.includes(port)) return [`dhcrelay: ${name}: interface not found`];
      interfaces.push(port);
    }
    const ref: { relay?: DhcpRelay } = {};
    const socket = stack.openUdp(
      (d, _from, ingress) => ref.relay?.onDhcp(d.data, ingress),
      undefined,
      DHCP_SERVER_PORT,
    );
    if (typeof socket === 'string') return BIND_ERROR;
    const relay = new DhcpRelay(stack, [...args], interfaces, servers, socket);
    ref.relay = relay;
    fabric.changed();
    const listening =
      interfaces.length > 0 ? interfaces : stack.ports.filter((p) => stack.addrsOn(p).length > 0);
    return {
      relay,
      lines: [
        'Internet Systems Consortium DHCP Relay Agent 4.4.3',
        'Copyright 2004-2022 Internet Systems Consortium.',
        'All rights reserved.',
        'For info, please visit https://www.isc.org/software/dhcp/',
        ...listening.flatMap((p) => [
          `Listening on LPF/${p.name}/${p.mac}`,
          `Sending on   LPF/${p.name}/${p.mac}`,
        ]),
        'Sending on   Socket/fallback',
      ],
    };
  }

  stop(): void {
    this.socket.close();
  }

  onDhcp(msg: UdpDatagram['data'], ingress: Port): void {
    if (msg.app !== 'dhcp') return;
    if (msg.op === 'offer' || msg.op === 'ack' || msg.op === 'nak') {
      // A server's answer comes back to giaddr: put it on the client's network.
      const giaddr = msg.giaddr;
      const out = giaddr
        ? this.stack.ports.find((p) => this.stack.addrsOn(p).some((a) => a.ip === giaddr))
        : undefined;
      if (out && giaddr)
        this.socket.broadcast(out, giaddr, DHCP_CLIENT_PORT, { ...msg, giaddr: 0 });
      return;
    }
    // A client's request: only from the networks we listen on, and not if another relay
    // already stamped it.
    const own = this.stack.addrsOn(ingress)[0];
    const listens = this.interfaces.length === 0 || this.interfaces.includes(ingress);
    if (!listens || !own || msg.giaddr) return;
    for (const server of this.servers) {
      this.socket.send(server, DHCP_SERVER_PORT, { ...msg, giaddr: own.ip });
    }
  }
}
