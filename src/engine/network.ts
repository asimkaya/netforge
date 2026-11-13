import { formatCidr, macFromIndex, parseCidr } from './addr.ts';
import { hasCarrier, peerOf, type Device, type Fabric, type Link, type Port } from './device.ts';
import { Host } from './host.ts';
import type { EthernetFrame } from './packet.ts';
import { Scheduler } from './scheduler.ts';
import { SWITCH_PORT_COUNT, Switch } from './switch.ts';

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
    kind: 'host' | 'switch';
    name: string;
    ports: { name: string; mac: string; up: boolean; addrs?: string[] }[];
  }[];
  links: { id: string; a: { device: string; port: string }; b: { device: string; port: string } }[];
  counters: { device: number; link: number; mac: number; host: number; switch: number };
}

export class Network implements Fabric {
  readonly scheduler = new Scheduler();
  readonly devices = new Map<string, Device>();
  readonly links = new Map<string, Link>();
  trace: TraceEntry[] = [];
  /** Increments on every observable change; lets the UI re-render cheaply. */
  version = 0;
  #counters = { device: 0, link: 0, mac: 0, host: 0, switch: 0, trace: 0 };
  #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed(): void {
    this.version++;
    for (const listener of this.#listeners) listener();
  }

  addHost(name?: string): Host {
    const host = new Host(
      this,
      this.#nextId('d'),
      name ?? `pc${++this.#counters.host}`,
      macFromIndex(++this.#counters.mac),
    );
    this.devices.set(host.id, host);
    this.changed();
    return host;
  }

  addSwitch(name?: string): Switch {
    const macs = Array.from({ length: SWITCH_PORT_COUNT }, () =>
      macFromIndex(++this.#counters.mac),
    );
    const sw = new Switch(this, this.#nextId('d'), name ?? `sw${++this.#counters.switch}`, macs);
    this.devices.set(sw.id, sw);
    this.changed();
    return sw;
  }

  rename(device: Device, name: string): void {
    device.name = name;
    this.changed();
  }

  /** Cables two devices using the first free port on each. Throws a user-facing Error. */
  connect(a: Device, b: Device): Link {
    if (a === b) throw new Error('A device cannot be connected to itself.');
    const pa = a.ports.find((p) => !p.link);
    const pb = b.ports.find((p) => !p.link);
    if (!pa) throw new Error(`${a.name} has no free port.`);
    if (!pb) throw new Error(`${b.name} has no free port.`);
    // Hosts have one port, so any cycle runs through switches and would loop frames forever.
    if (this.#reachable(a, b)) {
      throw new Error(
        `${a.name} and ${b.name} are already connected. A second path would create a switching loop.`,
      );
    }
    return this.#attach(this.#nextId('l'), pa, pb);
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
    const { device, link, mac, host, switch: sw } = this.#counters;
    return {
      devices: [...this.devices.values()].map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        ports: d.ports.map((p) => ({
          name: p.name,
          mac: p.mac,
          up: p.adminUp,
          ...(d instanceof Host ? { addrs: d.addrsOn(p).map(formatCidr) } : {}),
        })),
      })),
      links: [...this.links.values()].map((l) => ({
        id: l.id,
        a: { device: l.a.device.id, port: l.a.name },
        b: { device: l.b.device.id, port: l.b.name },
      })),
      counters: { device, link, mac, host, switch: sw },
    };
  }

  /** Rebuilds a network. Throws if the snapshot is inconsistent. */
  static fromJSON(snapshot: NetworkSnapshot): Network {
    const net = new Network();
    for (const d of snapshot.devices) {
      if (net.devices.has(d.id)) throw new Error(`Duplicate device id ${d.id}`);
      const macs = d.ports.map((p) => p.mac);
      const device =
        d.kind === 'host'
          ? new Host(net, d.id, d.name, macs[0] ?? macFromIndex(0))
          : new Switch(net, d.id, d.name, macs);
      if (device.ports.length !== d.ports.length) {
        throw new Error(`Device ${d.id} has the wrong number of ports`);
      }
      d.ports.forEach((p, i) => {
        const port = device.ports[i];
        if (!port || port.name !== p.name) throw new Error(`Unknown port ${p.name} on ${d.id}`);
        port.adminUp = p.up;
        if (device instanceof Host) {
          for (const text of p.addrs ?? []) {
            const cidr = parseCidr(text);
            if (!cidr) throw new Error(`Invalid address ${text} on ${d.id}`);
            device.addAddress(port, cidr);
          }
        }
      });
      net.devices.set(device.id, device);
    }
    for (const l of snapshot.links) {
      const pa = net.devices.get(l.a.device)?.port(l.a.port);
      const pb = net.devices.get(l.b.device)?.port(l.b.port);
      if (!pa || !pb || pa.link || pb.link || pa === pb) throw new Error(`Invalid link ${l.id}`);
      net.#attach(l.id, pa, pb);
    }
    net.#counters = { ...snapshot.counters, trace: 0 };
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
    const link: Link = { id, a, b };
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

  #reachable(from: Device, to: Device): boolean {
    const seen = new Set<Device>([from]);
    const queue = [from];
    for (let d = queue.shift(); d; d = queue.shift()) {
      if (d === to) return true;
      for (const port of d.ports) {
        const next = peerOf(port)?.device;
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }
}
