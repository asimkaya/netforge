import { formatIp, inSubnet, parseIp, type Cidr, type Ip, type Mac } from './addr.ts';
import type { Fabric } from './device.ts';
import type { IpStack, UdpSocket } from './ip.ts';
import type { DhcpMessage, DnsMessage } from './packet.ts';
import type { Port } from './port.ts';

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
export const DNS_PORT = 53;
/** dnsmasq's default lease time. */
export const DEFAULT_LEASE_SECONDS = 3600;

export interface DhcpRange {
  start: Ip;
  end: Ip;
  leaseSeconds: number;
}

export interface DnsmasqConfig {
  ranges: DhcpRange[];
  /** `--dhcp-option=option:router,IP`; defaults to the serving interface's address. */
  router?: Ip;
  /** `--dhcp-option=option:dns-server,IP`; defaults to the serving interface's address. */
  dns?: Ip;
  /** `--address=/name/IP` and `--host-record=name,IP`. */
  hosts: { name: string; ip: Ip }[];
}

export interface Lease {
  mac: Mac;
  ip: Ip;
  prefix: number;
  hostname: string | undefined;
  /** Offered but not yet requested. */
  offered: boolean;
  /** Virtual time (ms) the lease runs out. */
  expires: number;
}

function parseDuration(text: string): number | null {
  if (text === 'infinite') return 0xffffffff;
  const m = /^(\d+)([smhdw]?)$/.exec(text);
  if (!m) return null;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] ?? ''] ?? 1;
  return Number(m[1]) * unit;
}

/**
 * Parses dnsmasq command-line options. Returns the config or an error message in dnsmasq's
 * wording. Unknown options are rejected so typos don't fail silently.
 */
export function parseDnsmasqArgs(args: readonly string[]): DnsmasqConfig | string {
  const config: DnsmasqConfig = { ranges: [], hosts: [] };
  for (const arg of args) {
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg : arg.slice(0, eq);
    const value = eq < 0 ? '' : arg.slice(eq + 1);
    if (key === '--dhcp-range') {
      // START,END[,MASK][,LEASE]; an interface tag in front is accepted and ignored.
      const parts = value.split(',').filter((p) => !/^[a-z]/.test(p) || p === 'infinite');
      const [startText, endText, ...rest] = parts;
      const start = startText === undefined ? null : parseIp(startText);
      const end = endText === undefined ? null : parseIp(endText);
      if (start === null || end === null || end < start)
        return `dnsmasq: bad dhcp-range at line 1 of command line`;
      let leaseSeconds = DEFAULT_LEASE_SECONDS;
      for (const p of rest) {
        if (parseIp(p) !== null) continue; // netmask: the interface's subnet is used instead
        const seconds = parseDuration(p);
        if (seconds === null) return `dnsmasq: bad dhcp-range at line 1 of command line`;
        leaseSeconds = seconds;
      }
      config.ranges.push({ start, end, leaseSeconds });
    } else if (key === '--dhcp-option') {
      const [name, ipText] = value.split(',');
      const ip = ipText === undefined ? null : parseIp(ipText);
      if (ip === null) return `dnsmasq: bad dhcp-option at line 1 of command line`;
      if (name === 'option:router' || name === '3') config.router = ip;
      else if (name === 'option:dns-server' || name === '6') config.dns = ip;
      else return `dnsmasq: bad dhcp-option at line 1 of command line`;
    } else if (key === '--address') {
      const m = /^\/([^/]+)\/([0-9.]+)$/.exec(value);
      const ip = m?.[2] === undefined ? null : parseIp(m[2]);
      if (!m?.[1] || ip === null) return `dnsmasq: bad address at line 1 of command line`;
      config.hosts.push({ name: m[1].toLowerCase(), ip });
    } else if (key === '--host-record') {
      const [name, ipText] = value.split(',');
      const ip = ipText === undefined ? null : parseIp(ipText);
      if (!name || ip === null) return `dnsmasq: bad host-record at line 1 of command line`;
      config.hosts.push({ name: name.toLowerCase(), ip });
    } else if (key === '--interface' || key === '--no-daemon' || key === '-d' || key === '-k') {
      // Accepted for familiarity; NetForge serves every interface with a matching subnet.
    } else {
      return `dnsmasq: bad command line options: try --help`;
    }
  }
  return config;
}

/**
 * A small dnsmasq: a DHCP server for the configured ranges and a DNS server for its host
 * records and the names of its DHCP clients. There is no upstream DNS.
 */
export class Dnsmasq {
  readonly leases: Lease[] = [];
  readonly #dhcp: UdpSocket;
  readonly #dns: UdpSocket;

  private constructor(
    readonly fabric: Fabric,
    readonly stack: IpStack,
    readonly config: DnsmasqConfig,
    /** The command-line arguments, kept to save and restore the service. */
    readonly args: readonly string[],
    sockets: [UdpSocket, UdpSocket],
  ) {
    [this.#dhcp, this.#dns] = sockets;
  }

  /** Starts the service, or returns an error message (e.g. ports already taken). */
  static start(fabric: Fabric, stack: IpStack, args: readonly string[]): Dnsmasq | string {
    const config = parseDnsmasqArgs(args);
    if (typeof config === 'string') return config;
    // The sockets exist before the server object, so their callbacks look it up late.
    const ref: { server?: Dnsmasq } = {};
    const dns = stack.openUdp(
      (d, from) => ref.server?.onDns(d.data, from, d.srcPort),
      undefined,
      DNS_PORT,
    );
    if (typeof dns === 'string')
      return `dnsmasq: failed to create listening socket for port 53: ${dns}`;
    const dhcp = stack.openUdp(
      (d, _from, ingress) => ref.server?.onDhcp(d.data, ingress),
      undefined,
      DHCP_SERVER_PORT,
    );
    if (typeof dhcp === 'string') {
      dns.close();
      return `dnsmasq: failed to bind DHCP server socket: ${dhcp}`;
    }
    ref.server = new Dnsmasq(fabric, stack, config, [...args], [dhcp, dns]);
    fabric.changed();
    return ref.server;
  }

  stop(): void {
    this.#dhcp.close();
    this.#dns.close();
    this.fabric.changed();
  }

  /** dnsmasq's startup log lines. */
  banner(): string[] {
    return [
      'dnsmasq: started, version 2.90 cachesize 150',
      ...this.config.ranges.map((r) => {
        const time = r.leaseSeconds >= 0xffffffff ? 'infinite' : `${r.leaseSeconds}s`;
        return `dnsmasq-dhcp: DHCP, IP range ${formatIp(r.start)} -- ${formatIp(r.end)}, lease time ${time}`;
      }),
      ...this.config.hosts.map((h) => `dnsmasq: serving ${h.name} as ${formatIp(h.ip)}`),
    ];
  }

  /** Active (acked, unexpired) leases. */
  activeLeases(): Lease[] {
    const now = this.fabric.scheduler.now;
    return this.leases.filter((l) => !l.offered && l.expires > now);
  }

  // ------------------------------------------------------------------- DHCP

  /** The interface subnet and range that serve requests arriving on `port`. */
  #scope(port: Port): { subnet: Cidr; range: DhcpRange } | null {
    for (const subnet of this.stack.addrsOn(port)) {
      const range = this.config.ranges.find(
        (r) => inSubnet(r.start, subnet) && inSubnet(r.end, subnet),
      );
      if (range) return { subnet, range };
    }
    return null;
  }

  #free(ip: Ip, mac: Mac): boolean {
    const now = this.fabric.scheduler.now;
    return (
      !this.stack.ownsIp(ip) &&
      !this.leases.some((l) => l.ip === ip && l.mac !== mac && l.expires > now)
    );
  }

  #pick(range: DhcpRange, mac: Mac, requested: Ip | undefined): Ip | null {
    const mine = this.leases.find((l) => l.mac === mac);
    if (mine && mine.ip >= range.start && mine.ip <= range.end) return mine.ip;
    if (
      requested !== undefined &&
      requested >= range.start &&
      requested <= range.end &&
      this.#free(requested, mac)
    ) {
      return requested;
    }
    for (let ip = range.start; ip <= range.end; ip++) if (this.#free(ip, mac)) return ip;
    return null;
  }

  /** Handles a datagram that arrived on UDP 67. */
  onDhcp(msg: DhcpMessage | DnsMessage | { app: 'probe' }, ingress: Port): void {
    if (msg.app !== 'dhcp') return;
    const scope = this.#scope(ingress);
    if (!scope) return;
    const { subnet, range } = scope;
    const now = this.fabric.scheduler.now;
    const reply = (op: DhcpMessage['op'], yiaddr: Ip) => {
      const answer: DhcpMessage = {
        app: 'dhcp',
        op,
        xid: msg.xid,
        chaddr: msg.chaddr,
        yiaddr,
        serverId: subnet.ip,
        ...(op === 'nak'
          ? {}
          : {
              lease: {
                prefix: subnet.prefix,
                router: this.config.router ?? subnet.ip,
                dns: this.config.dns ?? subnet.ip,
                seconds: range.leaseSeconds,
              },
            }),
      };
      this.#dhcp.broadcast(ingress, subnet.ip, DHCP_CLIENT_PORT, answer);
    };
    const remember = (ip: Ip, offered: boolean) => {
      const i = this.leases.findIndex((l) => l.mac === msg.chaddr);
      const lease: Lease = {
        mac: msg.chaddr,
        ip,
        prefix: subnet.prefix,
        hostname: msg.hostname,
        offered,
        expires: now + (offered ? 60_000 : range.leaseSeconds * 1000),
      };
      if (i >= 0) this.leases.splice(i, 1, lease);
      else this.leases.push(lease);
      this.fabric.changed();
    };

    if (msg.op === 'discover') {
      const ip = this.#pick(range, msg.chaddr, msg.requested);
      if (ip === null) return; // dnsmasq logs "no address available" and stays quiet
      remember(ip, true);
      reply('offer', ip);
    } else if (msg.op === 'request') {
      if (msg.serverId && msg.serverId !== subnet.ip) {
        // The client chose another server: forget our offer.
        const i = this.leases.findIndex((l) => l.mac === msg.chaddr && l.offered);
        if (i >= 0) this.leases.splice(i, 1);
        return;
      }
      const wanted = msg.requested ?? 0;
      if (wanted < range.start || wanted > range.end || !this.#free(wanted, msg.chaddr)) {
        reply('nak', 0);
        return;
      }
      remember(wanted, false);
      reply('ack', wanted);
    } else if (msg.op === 'release') {
      const i = this.leases.findIndex((l) => l.mac === msg.chaddr);
      if (i >= 0) this.leases.splice(i, 1);
      this.fabric.changed();
    }
  }

  // -------------------------------------------------------------------- DNS

  /** Answers from host records first, then from DHCP client names. */
  lookup(name: string): Ip | null {
    const wanted = name.toLowerCase();
    const host = this.config.hosts.find((h) => h.name === wanted);
    if (host) return host.ip;
    return this.activeLeases().find((l) => l.hostname?.toLowerCase() === wanted)?.ip ?? null;
  }

  /** Handles a datagram that arrived on UDP 53. */
  onDns(msg: DhcpMessage | DnsMessage | { app: 'probe' }, from: Ip, port: number): void {
    if (msg.app !== 'dns' || msg.qr !== 'query') return;
    const answer: DnsMessage = {
      app: 'dns',
      id: msg.id,
      qr: 'response',
      name: msg.name,
      answer: this.lookup(msg.name),
    };
    this.#dns.send(from, port, answer);
  }
}
