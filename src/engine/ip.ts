import {
  BROADCAST_MAC,
  LIMITED_BROADCAST,
  broadcastOf,
  inSubnet,
  networkOf,
  type Cidr,
  type Ip,
  type Mac,
} from './addr.ts';
import type { Fabric } from './device.ts';
import type {
  ArpPacket,
  EthernetFrame,
  IcmpPacket,
  Ipv4Packet,
  UdpDatagram,
  UnreachableCode,
} from './packet.ts';
import { hasCarrier, type Port } from './port.ts';

export const DEFAULT_TTL = 64;
/** Linux sends 3 ARP probes, one second apart, before giving up. */
export const ARP_RETRIES = 3;
export const ARP_RETRY_MS = 1000;
/** First port Linux hands out to sockets that don't pick one. */
export const EPHEMERAL_PORT_START = 32768;

export type NeighborState = 'REACHABLE' | 'INCOMPLETE' | 'FAILED';

export interface Neighbor {
  ip: Ip;
  mac: Mac | null;
  port: Port;
  state: NeighborState;
  probes: number;
  queue: Ipv4Packet[];
  /** Pending ARP retry, cancelled once the neighbor answers or is flushed. */
  retry: number | null;
}

/** A route added with `ip route add`. `dst` is a network address (host bits zero). */
export interface StaticRoute {
  dst: Cidr;
  via: Ip | null;
  dev: Port;
}

/** A usable route: connected subnets plus static routes whose next hop is reachable. */
export interface Route {
  dst: Cidr;
  via: Ip | null;
  port: Port;
  src: Ip;
  proto: 'kernel' | 'static';
}

/** Settings a DHCP client got for one interface, so it can renew or release them. */
export interface DhcpLease {
  addr: Cidr;
  server: Ip;
  router: Ip | undefined;
  dns: Ip | undefined;
}

/** What happened to a packet we sent: a reply, or an ICMP error about it. */
export type IcmpEvent =
  | { kind: 'reply'; from: Ip; seq: number; ttl: number }
  | { kind: 'unreachable'; from: Ip; seq: number; code: UnreachableCode }
  | { kind: 'ttl-exceeded'; from: Ip; seq: number };

export type IcmpListener = (event: IcmpEvent) => void;

export type UdpError =
  { kind: 'unreachable'; from: Ip; code: UnreachableCode } | { kind: 'ttl-exceeded'; from: Ip };

export interface UdpSocket {
  readonly port: number;
  /** Sends to `dst`; returns an error message when there is no route. */
  send(dst: Ip, dstPort: number, data: UdpDatagram['data'], ttl?: number): string | null;
  /** Sends to 255.255.255.255 out of one interface, e.g. before it has an address. */
  broadcast(out: Port, src: Ip, dstPort: number, data: UdpDatagram['data']): void;
  close(): void;
}

interface UdpBinding {
  onData: (datagram: UdpDatagram, from: Ip, ingress: Port) => void;
  onError: ((error: UdpError, original: Ipv4Packet) => void) | undefined;
}

/** IPv4 with ARP, routing, ICMP and UDP on the ports that are not bridged. */
export class IpStack {
  /** Addresses per port name, in the order they were added. */
  readonly addrs = new Map<string, Cidr[]>();
  readonly neighbors = new Map<Ip, Neighbor>();
  readonly staticRoutes: StaticRoute[] = [];
  /** Name servers, like the `nameserver` lines of /etc/resolv.conf. */
  dns: Ip[] = [];
  /** Leases obtained with dhclient, per interface name. Not saved with the lab. */
  readonly dhcpLeases = new Map<string, DhcpLease>();
  /** Sources this host has received an echo reply from (used by guided tasks). */
  readonly echoRepliesFrom = new Set<Ip>();
  readonly #icmpListeners = new Map<number, IcmpListener>();
  readonly #udp = new Map<number, UdpBinding>();
  #nextIcmpId = 1;
  #nextDnsId = 1;
  #nextPort = EPHEMERAL_PORT_START;

  constructor(
    readonly fabric: Fabric,
    readonly ports: readonly Port[],
    /** `net.ipv4.ip_forward`: routers forward packets that are not for them. */
    public forwarding = false,
  ) {}

  // ---------------------------------------------------------------- addresses

  addrsOn(port: Port): Cidr[] {
    return this.addrs.get(port.name) ?? [];
  }

  allAddrs(): Cidr[] {
    return [...this.addrs.values()].flat();
  }

  ownsIp(ip: Ip): boolean {
    return this.allAddrs().some((a) => a.ip === ip);
  }

  /** Returns an error message in Linux wording, or null on success. */
  addAddress(port: Port, cidr: Cidr): string | null {
    const list = this.addrsOn(port);
    if (list.some((a) => a.ip === cidr.ip && a.prefix === cidr.prefix)) {
      return 'Error: ipv4: Address already assigned.';
    }
    this.addrs.set(port.name, [...list, cidr]);
    this.fabric.changed();
    return null;
  }

  removeAddress(port: Port, cidr: Cidr): string | null {
    const list = this.addrsOn(port);
    const next = list.filter((a) => !(a.ip === cidr.ip && a.prefix === cidr.prefix));
    if (next.length === list.length) return 'Error: ipv4: Address not found.';
    this.addrs.set(port.name, next);
    this.fabric.changed();
    return null;
  }

  flushAddresses(port: Port): void {
    this.addrs.set(port.name, []);
    this.fabric.changed();
  }

  setForwarding(on: boolean): void {
    this.forwarding = on;
    this.fabric.changed();
  }

  setDns(servers: Ip[]): void {
    this.dns = servers;
    this.fabric.changed();
  }

  // ------------------------------------------------------------------ routing

  /** The address `port` uses to talk to `peer` (one in the same subnet, else its first). */
  #srcOn(port: Port, peer: Ip): Ip | null {
    const addrs = this.addrsOn(port);
    return (addrs.find((a) => inSubnet(peer, a)) ?? addrs[0])?.ip ?? null;
  }

  /** Connected routes, then static routes whose interface is up and next hop is on-link. */
  routes(): Route[] {
    const connected = this.ports.flatMap((port) =>
      hasCarrier(port)
        ? this.addrsOn(port).map((a): Route => ({
            dst: { ip: networkOf(a), prefix: a.prefix },
            via: null,
            port,
            src: a.ip,
            proto: 'kernel',
          }))
        : [],
    );
    const statics = this.staticRoutes.flatMap((r): Route[] => {
      if (!hasCarrier(r.dev)) return [];
      if (r.via !== null && !this.addrsOn(r.dev).some((a) => inSubnet(r.via ?? 0, a))) return [];
      const src = this.#srcOn(r.dev, r.via ?? r.dst.ip);
      return src === null ? [] : [{ dst: r.dst, via: r.via, port: r.dev, src, proto: 'static' }];
    });
    return [...connected, ...statics];
  }

  /** Longest prefix match; on a tie, connected routes win. */
  routeTo(dst: Ip): Route | null {
    let best: Route | null = null;
    for (const route of this.routes()) {
      if (inSubnet(dst, route.dst) && (!best || route.dst.prefix > best.dst.prefix)) best = route;
    }
    return best;
  }

  /** `ip route add`. Returns an error message in Linux wording, or null on success. */
  addRoute(dst: Cidr, via: Ip | null, dev: Port | null): string | null {
    const net = { ip: networkOf(dst), prefix: dst.prefix };
    if (this.staticRoutes.some((r) => r.dst.ip === net.ip && r.dst.prefix === net.prefix)) {
      return 'RTNETLINK answers: File exists';
    }
    let port = dev;
    if (via !== null) {
      const onLink = (p: Port) => this.addrsOn(p).some((a) => inSubnet(via, a));
      port = dev ?? this.ports.find(onLink) ?? null;
      if (!port || !onLink(port)) return 'Error: Nexthop has invalid gateway.';
    }
    if (!port) return 'Error: Device for nexthop is not up.';
    this.staticRoutes.push({ dst: net, via, dev: port });
    this.fabric.changed();
    return null;
  }

  removeRoute(dst: Cidr): string | null {
    const net = networkOf(dst);
    const i = this.staticRoutes.findIndex((r) => r.dst.ip === net && r.dst.prefix === dst.prefix);
    if (i < 0) return 'RTNETLINK answers: No such process';
    this.staticRoutes.splice(i, 1);
    this.fabric.changed();
    return null;
  }

  // ---------------------------------------------------------------- sockets

  /** A fresh DNS query id, unique per device. */
  nextDnsId(): number {
    return this.#nextDnsId++;
  }

  openIcmp(listener: IcmpListener): number {
    const id = this.#nextIcmpId++;
    this.#icmpListeners.set(id, listener);
    return id;
  }

  closeIcmp(id: number): void {
    this.#icmpListeners.delete(id);
  }

  /** Sends an ICMP packet. Returns an error message when there is no route. */
  sendIcmp(dst: Ip, icmp: IcmpPacket, ttl = DEFAULT_TTL): string | null {
    return this.#send(dst, icmp, ttl);
  }

  /**
   * Opens a UDP socket on `port` (or a free ephemeral one). Returns an error message if the
   * port is taken.
   */
  openUdp(
    onData: UdpBinding['onData'],
    onError?: UdpBinding['onError'],
    port?: number,
  ): UdpSocket | string {
    const local = port ?? this.#freePort();
    if (this.#udp.has(local)) return 'Address already in use';
    this.#udp.set(local, { onData, onError });
    return {
      port: local,
      send: (dst, dstPort, data, ttl) =>
        this.#send(dst, { kind: 'udp', srcPort: local, dstPort, data }, ttl),
      broadcast: (out, src, dstPort, data) => {
        const packet: Ipv4Packet = {
          kind: 'ipv4',
          src,
          dst: LIMITED_BROADCAST,
          ttl: DEFAULT_TTL,
          payload: { kind: 'udp', srcPort: local, dstPort, data },
        };
        this.#frame(out, BROADCAST_MAC, packet);
      },
      close: () => {
        this.#udp.delete(local);
      },
    };
  }

  #freePort(): number {
    while (this.#udp.has(this.#nextPort)) this.#nextPort++;
    return this.#nextPort++;
  }

  // ----------------------------------------------------------------- receive

  receive(port: Port, frame: EthernetFrame): void {
    if (frame.dst !== port.mac && frame.dst !== BROADCAST_MAC) return;
    const p = frame.payload;
    if (p.kind === 'arp') {
      this.#handleArp(port, p);
      return;
    }
    const local =
      this.ownsIp(p.dst) ||
      p.dst === LIMITED_BROADCAST ||
      this.addrsOn(port).some((a) => broadcastOf(a) === p.dst);
    if (local) this.#deliver(p, port);
    else if (this.forwarding && frame.dst === port.mac) this.#forward(p);
  }

  /** Forgets neighbors learned on `port` (all ports when omitted), like `ip neigh flush`. */
  flushNeighbors(port?: Port): void {
    for (const [ip, n] of this.neighbors) {
      if (port && n.port !== port) continue;
      if (n.retry !== null) this.fabric.scheduler.cancel(n.retry);
      this.neighbors.delete(ip);
    }
    this.fabric.changed();
  }

  carrierChanged(port: Port): void {
    // Linux flushes neighbor entries of an interface that loses carrier.
    this.flushNeighbors(port);
  }

  // ------------------------------------------------------------ packet path

  #send(dst: Ip, payload: Ipv4Packet['payload'], ttl = DEFAULT_TTL): string | null {
    if (this.ownsIp(dst)) {
      const packet: Ipv4Packet = { kind: 'ipv4', src: dst, dst, ttl, payload };
      const port = this.ports.find((p) => this.addrsOn(p).some((a) => a.ip === dst));
      if (port) this.fabric.scheduler.schedule(0, () => this.#deliver(packet, port));
      return null;
    }
    const route = this.routeTo(dst);
    if (!route) return 'Network is unreachable';
    this.#output(route, { kind: 'ipv4', src: route.src, dst, ttl, payload });
    return null;
  }

  #forward(packet: Ipv4Packet): void {
    // Like Linux, look the route up first: no route means "net unreachable" whatever the TTL.
    const route = this.routeTo(packet.dst);
    if (!route) {
      this.#unreachable(packet, 'net');
      return;
    }
    if (packet.ttl <= 1) {
      this.#icmpError(packet, { kind: 'icmp', type: 'time-exceeded', original: packet });
      return;
    }
    this.#output(route, { ...packet, ttl: packet.ttl - 1 });
  }

  #output(route: Route, packet: Ipv4Packet): void {
    const { port } = route;
    if (!route.via && packet.dst === broadcastOf(route.dst)) {
      this.#frame(port, BROADCAST_MAC, packet);
      return;
    }
    const nextHop = route.via ?? packet.dst;
    const n = this.neighbors.get(nextHop);
    if (n?.state === 'REACHABLE' && n.mac) {
      this.#frame(port, n.mac, packet);
    } else if (n?.state === 'INCOMPLETE') {
      n.queue.push(packet);
    } else {
      const entry: Neighbor = {
        ip: nextHop,
        mac: null,
        port,
        state: 'INCOMPLETE',
        probes: 0,
        queue: [packet],
        retry: null,
      };
      this.neighbors.set(nextHop, entry);
      this.#probe(entry, route.src);
    }
  }

  #probe(n: Neighbor, src: Ip): void {
    if (this.neighbors.get(n.ip) !== n || n.state !== 'INCOMPLETE') return;
    if (n.probes >= ARP_RETRIES) {
      n.state = 'FAILED';
      for (const packet of n.queue) this.#unreachable(packet, 'host');
      n.queue = [];
      this.fabric.changed();
      return;
    }
    n.probes++;
    const arp: ArpPacket = {
      kind: 'arp',
      op: 'request',
      senderMac: n.port.mac,
      senderIp: src,
      targetMac: '00:00:00:00:00:00',
      targetIp: n.ip,
    };
    this.fabric.transmit(n.port, { src: n.port.mac, dst: BROADCAST_MAC, payload: arp });
    n.retry = this.fabric.scheduler.schedule(ARP_RETRY_MS, () => this.#probe(n, src));
    this.fabric.changed();
  }

  /** A packet could not be delivered: tell its sender, locally or with an ICMP error. */
  #unreachable(packet: Ipv4Packet, code: UnreachableCode): void {
    if (this.ownsIp(packet.src)) {
      // Our own packet: Linux reports it to the socket without anything on the wire.
      this.#notify(packet, { kind: 'unreachable', from: packet.src, code });
    } else {
      this.#icmpError(packet, { kind: 'icmp', type: 'dest-unreachable', code, original: packet });
    }
  }

  #icmpError(original: Ipv4Packet, error: IcmpPacket): void {
    const p = original.payload;
    // Never answer an ICMP error with another one, nor packets without a real sender.
    if (p.kind === 'icmp' && p.type !== 'echo-request' && p.type !== 'echo-reply') return;
    if (original.src === 0 || original.src === LIMITED_BROADCAST) return;
    this.#send(original.src, error);
  }

  /** Routes an error about one of our packets to the socket that sent it. */
  #notify(original: Ipv4Packet, error: UdpError): void {
    const p = original.payload;
    if (p.kind === 'icmp' && p.type === 'echo-request') {
      this.#icmpListeners.get(p.id)?.(
        error.kind === 'unreachable'
          ? { kind: 'unreachable', from: error.from, seq: p.seq, code: error.code }
          : { kind: 'ttl-exceeded', from: error.from, seq: p.seq },
      );
    } else if (p.kind === 'udp') {
      this.#udp.get(p.srcPort)?.onError?.(error, original);
    }
  }

  #handleArp(port: Port, arp: ArpPacket): void {
    const forUs = this.addrsOn(port).some((a) => a.ip === arp.targetIp);
    if (forUs || this.neighbors.has(arp.senderIp)) this.#learn(port, arp.senderIp, arp.senderMac);
    if (forUs && arp.op === 'request') {
      const reply: ArpPacket = {
        kind: 'arp',
        op: 'reply',
        senderMac: port.mac,
        senderIp: arp.targetIp,
        targetMac: arp.senderMac,
        targetIp: arp.senderIp,
      };
      this.fabric.transmit(port, { src: port.mac, dst: arp.senderMac, payload: reply });
    }
  }

  #learn(port: Port, ip: Ip, mac: Mac): void {
    const old = this.neighbors.get(ip);
    if (old?.retry != null) this.fabric.scheduler.cancel(old.retry);
    const queued = old?.queue ?? [];
    this.neighbors.set(ip, {
      ip,
      mac,
      port,
      state: 'REACHABLE',
      probes: 0,
      queue: [],
      retry: null,
    });
    for (const packet of queued) this.#frame(port, mac, packet);
    this.fabric.changed();
  }

  #deliver(packet: Ipv4Packet, port: Port): void {
    const p = packet.payload;
    if (p.kind === 'udp') {
      const binding = this.#udp.get(p.dstPort);
      if (binding) binding.onData(p, packet.src, port);
      else if (this.ownsIp(packet.dst)) this.#unreachable(packet, 'port');
      return;
    }
    switch (p.type) {
      case 'echo-request':
        // Like Linux (icmp_echo_ignore_broadcasts), broadcast pings get no answer.
        if (this.ownsIp(packet.dst)) this.#send(packet.src, { ...p, type: 'echo-reply' });
        return;
      case 'echo-reply':
        if (!this.echoRepliesFrom.has(packet.src)) {
          this.echoRepliesFrom.add(packet.src);
          this.fabric.changed();
        }
        this.#icmpListeners.get(p.id)?.({
          kind: 'reply',
          from: packet.src,
          seq: p.seq,
          ttl: packet.ttl,
        });
        return;
      case 'time-exceeded':
        this.#notify(p.original, { kind: 'ttl-exceeded', from: packet.src });
        return;
      case 'dest-unreachable':
        this.#notify(p.original, { kind: 'unreachable', from: packet.src, code: p.code });
        return;
    }
  }

  #frame(port: Port, dst: Mac, packet: Ipv4Packet): void {
    this.fabric.transmit(port, { src: port.mac, dst, payload: packet });
  }
}
