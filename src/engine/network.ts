import { formatCidr, macFromIndex, parseCidr } from './addr.ts';
import { Device, type Fabric } from './device.ts';
import type { EthernetFrame } from './packet.ts';
import { MEDIUM_OF, cableError, hasCarrier, peerOf, type Link, type Port } from './port.ts';
import { Scheduler } from './scheduler.ts';
import { SPECS, type SpecId } from './specs.ts';

/** One-way propagation delay of every cable, in virtual ms. */
export const LINK_DELAY_MS = 0.25;
// shortcut: keeps only the most recent frames; persist or page the trace if users need full history.
export const TRACE_LIMIT = 1000;

export interface TraceEntry {
  seq: number;
  time: number;
  linkId: string;
  from: { device: string; port: string };
  to: { device: string; port: string };
  frame: EthernetFrame;
}

export interface NetworkSnapshot {
  devices: {
    id: string;
    spec: SpecId;
    name: string;
    ports: { name: string; mac: string; up: boolean; addrs?: string[] }[];
  }[];
  links: { id: string; a: { device: string; port: string }; b: { device: string; port: string } }[];
  counters: { device: number; link: number; mac: number; names: Record<string, number> };
}

export class Network implements Fabric {
  readonly scheduler = new Scheduler();
  readonly devices = new Map<string, Device>();
  readonly links = new Map<string, Link>();
  trace: TraceEntry[] = [];
  /** Increments on every observable change; lets the UI re-render cheaply. */
  version = 0;
  #counters = { device: 0, link: 0, mac: 0, trace: 0, names: {} as Record<string, number> };
  #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed(): void {
    this.version++;
    for (const listener of this.#listeners) listener();
  }

  addDevice(specId: SpecId, name?: string): Device {
    const spec = SPECS[specId];
    const macs = spec.ports.map(() => macFromIndex(++this.#counters.mac));
    const n = (this.#counters.names[spec.namePrefix] ?? 0) + 1;
    this.#counters.names[spec.namePrefix] = n;
    const device = new Device(
      this,
      this.#nextId('d'),
      name ?? `${spec.namePrefix}${n}`,
      spec,
      macs,
    );
    this.devices.set(device.id, device);
    this.changed();
    return device;
  }

  rename(device: Device, name: string): void {
    device.name = name;
    this.changed();
  }

  /**
   * Cables two ports. Passing a device picks its first free port that fits the other end.
   * Throws an Error with a user-facing message when the cable is not allowed.
   */
  connect(a: Port | Device, b: Port | Device): Link {
    const [pa, pb] = this.#pickPorts(a, b);
    const error = cableError(pa, pb);
    if (error) throw new Error(error);
    if (this.#l2Domain(pa).has(pb)) {
      throw new Error(
        `${pa.device.name} and ${pb.device.name} are already connected through switches. A second path would create a switching loop.`,
      );
    }
    return this.#attach(this.#nextId('l'), pa, pb);
  }

  /** Free ports of `device` that could take a cable from `from`. */
  freePortsFor(device: Device, from?: Port): Port[] {
    return device.ports.filter(
      (p) => !p.link && p !== from && (!from || MEDIUM_OF[p.type] === MEDIUM_OF[from.type]),
    );
  }

  disconnect(link: Link): void {
    if (!this.links.delete(link.id)) return;
    const hadCarrier = hasCarrier(link.a);
    link.a.link = null;
    link.b.link = null;
    if (hadCarrier) {
      link.a.device.carrierChanged(link.a);
      link.b.device.carrierChanged(link.b);
    }
    this.changed();
  }

  removeDevice(device: Device): void {
    for (const port of device.ports) if (port.link) this.disconnect(port.link);
    this.devices.delete(device.id);
    this.changed();
  }

  setPortUp(port: Port, up: boolean): void {
    if (port.adminUp === up) return;
    const before = hasCarrier(port);
    port.adminUp = up;
    if (before !== hasCarrier(port)) {
      port.device.carrierChanged(port);
      const peer = peerOf(port);
      if (peer) peer.device.carrierChanged(peer);
    }
    this.changed();
  }

  transmit(from: Port, frame: EthernetFrame): void {
    const link = from.link;
    if (!link || !hasCarrier(from)) return;
    this.scheduler.schedule(LINK_DELAY_MS, () => {
      if (from.link !== link || !hasCarrier(from)) return;
      const to = peerOf(from);
      if (!to) return;
      this.trace.push({
        seq: ++this.#counters.trace,
        time: this.scheduler.now,
        linkId: link.id,
        from: { device: from.device.id, port: from.name },
        to: { device: to.device.id, port: to.name },
        frame,
      });
      if (this.trace.length > TRACE_LIMIT) this.trace = this.trace.slice(-TRACE_LIMIT);
      to.device.receive(to, frame);
      this.changed();
    });
  }

  clearTrace(): void {
    this.trace = [];
    this.changed();
  }

  toJSON(): NetworkSnapshot {
    const { device, link, mac, names } = this.#counters;
    return {
      devices: [...this.devices.values()].map((d) => ({
        id: d.id,
        spec: d.spec.id,
        name: d.name,
        ports: d.ports.map((p) => ({
          name: p.name,
          mac: p.mac,
          up: p.adminUp,
          ...(d.ip?.ports.includes(p) ? { addrs: d.ip.addrsOn(p).map(formatCidr) } : {}),
        })),
      })),
      links: [...this.links.values()].map((l) => ({
        id: l.id,
        a: { device: l.a.device.id, port: l.a.name },
        b: { device: l.b.device.id, port: l.b.name },
      })),
      counters: { device, link, mac, names: { ...names } },
    };
  }

  /** Rebuilds a network. Throws if the snapshot is inconsistent. */
  static fromJSON(snapshot: NetworkSnapshot): Network {
    const net = new Network();
    for (const d of snapshot.devices) {
      if (net.devices.has(d.id)) throw new Error(`Duplicate device id ${d.id}`);
      const spec = SPECS[d.spec];
      if (!spec) throw new Error(`Unknown device type ${String(d.spec)}`);
      if (d.ports.length !== spec.ports.length) {
        throw new Error(`Device ${d.id} has the wrong number of ports`);
      }
      const device = new Device(
        net,
        d.id,
        d.name,
        spec,
        d.ports.map((p) => p.mac),
      );
      d.ports.forEach((p, i) => {
        const port = device.ports[i];
        if (!port || port.name !== p.name) throw new Error(`Unknown port ${p.name} on ${d.id}`);
        port.adminUp = p.up;
        for (const text of p.addrs ?? []) {
          const cidr = parseCidr(text);
          if (!cidr) throw new Error(`Invalid address ${text} on ${d.id}`);
          if (!device.ip?.ports.includes(port))
            throw new Error(`${d.id} ${p.name} cannot have an address`);
          device.ip.addAddress(port, cidr);
        }
      });
      net.devices.set(device.id, device);
    }
    for (const l of snapshot.links) {
      const pa = net.devices.get(l.a.device)?.port(l.a.port);
      const pb = net.devices.get(l.b.device)?.port(l.b.port);
      if (!pa || !pb || cableError(pa, pb)) throw new Error(`Invalid link ${l.id}`);
      net.#attach(l.id, pa, pb);
    }
    net.#counters = { ...snapshot.counters, names: { ...snapshot.counters.names }, trace: 0 };
    net.version = 0;
    return net;
  }

  /** Ids come from counters, skipping any already taken (e.g. by an imported file). */
  #nextId(prefix: 'd' | 'l'): string {
    const key = prefix === 'd' ? 'device' : 'link';
    let id: string;
    do id = `${prefix}${++this.#counters[key]}`;
    while (this.devices.has(id) || this.links.has(id));
    return id;
  }

  #attach(id: string, a: Port, b: Port): Link {
    const link: Link = { id, a, b, medium: MEDIUM_OF[a.type] };
    a.link = link;
    b.link = link;
    this.links.set(id, link);
    if (hasCarrier(a)) {
      a.device.carrierChanged(a);
      b.device.carrierChanged(b);
    }
    this.changed();
    return link;
  }

  #pickPorts(a: Port | Device, b: Port | Device): [Port, Port] {
    const pick = (end: Port | Device, other: Port | Device): Port => {
      if (!(end instanceof Device)) return end;
      const free = this.freePortsFor(end, other instanceof Device ? undefined : other);
      const port = free[0];
      if (!port) throw new Error(`${end.name} has no free port for this cable.`);
      return port;
    };
    const pa = pick(a, b);
    return [pa, pick(b, pa)];
  }

  /**
   * Ports in the same broadcast domain as `start`: across cables and through bridges.
   * Linking two ports of one domain makes a loop that floods frames forever (no STP yet).
   */
  #l2Domain(start: Port): Set<Port> {
    const seen = new Set<Port>();
    const queue = [start];
    for (let p = queue.pop(); p; p = queue.pop()) {
      if (seen.has(p)) continue;
      seen.add(p);
      const peer = peerOf(p);
      if (peer) queue.push(peer);
      if (p.device.bridge?.owns(p)) queue.push(...p.device.bridge.ports);
    }
    return seen;
  }
}
