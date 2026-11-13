import { BROADCAST_MAC, type Mac } from './addr.ts';
import {
  ALL_NODES,
  ALL_ROUTERS,
  LINK_LOCAL_PREFIX,
  eui64,
  inSubnet6,
  isLinkLocal,
  isMulticast6,
  multicastMac,
  networkOf6,
  parseCidr6,
  solicitedNode,
  type Cidr6,
  type Ip6,
} from './addr6.ts';
import type { Fabric } from './device.ts';
import type { EthernetFrame, Icmp6Packet, Ipv6Packet } from './packet.ts';
import { hasCarrier, type Port } from './port.ts';

/**
 * IPv6 next to IPv4 on the same interfaces: link-local addresses, Neighbor Discovery,
 * ICMPv6 echo and errors, static routes, forwarding, and stateless autoconfiguration from
 * router advertisements (radvd). IPv6 carries ICMPv6 only: no TCP or UDP over IPv6.
 */

export const DEFAULT_HOP_LIMIT = 64;
const NDP_RETRIES = 3;
const NDP_RETRY_MS = 1000;
/** Router lifetime radvd announces by default (AdvDefaultLifetime, 3 × 600 s). */
export const RA_LIFETIME_S = 1800;

export interface Addr6 {
  cidr: Cidr6;
  /** `link`: the automatic fe80:: address; `ra`: from a router advertisement (SLAAC). */
  origin: 'link' | 'static' | 'ra';
}

export interface Route6 {
  dst: Cidr6;
  via: Ip6 | null;
  port: Port;
  proto: 'kernel' | 'static' | 'ra';
}

export interface Neighbor6 {
  ip: Ip6;
  mac: Mac | null;
  port: Port;
  state: 'REACHABLE' | 'INCOMPLETE' | 'FAILED';
  router: boolean;
  probes: number;
  queue: Ipv6Packet[];
  retry: number | null;
}

export type Icmp6Event =
  | { kind: 'reply'; from: Ip6; seq: number; hopLimit: number }
  | { kind: 'unreachable'; from: Ip6; seq: number; code: 'route' | 'address' | 'port' }
  | { kind: 'ttl-exceeded'; from: Ip6; seq: number };

/** radvd settings: the prefixes announced on each interface. */
export interface RadvdConfig {
  interfaces: { name: string; prefixes: Cidr6[] }[];
}

export class Ip6Stack {
  /** Configured addresses per interface name; link-local ones are added automatically. */
  readonly addrs = new Map<string, Addr6[]>();
  readonly staticRoutes: { dst: Cidr6; via: Ip6 | null; dev: Port }[] = [];
  /** Default routers learned from router advertisements. */
  readonly raRoutes: { via: Ip6; dev: Port }[] = [];
  readonly neighbors = new Map<string, Neighbor6>();
  /** `net.ipv6.conf.all.forwarding`; hosts accept router advertisements only when it is off. */
  forwarding: boolean;
  radvd: (RadvdConfig & { args: string[] }) | null = null;
  readonly echoRepliesFrom = new Set<Ip6>();
  readonly #listeners = new Map<number, (event: Icmp6Event) => void>();
  #nextId = 1;

  constructor(
    readonly fabric: Fabric,
    /** The IPv4 stack's interface list, shared. */
    readonly ports: Port[],
    forwarding: boolean,
  ) {
    this.forwarding = forwarding;
  }

  // ------------------------------------------------------------- addresses

  linkLocal(port: Port): Ip6 {
    return LINK_LOCAL_PREFIX | eui64(port.mac);
  }

  /** Global addresses first, then the link-local one, like `ip -6 addr`. */
  addrsOn(port: Port): Addr6[] {
    return [
      ...(this.addrs.get(port.name) ?? []),
      { cidr: { ip: this.linkLocal(port), prefix: 64 }, origin: 'link' },
    ];
  }

  ownsIp(ip: Ip6): boolean {
    return this.ports.some((p) => this.addrsOn(p).some((a) => a.cidr.ip === ip));
  }

  addAddress(port: Port, cidr: Cidr6, origin: Addr6['origin'] = 'static'): string | null {
    const list = this.addrs.get(port.name) ?? [];
    if (this.addrsOn(port).some((a) => a.cidr.ip === cidr.ip && a.cidr.prefix === cidr.prefix)) {
      return 'RTNETLINK answers: File exists';
    }
    this.addrs.set(port.name, [...list, { cidr, origin }]);
    this.fabric.changed();
    return null;
  }

  removeAddress(port: Port, cidr: Cidr6): string | null {
    const list = this.addrs.get(port.name) ?? [];
    const next = list.filter((a) => !(a.cidr.ip === cidr.ip && a.cidr.prefix === cidr.prefix));
    if (next.length === list.length) return 'RTNETLINK answers: Cannot assign requested address';
    this.addrs.set(port.name, next);
    this.fabric.changed();
    return null;
  }

  flushAddresses(port: Port): void {
    this.addrs.set(port.name, []);
    this.fabric.changed();
  }

  // ---------------------------------------------------------------- routing

  routes(): Route6[] {
    const kernel = this.ports.flatMap((port) => {
      if (!hasCarrier(port)) return [];
      const nets = new Map<string, Cidr6>();
      for (const a of this.addrsOn(port)) {
        const dst = { ip: networkOf6(a.cidr), prefix: a.cidr.prefix };
        nets.set(`${dst.ip}/${dst.prefix}`, dst);
      }
      return [...nets.values()].map((dst): Route6 => ({ dst, via: null, port, proto: 'kernel' }));
    });
    const statics = this.staticRoutes
      .filter((r) => hasCarrier(r.dev))
      .map((r): Route6 => ({ dst: r.dst, via: r.via, port: r.dev, proto: 'static' }));
    const ra = this.raRoutes
      .filter((r) => hasCarrier(r.dev))
      .map((r): Route6 => ({ dst: { ip: 0n, prefix: 0 }, via: r.via, port: r.dev, proto: 'ra' }));
    return [...kernel, ...statics, ...ra];
  }

  /** Longest prefix match (link-local destinations need an interface instead). */
  routeTo(dst: Ip6): Route6 | null {
    let best: Route6 | null = null;
    for (const r of this.routes()) {
      if (isLinkLocal(r.dst.ip) && r.dst.prefix === 64) continue;
      if (inSubnet6(dst, r.dst) && (!best || r.dst.prefix > best.dst.prefix)) best = r;
    }
    return best;
  }

  addRoute(dst: Cidr6, via: Ip6 | null, dev: Port | null): string | null {
    const net = { ip: networkOf6(dst), prefix: dst.prefix };
    if (this.staticRoutes.some((r) => r.dst.ip === net.ip && r.dst.prefix === net.prefix)) {
      return 'RTNETLINK answers: File exists';
    }
    let port = dev;
    if (via !== null && !port) {
      port =
        this.ports.find((p) =>
          this.addrsOn(p).some((a) => !isLinkLocal(via) && inSubnet6(via, a.cidr)),
        ) ?? null;
    }
    if (!port) return 'Error: Nexthop has invalid gateway.';
    this.staticRoutes.push({ dst: net, via, dev: port });
    this.fabric.changed();
    return null;
  }

  removeRoute(dst: Cidr6): string | null {
    const net = networkOf6(dst);
    const i = this.staticRoutes.findIndex((r) => r.dst.ip === net && r.dst.prefix === dst.prefix);
    if (i < 0) return 'RTNETLINK answers: No such process';
    this.staticRoutes.splice(i, 1);
    this.fabric.changed();
    return null;
  }

  // ------------------------------------------------------------- send path

  openIcmp(listener: (event: Icmp6Event) => void): number {
    const id = this.#nextId++;
    this.#listeners.set(id, listener);
    return id;
  }

  closeIcmp(id: number): void {
    this.#listeners.delete(id);
  }

  /** The source address for `dst` out of `port`: same scope, preferring a matching prefix. */
  sourceOn(port: Port, dst: Ip6): Ip6 {
    if (isLinkLocal(dst) || isMulticast6(dst)) return this.linkLocal(port);
    const globals = (this.addrs.get(port.name) ?? []).map((a) => a.cidr);
    return (globals.find((c) => inSubnet6(dst, c)) ?? globals[0])?.ip ?? this.linkLocal(port);
  }

  /** Why a packet to `dst` could not leave, like connect() on a socket; null if it can. */
  check(dst: Ip6, dev?: Port): string | null {
    if (this.ownsIp(dst) || dev) return null;
    if (isLinkLocal(dst) || isMulticast6(dst)) return 'Invalid argument';
    return this.routeTo(dst) ? null : 'Network is unreachable';
  }

  /**
   * Sends ICMPv6. Link-local and multicast destinations need an interface (`%eth0`), like
   * on Linux. Returns an error message, or null.
   */
  send(
    dst: Ip6,
    payload: Icmp6Packet,
    opts: { dev?: Port; hopLimit?: number } = {},
  ): string | null {
    const hopLimit = opts.hopLimit ?? DEFAULT_HOP_LIMIT;
    if (this.ownsIp(dst)) {
      const port =
        opts.dev ?? this.ports.find((p) => this.addrsOn(p).some((a) => a.cidr.ip === dst));
      if (!port) return 'Network is unreachable';
      const packet: Ipv6Packet = { kind: 'ipv6', src: dst, dst, hopLimit, payload };
      this.fabric.scheduler.schedule(0, () => this.#deliver(packet, port, port.mac));
      return null;
    }
    if (isLinkLocal(dst) || isMulticast6(dst)) {
      if (!opts.dev) return 'Invalid argument';
      const packet: Ipv6Packet = {
        kind: 'ipv6',
        src: this.linkLocal(opts.dev),
        dst,
        hopLimit,
        payload,
      };
      this.#output(opts.dev, null, packet);
      return null;
    }
    const route = opts.dev ? { port: opts.dev, via: null } : this.routeTo(dst);
    if (!route) return 'Network is unreachable';
    const src = this.sourceOn(route.port, dst);
    this.#output(route.port, route.via, { kind: 'ipv6', src, dst, hopLimit, payload });
    return null;
  }

  #output(port: Port, via: Ip6 | null, packet: Ipv6Packet): void {
    if (isMulticast6(packet.dst)) {
      this.#frame(port, multicastMac(packet.dst), packet);
      return;
    }
    const next = via ?? packet.dst;
    const key = `${port.name}|${next}`;
    const n = this.neighbors.get(key);
    if (n?.state === 'REACHABLE' && n.mac) this.#frame(port, n.mac, packet);
    else if (n?.state === 'INCOMPLETE') n.queue.push(packet);
    else {
      const entry: Neighbor6 = {
        ip: next,
        mac: null,
        port,
        state: 'INCOMPLETE',
        router: false,
        probes: 0,
        queue: [packet],
        retry: null,
      };
      this.neighbors.set(key, entry);
      this.#solicit(entry);
    }
  }

  #solicit(n: Neighbor6): void {
    if (this.neighbors.get(`${n.port.name}|${n.ip}`) !== n || n.state !== 'INCOMPLETE') return;
    if (n.probes >= NDP_RETRIES) {
      n.state = 'FAILED';
      for (const packet of n.queue) this.#unreachable(packet, 'address');
      n.queue = [];
      this.fabric.changed();
      return;
    }
    n.probes++;
    const group = solicitedNode(n.ip);
    const ns: Ipv6Packet = {
      kind: 'ipv6',
      src: this.sourceOn(n.port, n.ip),
      dst: group,
      hopLimit: 255,
      payload: { kind: 'icmp6', type: 'neighbor-solicitation', target: n.ip },
    };
    this.#frame(n.port, multicastMac(group), ns);
    n.retry = this.fabric.scheduler.schedule(NDP_RETRY_MS, () => this.#solicit(n));
    this.fabric.changed();
  }

  #frame(port: Port, dst: Mac, packet: Ipv6Packet): void {
    this.fabric.transmit(port, { src: port.mac, dst, payload: packet });
  }

  // ---------------------------------------------------------- receive path

  receive(port: Port, frame: EthernetFrame): void {
    const p = frame.payload;
    if (p.kind !== 'ipv6') return;
    const mine = this.addrsOn(port).map((a) => a.cidr.ip);
    const multicastForUs =
      p.dst === ALL_NODES ||
      (this.forwarding && p.dst === ALL_ROUTERS) ||
      mine.some((ip) => solicitedNode(ip) === p.dst);
    const unicastForUs = frame.dst === port.mac || frame.dst === BROADCAST_MAC;
    if (multicastForUs || (unicastForUs && this.ownsIp(p.dst))) {
      this.#deliver(p, port, frame.src);
      return;
    }
    if (!unicastForUs || !this.forwarding || isMulticast6(p.dst)) return;
    // Routers never forward link-local traffic.
    if (isLinkLocal(p.src) || isLinkLocal(p.dst)) return;
    this.#forward(p);
  }

  #forward(packet: Ipv6Packet): void {
    const route = this.routeTo(packet.dst);
    if (!route) {
      this.#unreachable(packet, 'route');
      return;
    }
    if (packet.hopLimit <= 1) {
      this.#error(packet, { kind: 'icmp6', type: 'time-exceeded', original: packet });
      return;
    }
    this.#output(route.port, route.via, { ...packet, hopLimit: packet.hopLimit - 1 });
  }

  #unreachable(packet: Ipv6Packet, code: 'route' | 'address' | 'port'): void {
    if (this.ownsIp(packet.src)) {
      this.#notify(packet, { kind: 'unreachable', from: packet.src, seq: 0, code });
      return;
    }
    this.#error(packet, { kind: 'icmp6', type: 'dest-unreachable', code, original: packet });
  }

  #error(original: Ipv6Packet, error: Icmp6Packet): void {
    const t = original.payload.type;
    if (t !== 'echo-request' && t !== 'echo-reply') return;
    if (isMulticast6(original.dst) || original.src === 0n) return;
    this.send(original.src, error);
  }

  #notify(original: Ipv6Packet, event: Icmp6Event): void {
    const p = original.payload;
    if (p.type !== 'echo-request') return;
    this.#listeners.get(p.id)?.({ ...event, seq: p.seq });
  }

  #deliver(packet: Ipv6Packet, port: Port, srcMac: Mac): void {
    const m = packet.payload;
    switch (m.type) {
      case 'neighbor-solicitation':
        if (!this.addrsOn(port).some((a) => a.cidr.ip === m.target)) return;
        if (packet.src !== 0n) this.#learn(port, packet.src, srcMac, false);
        this.send(
          packet.src,
          { kind: 'icmp6', type: 'neighbor-advertisement', target: m.target, solicited: true },
          { dev: port, hopLimit: 255 },
        );
        return;
      case 'neighbor-advertisement':
        this.#learn(port, m.target, srcMac, false);
        return;
      case 'router-solicitation':
        if (this.radvd?.interfaces.some((i) => i.name === port.name)) this.advertise(port);
        return;
      case 'router-advertisement':
        this.#autoconfigure(port, packet.src, srcMac, m.prefixes, m.lifetime);
        return;
      case 'echo-request':
        this.send(
          packet.src,
          { ...m, type: 'echo-reply' },
          isLinkLocal(packet.src) || isMulticast6(packet.dst) ? { dev: port } : {},
        );
        return;
      case 'echo-reply':
        if (!this.echoRepliesFrom.has(packet.src)) {
          this.echoRepliesFrom.add(packet.src);
          this.fabric.changed();
        }
        this.#listeners.get(m.id)?.({
          kind: 'reply',
          from: packet.src,
          seq: m.seq,
          hopLimit: packet.hopLimit,
        });
        return;
      case 'time-exceeded':
        this.#notify(m.original, { kind: 'ttl-exceeded', from: packet.src, seq: 0 });
        return;
      case 'dest-unreachable':
        this.#notify(m.original, { kind: 'unreachable', from: packet.src, seq: 0, code: m.code });
        return;
    }
  }

  #learn(port: Port, ip: Ip6, mac: Mac, router: boolean): void {
    const key = `${port.name}|${ip}`;
    const old = this.neighbors.get(key);
    if (old?.retry != null) this.fabric.scheduler.cancel(old.retry);
    const queued = old?.queue ?? [];
    this.neighbors.set(key, {
      ip,
      mac,
      port,
      state: 'REACHABLE',
      router: router || (old?.router ?? false),
      probes: 0,
      queue: [],
      retry: null,
    });
    for (const packet of queued) this.#frame(port, mac, packet);
    this.fabric.changed();
  }

  /** SLAAC: an address from each /64 prefix and the router as default gateway. */
  #autoconfigure(port: Port, router: Ip6, mac: Mac, prefixes: Cidr6[], lifetime: number): void {
    if (this.forwarding) return;
    this.#learn(port, router, mac, true);
    for (const prefix of prefixes) {
      if (prefix.prefix !== 64) continue;
      const ip = networkOf6(prefix) | eui64(port.mac);
      const has = (this.addrs.get(port.name) ?? []).some((a) => a.cidr.ip === ip);
      if (!has) this.addAddress(port, { ip, prefix: 64 }, 'ra');
    }
    const i = this.raRoutes.findIndex((r) => r.via === router && r.dev === port);
    if (lifetime > 0 && i < 0) this.raRoutes.push({ via: router, dev: port });
    if (lifetime === 0 && i >= 0) this.raRoutes.splice(i, 1);
    this.fabric.changed();
  }

  /** Sends a router advertisement on `port` (radvd); lifetime 0 says goodbye. */
  advertise(port: Port, lifetime = RA_LIFETIME_S): void {
    const conf = this.radvd?.interfaces.find((i) => i.name === port.name);
    if (!conf || !hasCarrier(port)) return;
    this.send(
      ALL_NODES,
      {
        kind: 'icmp6',
        type: 'router-advertisement',
        prefixes: lifetime > 0 ? conf.prefixes : [],
        lifetime,
      },
      { dev: port, hopLimit: 255 },
    );
  }

  carrierChanged(port: Port): void {
    for (const [key, n] of this.neighbors) {
      if (n.port !== port) continue;
      if (n.retry !== null) this.fabric.scheduler.cancel(n.retry);
      this.neighbors.delete(key);
    }
    if (!hasCarrier(port)) {
      for (let i = this.raRoutes.length - 1; i >= 0; i--) {
        if (this.raRoutes[i]?.dev === port) this.raRoutes.splice(i, 1);
      }
      return;
    }
    // A host asks for routers when its link comes up; a router announces itself.
    if (this.radvd) this.advertise(port);
    else if (!this.forwarding) {
      this.send(
        ALL_ROUTERS,
        { kind: 'icmp6', type: 'router-solicitation' },
        { dev: port, hopLimit: 255 },
      );
    }
  }

  /** Forgets an interface that was deleted (a VLAN interface). */
  removePort(port: Port): void {
    this.addrs.delete(port.name);
    const gone = <T extends { dev: Port }>(list: T[]) => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]?.dev === port) list.splice(i, 1);
    };
    gone(this.staticRoutes);
    gone(this.raRoutes);
    for (const [key, n] of this.neighbors) {
      if (n.port !== port) continue;
      if (n.retry !== null) this.fabric.scheduler.cancel(n.retry);
      this.neighbors.delete(key);
    }
  }
}

export const RADVD_CONF = '/etc/radvd.conf';

/** Reads `interface IF { AdvSendAdvert on; prefix P/64 { }; };` blocks of radvd.conf. */
export function parseRadvd(text: string): RadvdConfig | string {
  const interfaces: RadvdConfig['interfaces'] = [];
  const clean = text.replace(/#.*$/gm, '');
  const re = /interface\s+([\w.-]+)\s*\{/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '{') depth++;
      if (clean[i] === '}') depth--;
    }
    const body = clean.slice(m.index + m[0].length, i - 1);
    if (!/AdvSendAdvert\s+on/.test(body)) continue;
    const prefixes: Cidr6[] = [];
    for (const p of body.matchAll(/prefix\s+([0-9a-fA-F:]+\/\d+)/g)) {
      const cidr = parseCidr6(p[1] ?? '');
      if (!cidr) return `radvd: syntax error in config near ${p[1] ?? ''}`;
      prefixes.push(cidr);
    }
    interfaces.push({ name: m[1] ?? '', prefixes });
  }
  return { interfaces };
}
