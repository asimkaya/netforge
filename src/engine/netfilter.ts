import { inSubnet, type Cidr, type Ip } from './addr.ts';
import type { Ipv4Packet } from './packet.ts';
import type { Port } from './port.ts';
import type { Scheduler } from './scheduler.ts';

/**
 * Netfilter, as nftables shows it: tables of chains of rules, attached to the five hooks of
 * the IPv4 path, plus connection tracking for `ct state` and NAT. See docs/FEATURES.md for
 * what is simplified.
 */

export type Hook = 'prerouting' | 'input' | 'forward' | 'output' | 'postrouting';
export type ChainType = 'filter' | 'nat';
export type CtState = 'new' | 'established' | 'related' | 'invalid' | 'untracked';
export type L4 = 'icmp' | 'tcp' | 'udp';
export const ICMP_TYPES = [
  'echo-reply',
  'destination-unreachable',
  'echo-request',
  'time-exceeded',
] as const;
export type IcmpType = (typeof ICMP_TYPES)[number];

export type Match =
  | { kind: 'iifname' | 'oifname'; neg: boolean; name: string }
  | { kind: 'saddr' | 'daddr'; neg: boolean; cidr: Cidr }
  | { kind: 'l4proto'; neg: boolean; proto: L4; via: 'ip protocol' | 'meta l4proto' }
  | { kind: 'port'; proto: 'tcp' | 'udp'; field: 'sport' | 'dport'; neg: boolean; ports: number[] }
  | { kind: 'icmp'; types: IcmpType[] }
  | { kind: 'ct'; neg: boolean; states: CtState[] };

export type Action =
  | { kind: 'accept' | 'drop' | 'reject' | 'masquerade' | 'none' }
  | { kind: 'snat' | 'dnat'; addr: Ip; port: number | null };

export interface Rule {
  handle: number;
  matches: Match[];
  counter: { packets: number; bytes: number } | null;
  action: Action;
}

export interface BaseChain {
  type: ChainType;
  hook: Hook;
  priority: number;
  policy: 'accept' | 'drop';
}

export interface Chain {
  name: string;
  /** Base chains are attached to a hook; regular chains are only reachable by jumps. */
  base: BaseChain | null;
  rules: Rule[];
}

export interface Table {
  family: 'ip' | 'inet';
  name: string;
  chains: Chain[];
}

// ---------------------------------------------------------------- conntrack

/** A connection's addresses and ports; ICMP echoes use their id as the port. */
export interface Tuple {
  proto: L4;
  src: Ip;
  dst: Ip;
  sport: number;
  dport: number;
}

export interface Conn {
  orig: Tuple;
  /** What replies look like; NAT rewrites it. */
  reply: Tuple;
  replied: boolean;
  last: number;
}

/** A packet on its way through the hooks, with its connection. */
export interface Tracked {
  packet: Ipv4Packet;
  conn: Conn | null;
  /** Which way the packet goes on its connection. */
  dir: 'orig' | 'reply';
  state: CtState;
  /** ICMP errors carry the packet they are about; NAT rewrites it too. */
  related: boolean;
  /** First packet of a connection not yet confirmed: NAT chains see only these. */
  fresh: boolean;
}

/** Linux defaults for idle connections (seconds); TCP uses a short value here, see docs. */
export const TIMEOUT_S: Record<L4, number> = { icmp: 30, udp: 30, tcp: 300 };

const swap = (t: Tuple): Tuple => ({
  proto: t.proto,
  src: t.dst,
  dst: t.src,
  sport: t.dport,
  dport: t.sport,
});
const key = (t: Tuple) => `${t.proto} ${t.src} ${t.sport} ${t.dst} ${t.dport}`;

/** The connection tuple of a packet, or null for packets conntrack ignores (ICMP errors). */
export function tupleOf(p: Ipv4Packet): Tuple | null {
  const l4 = p.payload;
  if (l4.kind === 'icmp') {
    if (l4.type === 'echo-request')
      return { proto: 'icmp', src: p.src, dst: p.dst, sport: l4.id, dport: 0 };
    if (l4.type === 'echo-reply')
      return { proto: 'icmp', src: p.src, dst: p.dst, sport: 0, dport: l4.id };
    return null;
  }
  return { proto: l4.kind, src: p.src, dst: p.dst, sport: l4.srcPort, dport: l4.dstPort };
}

function withTuple(p: Ipv4Packet, t: Tuple): Ipv4Packet {
  const l4 = p.payload;
  if (l4.kind === 'icmp') {
    if (l4.type === 'echo-request')
      return { ...p, src: t.src, dst: t.dst, payload: { ...l4, id: t.sport } };
    if (l4.type === 'echo-reply')
      return { ...p, src: t.src, dst: t.dst, payload: { ...l4, id: t.dport } };
    return { ...p, src: t.src, dst: t.dst };
  }
  return { ...p, src: t.src, dst: t.dst, payload: { ...l4, srcPort: t.sport, dstPort: t.dport } };
}

/** Rough on-the-wire size for counters: IP header plus a typical payload. */
export function packetBytes(p: Ipv4Packet): number {
  const l4 = p.payload;
  if (l4.kind === 'icmp') return l4.type.startsWith('echo') ? 84 : 56;
  if (l4.kind === 'udp') return 20 + 8 + 32;
  return 20 + 20 + (l4.data?.length ?? 0);
}

/** Where a packet is: the interfaces it came in on and goes out of, when known. */
interface Where {
  hook: Hook;
  in: Port | null;
  out: Port | null;
}

export type Verdict = 'accept' | 'drop' | 'reject';

export class Netfilter {
  tables: Table[] = [];
  #handle = 0;
  readonly #conns = new Map<string, { conn: Conn; dir: 'orig' | 'reply' }>();

  constructor(
    readonly scheduler: Scheduler,
    /** The address masquerade uses on an interface. */
    readonly addressOn: (port: Port) => Ip | null,
    readonly changed: () => void,
  ) {}

  nextHandle(): number {
    return ++this.#handle;
  }

  get active(): boolean {
    return this.tables.length > 0;
  }

  /** Live connections, oldest first, like `conntrack -L`. */
  connections(): Conn[] {
    this.#expire();
    const seen = new Set<Conn>();
    for (const { conn } of this.#conns.values()) seen.add(conn);
    return [...seen];
  }

  flushConntrack(): void {
    this.#conns.clear();
  }

  // ------------------------------------------------------------- packet path

  /** First hook of a packet (prerouting, or output for local packets): conntrack and DNAT. */
  enter(packet: Ipv4Packet, where: Where): { t: Tracked; verdict: Verdict } {
    const t = this.#track(packet);
    this.#translate(t, 'dst');
    const verdict = this.#run(t, where);
    return { t, verdict };
  }

  /** Filter hooks in the middle of the path: input or forward. */
  filter(t: Tracked, where: Where): Verdict {
    return this.#run(t, where);
  }

  /** Last hook (postrouting, or input for local delivery): SNAT and confirming the connection. */
  leave(t: Tracked, where: Where): Verdict {
    const verdict = this.#run(t, where);
    if (verdict !== 'accept') return verdict;
    this.#reserve(t);
    this.#translate(t, 'src');
    this.#confirm(t);
    return 'accept';
  }

  #track(packet: Ipv4Packet): Tracked {
    this.#expire();
    const l4 = packet.payload;
    if (l4.kind === 'icmp' && (l4.type === 'time-exceeded' || l4.type === 'dest-unreachable')) {
      // An error about a tracked packet is RELATED to its connection.
      const inner = tupleOf(l4.original);
      const found = inner && this.#conns.get(key(swap(inner)));
      if (!found)
        return { packet, conn: null, dir: 'orig', state: 'invalid', related: true, fresh: false };
      return {
        packet,
        conn: found.conn,
        dir: found.dir,
        state: 'related',
        related: true,
        fresh: false,
      };
    }
    const tuple = tupleOf(packet);
    if (!tuple) {
      return { packet, conn: null, dir: 'orig', state: 'untracked', related: false, fresh: false };
    }
    const found = this.#conns.get(key(tuple));
    const now = this.scheduler.now;
    if (found) {
      found.conn.last = now;
      if (found.dir === 'reply' && !found.conn.replied) {
        found.conn.replied = true;
        this.changed();
      }
      const state = found.conn.replied ? 'established' : 'new';
      return { packet, conn: found.conn, dir: found.dir, state, related: false, fresh: false };
    }
    const conn: Conn = { orig: tuple, reply: swap(tuple), replied: false, last: now };
    return { packet, conn, dir: 'orig', state: 'new', related: false, fresh: true };
  }

  /** Rewrites the destination (`dst`) or source (`src`) side as the connection's NAT says. */
  #translate(t: Tracked, side: 'src' | 'dst'): void {
    const conn = t.conn;
    if (!conn) return;
    // A packet arrives looking like `have` and must leave looking like the reverse of what
    // the other direction expects (`want`).
    const have = t.dir === 'orig' ? conn.orig : conn.reply;
    const want = t.dir === 'orig' ? swap(conn.reply) : swap(conn.orig);
    const p = t.packet;
    const l4 = p.payload;
    if (t.related) {
      // An ICMP error: fix the outer address that belongs to the connection (the error may
      // come from a router on the way) and the copy of the packet it carries.
      if (l4.kind !== 'icmp' || !('original' in l4)) return;
      const inner = tupleOf(l4.original);
      if (!inner) return;
      if (side === 'dst') {
        if (p.dst !== have.dst) return;
        const original = withTuple(l4.original, { ...inner, src: want.dst, sport: want.dport });
        t.packet = { ...p, dst: want.dst, payload: { ...l4, original } };
      } else {
        const original = withTuple(l4.original, { ...inner, dst: want.src, dport: want.sport });
        const src = p.src === have.src ? want.src : p.src;
        t.packet = { ...p, src, payload: { ...l4, original } };
      }
      return;
    }
    const tuple = tupleOf(p);
    if (!tuple) return;
    t.packet = withTuple(
      p,
      side === 'dst'
        ? { ...tuple, dst: want.dst, dport: want.dport }
        : { ...tuple, src: want.src, sport: want.sport },
    );
  }

  /** Two connections must not share a reply tuple: pick another source port, like Linux. */
  #reserve(t: Tracked): void {
    const conn = t.conn;
    if (!conn || !t.fresh) return;
    for (let n = 0; this.#conns.has(key(conn.reply)) && n < 64512; n++) {
      conn.reply = {
        ...conn.reply,
        dport: conn.reply.dport >= 65535 ? 1024 : conn.reply.dport + 1,
      };
    }
  }

  #confirm(t: Tracked): void {
    const conn = t.conn;
    if (!conn || !t.fresh || this.#conns.has(key(conn.orig))) return;
    this.#conns.set(key(conn.orig), { conn, dir: 'orig' });
    this.#conns.set(key(conn.reply), { conn, dir: 'reply' });
    this.changed();
  }

  #expire(): void {
    const now = this.scheduler.now;
    for (const [k, { conn }] of this.#conns) {
      if (now - conn.last > TIMEOUT_S[conn.orig.proto] * 1000) this.#conns.delete(k);
    }
  }

  // ------------------------------------------------------------------ rules

  /** Runs the base chains of one hook in priority order. */
  #run(t: Tracked, where: Where): Verdict {
    const chains = this.tables
      .flatMap((table) => table.chains)
      .filter((c) => c.base?.hook === where.hook)
      .sort((a, b) => (a.base?.priority ?? 0) - (b.base?.priority ?? 0));
    for (const chain of chains) {
      const base = chain.base;
      if (!base) continue;
      // NAT chains only see the first packet of a connection.
      if (base.type === 'nat' && !t.fresh) continue;
      const verdict = this.#chain(chain, base, t, where);
      if (verdict !== 'accept') return verdict;
    }
    return 'accept';
  }

  #chain(chain: Chain, base: BaseChain, t: Tracked, where: Where): Verdict {
    for (const rule of chain.rules) {
      if (!rule.matches.every((m) => this.#matches(m, t, where))) continue;
      if (rule.counter) {
        rule.counter.packets++;
        rule.counter.bytes += packetBytes(t.packet);
        this.changed();
      }
      const a = rule.action;
      switch (a.kind) {
        case 'none':
          continue;
        case 'accept':
        case 'drop':
        case 'reject':
          return a.kind;
        case 'masquerade':
        case 'snat': {
          const addr = a.kind === 'snat' ? a.addr : where.out && this.addressOn(where.out);
          if (t.conn && addr !== null) {
            const port = a.kind === 'snat' && a.port !== null ? a.port : t.conn.reply.dport;
            t.conn.reply = { ...t.conn.reply, dst: addr, dport: port };
          }
          return 'accept';
        }
        case 'dnat':
          if (t.conn) {
            t.conn.reply = { ...t.conn.reply, src: a.addr, sport: a.port ?? t.conn.reply.sport };
            this.#translate(t, 'dst');
          }
          return 'accept';
      }
    }
    return base.policy;
  }

  #matches(m: Match, t: Tracked, where: Where): boolean {
    const p = t.packet;
    const l4 = p.payload;
    switch (m.kind) {
      case 'iifname':
        return (where.in?.name === m.name) !== m.neg;
      case 'oifname':
        return (where.out?.name === m.name) !== m.neg;
      case 'saddr':
        return inSubnet(p.src, m.cidr) !== m.neg;
      case 'daddr':
        return inSubnet(p.dst, m.cidr) !== m.neg;
      case 'l4proto':
        return (l4.kind === m.proto) !== m.neg;
      case 'port': {
        if (l4.kind !== m.proto) return false;
        const value = m.field === 'sport' ? l4.srcPort : l4.dstPort;
        return m.ports.includes(value) !== m.neg;
      }
      case 'icmp': {
        if (l4.kind !== 'icmp') return false;
        const type = l4.type === 'dest-unreachable' ? 'destination-unreachable' : l4.type;
        return m.types.includes(type);
      }
      case 'ct':
        return m.states.includes(t.state) !== m.neg;
    }
  }
}
