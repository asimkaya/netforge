import { BROADCAST_MAC, broadcastOf, inSubnet, type Cidr, type Ip, type Mac } from './addr.ts';
import type { Fabric } from './device.ts';
import { hasCarrier, type Port } from './port.ts';
import type { ArpPacket, EthernetFrame, IcmpPacket, Ipv4Packet } from './packet.ts';

export const DEFAULT_TTL = 64;
/** Linux sends 3 ARP probes, one second apart, before giving up. */
export const ARP_RETRIES = 3;
export const ARP_RETRY_MS = 1000;

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

export type IcmpEvent =
  | { kind: 'reply'; from: Ip; seq: number; ttl: number }
  | { kind: 'unreachable'; from: Ip; seq: number };

export type IcmpListener = (event: IcmpEvent) => void;

/** IPv4 with ARP and ICMP on a set of ports (the ports that are not bridged). */
export class IpStack {
  /** Addresses per port name, in the order they were added. */
  readonly addrs = new Map<string, Cidr[]>();
  readonly neighbors = new Map<Ip, Neighbor>();
  /** Sources this host has received an echo reply from (used by guided tasks). */
  readonly echoRepliesFrom = new Set<Ip>();
  readonly #icmpListeners = new Map<number, IcmpListener>();
  #nextIcmpId = 1;

  constructor(
    readonly fabric: Fabric,
    readonly ports: readonly Port[],
  ) {}

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

  /** Connected routes: one per address, on ports with carrier. */
  routes(): { subnet: Cidr; port: Port; src: Ip }[] {
    return this.ports.flatMap((port) =>
      hasCarrier(port) ? this.addrsOn(port).map((a) => ({ subnet: a, port, src: a.ip })) : [],
    );
  }

  /** Picks the most specific connected route (longest prefix match). */
  routeTo(dst: Ip): { port: Port; src: Ip; subnet: Cidr } | null {
    let best: { port: Port; src: Ip; subnet: Cidr } | null = null;
    for (const route of this.routes()) {
      if (inSubnet(dst, route.subnet) && (!best || route.subnet.prefix > best.subnet.prefix)) {
        best = route;
      }
    }
    return best;
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
  sendIcmp(dst: Ip, icmp: IcmpPacket): string | null {
    if (this.ownsIp(dst)) {
      const packet: Ipv4Packet = { kind: 'ipv4', src: dst, dst, ttl: DEFAULT_TTL, payload: icmp };
      this.fabric.scheduler.schedule(0, () => this.#handleIp(packet));
      return null;
    }
    const route = this.routeTo(dst);
    if (!route) return 'Network is unreachable';
    const packet: Ipv4Packet = {
      kind: 'ipv4',
      src: route.src,
      dst,
      ttl: DEFAULT_TTL,
      payload: icmp,
    };
    this.#output(route.port, dst, route.subnet, packet);
    return null;
  }

  receive(port: Port, frame: EthernetFrame): void {
    if (frame.dst !== port.mac && frame.dst !== BROADCAST_MAC) return;
    const p = frame.payload;
    if (p.kind === 'arp') {
      this.#handleArp(port, p);
      return;
    }
    const forUs = this.ownsIp(p.dst) || this.addrsOn(port).some((a) => broadcastOf(a) === p.dst);
    if (forUs) this.#handleIp(p);
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

  #output(port: Port, nextHop: Ip, subnet: Cidr, packet: Ipv4Packet): void {
    if (nextHop === broadcastOf(subnet)) {
      this.#sendFrame(port, BROADCAST_MAC, packet);
      return;
    }
    const n = this.neighbors.get(nextHop);
    if (n?.state === 'REACHABLE' && n.mac) {
      this.#sendFrame(port, n.mac, packet);
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
      this.#probe(entry, packet.src);
    }
  }

  #probe(n: Neighbor, src: Ip): void {
    if (this.neighbors.get(n.ip) !== n || n.state !== 'INCOMPLETE') return;
    if (n.probes >= ARP_RETRIES) {
      n.state = 'FAILED';
      for (const packet of n.queue) {
        if (packet.payload.type === 'echo-request') {
          this.#icmpListeners.get(packet.payload.id)?.({
            kind: 'unreachable',
            from: packet.src,
            seq: packet.payload.seq,
          });
        }
      }
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
    for (const packet of queued) this.#sendFrame(port, mac, packet);
    this.fabric.changed();
  }

  #handleIp(packet: Ipv4Packet): void {
    const icmp = packet.payload;
    if (icmp.type === 'echo-request') {
      this.sendIcmp(packet.src, { ...icmp, type: 'echo-reply' });
    } else {
      if (!this.echoRepliesFrom.has(packet.src)) {
        this.echoRepliesFrom.add(packet.src);
        this.fabric.changed();
      }
      this.#icmpListeners.get(icmp.id)?.({
        kind: 'reply',
        from: packet.src,
        seq: icmp.seq,
        ttl: packet.ttl,
      });
    }
  }

  #sendFrame(port: Port, dst: Mac, packet: Ipv4Packet): void {
    this.fabric.transmit(port, { src: port.mac, dst, payload: packet });
  }
}
