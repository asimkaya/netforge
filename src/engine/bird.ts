import { formatCidr, inSubnet, networkOf, parseIp, type Cidr, type Ip } from './addr.ts';
import type { Fabric } from './device.ts';
import type { IpStack } from './ip.ts';
import type { Ipv4Packet, OspfLink, OspfLsa, OspfPacket } from './packet.ts';
import { hasCarrier, type Port } from './port.ts';

/**
 * The BIRD routing daemon running OSPFv2 in one area: hellos find neighbors, every router
 * floods a link-state advertisement, and each one runs Dijkstra to install the shortest
 * paths into the kernel table. Simplified: neighbors become Full right after two-way
 * hellos (no DR/BDR election, no database description exchange), and LSAs never age.
 * See docs/FEATURES.md and ADR 0007.
 */

/** AllSPFRouters, and the Ethernet multicast MAC it maps to. */
export const OSPF_ALL_ROUTERS: Ip = 0xe0000005;
export const OSPF_MAC = '01:00:5e:00:00:05';
export const HELLO_MS = 10_000;
export const DEAD_MS = 40_000;
/** BIRD's default interface cost. */
export const DEFAULT_COST = 10;
export const BIRD_CONF = '/etc/bird.conf';

export interface BirdConfig {
  routerId: Ip | null;
  /** Whether `protocol kernel` exports routes into the kernel table (`export all`). */
  kernelExport: boolean;
  ospf: { area: number; interfaces: { pattern: string; cost: number }[] } | null;
}

/** Reads the parts of bird.conf NetForge understands. Returns an error in BIRD's words. */
export function parseBirdConf(text: string): BirdConfig | string {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#.*$/gm, '');
  let depth = 0;
  for (const c of clean) {
    if (c === '{') depth++;
    if (c === '}' && --depth < 0) break;
  }
  if (depth !== 0) return `${BIRD_CONF}: syntax error, unbalanced braces`;
  const idText = /router\s+id\s+([\d.]+)\s*;/.exec(clean)?.[1];
  const routerId = idText === undefined ? null : parseIp(idText);
  if (idText !== undefined && routerId === null) {
    return `${BIRD_CONF}: Invalid router ID ${idText}`;
  }
  const kernelExport = /protocol\s+kernel[^{]*\{[\s\S]*?export\s+all/.test(clean);
  const start = /protocol\s+ospf\b[^{]*\{/.exec(clean);
  if (!start) return { routerId, kernelExport, ospf: null };
  const body = block(clean, start.index + start[0].length);
  const areaText = /area\s+([\d.]+)\s*\{/.exec(body)?.[1] ?? '0';
  const area = areaText.includes('.') ? (parseIp(areaText) ?? 0) : Number(areaText);
  const interfaces: { pattern: string; cost: number }[] = [];
  const re = /interface\s+"([^"]+)"\s*(\{([^}]*)\})?/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const cost = Number(/cost\s+(\d+)/.exec(m[3] ?? '')?.[1] ?? DEFAULT_COST);
    if (!(cost >= 1 && cost <= 65535)) return `${BIRD_CONF}: Cost must be in range 1-65535`;
    interfaces.push({ pattern: m[1] ?? '', cost });
  }
  return { routerId, kernelExport, ospf: { area, interfaces } };
}

/** Text from `from` up to its matching closing brace. */
function block(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** `eth*` style interface patterns. */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(name);
}

export interface OspfNeighbor {
  routerId: Ip;
  /** The neighbor's address on the shared network. */
  addr: Ip;
  port: Port;
  full: boolean;
  lastSeen: number;
}

/** A route BIRD learned, as `birdc show route` and the kernel table show it. */
export interface BirdRoute {
  dst: Cidr;
  via: Ip;
  dev: Port;
  cost: number;
  since: number;
  /** The router that advertised the network. */
  origin: Ip;
}

export class Bird {
  readonly neighbors: OspfNeighbor[] = [];
  readonly lsdb = new Map<Ip, OspfLsa>();
  routes: BirdRoute[] = [];
  readonly started: number;
  #seq = 0;
  #timer: number | null = null;

  private constructor(
    readonly fabric: Fabric,
    readonly stack: IpStack,
    readonly config: BirdConfig,
    readonly args: string[],
  ) {
    this.started = fabric.scheduler.now;
  }

  /** Starts BIRD with a parsed config. */
  static start(fabric: Fabric, stack: IpStack, config: BirdConfig, args: string[]): Bird {
    const bird = new Bird(fabric, stack, config, args);
    if (config.ospf) bird.#tick();
    return bird;
  }

  stop(): void {
    if (this.#timer !== null) this.fabric.scheduler.cancel(this.#timer);
    this.#timer = null;
    this.routes = [];
    this.stack.dynamicRoutes = [];
    this.fabric.changed();
  }

  /** The router id: configured, else the lowest interface address (BIRD picks one too). */
  get routerId(): Ip {
    if (this.config.routerId !== null) return this.config.routerId;
    const addrs = this.stack.allAddrs().map((a) => a.ip);
    return addrs.length > 0 ? Math.min(...addrs) : 0;
  }

  get area(): number {
    return this.config.ospf?.area ?? 0;
  }

  /** OSPF interfaces: configured, with an address. */
  ospfPorts(): { port: Port; cost: number; addr: Cidr }[] {
    const ifaces = this.config.ospf?.interfaces ?? [];
    return this.stack.ports.flatMap((port) => {
      const conf = ifaces.find((i) => globMatch(i.pattern, port.name));
      const addr = this.stack.addrsOn(port)[0];
      return conf && addr ? [{ port, cost: conf.cost, addr }] : [];
    });
  }

  carrierChanged(port: Port): void {
    if (!this.config.ospf) return;
    const before = this.neighbors.length;
    this.#drop((n) => n.port === port && !hasCarrier(port));
    if (hasCarrier(port)) this.#helloOn(port);
    if (before !== this.neighbors.length || hasCarrier(port)) this.#originate();
  }

  receive(packet: Ipv4Packet, port: Port): void {
    const o = packet.payload;
    if (o.kind !== 'ospf' || o.area !== this.area || o.routerId === this.routerId) return;
    const iface = this.ospfPorts().find((i) => i.port === port);
    if (!iface || !inSubnet(packet.src, iface.addr)) return;
    if (o.type === 'hello') this.#hello(o.routerId, o.neighbors, packet.src, port);
    else this.#update(o.lsas, port);
  }

  #hello(routerId: Ip, seen: Ip[], addr: Ip, port: Port): void {
    const now = this.fabric.scheduler.now;
    let n = this.neighbors.find((x) => x.port === port && x.routerId === routerId);
    if (!n) {
      n = { routerId, addr, port, full: false, lastSeen: now };
      this.neighbors.push(n);
      // Answer at once so the new neighbor sees us without waiting for the next hello.
      this.#helloOn(port);
      this.fabric.changed();
    }
    n.lastSeen = now;
    n.addr = addr;
    const twoWay = seen.includes(this.routerId);
    if (twoWay && !n.full) {
      n.full = true;
      // Synchronize: send everything we know, then announce the new adjacency.
      this.#send(port, { type: 'lsu', lsas: [...this.lsdb.values()] });
      this.#originate();
    } else if (!twoWay && n.full) {
      n.full = false;
      this.#originate();
    }
  }

  #update(lsas: OspfLsa[], from: Port): void {
    let changed = false;
    for (const lsa of lsas) {
      if (lsa.routerId === this.routerId) {
        // An old copy of our own LSA (we restarted): jump past its sequence number.
        if (lsa.seq >= this.#seq) {
          this.#seq = lsa.seq;
          this.#originate();
        }
        continue;
      }
      const known = this.lsdb.get(lsa.routerId);
      if (known && known.seq >= lsa.seq) continue;
      this.lsdb.set(lsa.routerId, lsa);
      changed = true;
      this.#flood([lsa], from);
    }
    if (changed) this.#spf();
  }

  /** Builds and floods our own router LSA. */
  #originate(): void {
    const links: OspfLink[] = [];
    for (const { port, cost, addr } of this.ospfPorts()) {
      if (!hasCarrier(port)) continue;
      links.push({ kind: 'stub', net: networkOf(addr), prefix: addr.prefix, cost });
      for (const n of this.neighbors) {
        if (n.port === port && n.full) links.push({ kind: 'router', id: n.routerId, cost });
      }
    }
    const lsa: OspfLsa = { routerId: this.routerId, seq: ++this.#seq, links };
    this.lsdb.set(lsa.routerId, lsa);
    this.#flood([lsa]);
    this.#spf();
  }

  #flood(lsas: OspfLsa[], except?: Port): void {
    for (const { port } of this.ospfPorts()) {
      if (port !== except && this.neighbors.some((n) => n.port === port && n.full)) {
        this.#send(port, { type: 'lsu', lsas });
      }
    }
  }

  /** Dijkstra over two-way router links, then a route to every network not our own. */
  #spf(): void {
    const me = this.routerId;
    const dist = new Map<Ip, number>([[me, 0]]);
    const firstHop = new Map<Ip, { via: Ip; dev: Port }>();
    const done = new Set<Ip>();
    for (;;) {
      let current: Ip | null = null;
      for (const [id, d] of dist) {
        if (!done.has(id) && (current === null || d < (dist.get(current) ?? Infinity)))
          current = id;
      }
      if (current === null) break;
      done.add(current);
      const lsa = this.lsdb.get(current);
      for (const link of lsa?.links ?? []) {
        if (link.kind !== 'router') continue;
        const back = this.lsdb
          .get(link.id)
          ?.links.some((l) => l.kind === 'router' && l.id === current);
        if (!back) continue;
        const d = (dist.get(current) ?? 0) + link.cost;
        if (d >= (dist.get(link.id) ?? Infinity)) continue;
        dist.set(link.id, d);
        if (current === me) {
          const n = this.neighbors.find((x) => x.routerId === link.id && x.full);
          if (n) firstHop.set(link.id, { via: n.addr, dev: n.port });
        } else {
          const hop = firstHop.get(current);
          if (hop) firstHop.set(link.id, hop);
        }
      }
    }
    const own = this.stack.ports.flatMap((p) => (hasCarrier(p) ? this.stack.addrsOn(p) : []));
    const best = new Map<string, BirdRoute>();
    const now = this.fabric.scheduler.now;
    for (const [id, d] of dist) {
      const hop = firstHop.get(id);
      if (id === me || !hop) continue;
      for (const link of this.lsdb.get(id)?.links ?? []) {
        if (link.kind !== 'stub') continue;
        const dst = { ip: link.net, prefix: link.prefix };
        if (own.some((a) => networkOf(a) === dst.ip && a.prefix === dst.prefix)) continue;
        const key = formatCidr(dst);
        const cost = d + link.cost;
        const old = best.get(key);
        if (!old || cost < old.cost) {
          const kept = this.routes.find((r) => formatCidr(r.dst) === key && r.via === hop.via);
          const since = kept?.since ?? now;
          best.set(key, { dst, via: hop.via, dev: hop.dev, cost, since, origin: id });
        }
      }
    }
    this.routes = [...best.values()].sort((a, b) => a.dst.ip - b.dst.ip);
    this.stack.dynamicRoutes = this.config.kernelExport ? this.routes : [];
    this.fabric.changed();
  }

  #tick(): void {
    const now = this.fabric.scheduler.now;
    const lost = this.#drop((n) => now - n.lastSeen >= DEAD_MS);
    for (const { port } of this.ospfPorts()) if (hasCarrier(port)) this.#helloOn(port);
    // New or removed addresses change our LSA.
    const mine = this.lsdb.get(this.routerId);
    const stubs = this.ospfPorts().filter((i) => hasCarrier(i.port)).length;
    const advertised = mine?.links.filter((l) => l.kind === 'stub').length ?? -1;
    if (lost || stubs !== advertised) this.#originate();
    this.#timer = this.fabric.scheduler.schedule(HELLO_MS, () => this.#tick());
  }

  /** Removes neighbors matching `gone`. Returns true if any were full. */
  #drop(gone: (n: OspfNeighbor) => boolean): boolean {
    let full = false;
    for (let i = this.neighbors.length - 1; i >= 0; i--) {
      const n = this.neighbors[i];
      if (n && gone(n)) {
        full ||= n.full;
        this.neighbors.splice(i, 1);
      }
    }
    if (full) this.fabric.changed();
    return full;
  }

  #helloOn(port: Port): void {
    const seen = this.neighbors.filter((n) => n.port === port).map((n) => n.routerId);
    this.#send(port, { type: 'hello', neighbors: seen });
  }

  #send(
    port: Port,
    body: { type: 'hello'; neighbors: Ip[] } | { type: 'lsu'; lsas: OspfLsa[] },
  ): void {
    const src = this.stack.addrsOn(port)[0]?.ip;
    if (src === undefined || !hasCarrier(port)) return;
    const payload: OspfPacket = { kind: 'ospf', routerId: this.routerId, area: this.area, ...body };
    this.stack.multicast(port, src, OSPF_ALL_ROUTERS, OSPF_MAC, payload);
  }
}
