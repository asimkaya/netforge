import { formatCidr, formatIp, macFromIndex, parseCidr, parseIp } from './addr.ts';
import { defaultVlans, type Bridge } from './bridge.ts';
import { Device, type Fabric } from './device.ts';
import { formatCidr6, formatIp6, parseCidr6, parseIp6 } from './addr6.ts';
import type { Ip6Stack } from './ip6.ts';
import { isKey } from './wireguard.ts';
import { formatRuleset, runNft } from './nft.ts';
import { DEFAULT_PRIORITY } from './stp.ts';
import type { EthernetFrame } from './packet.ts';
import { MEDIUM_OF, cableError, hasCarrier, peerOf, type Link, type Port } from './port.ts';
import { Scheduler } from './scheduler.ts';
import { run } from './shell.ts';
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
    /** Running services and their command-line arguments. */
    services?: {
      dnsmasq?: string[];
      httpd?: string[];
      postfix?: string[];
      dovecot?: string[];
      hostapd?: string[];
      bird?: string[];
      radvd?: string[];
      sshd?: string[];
    };
    /** Files on the device (absolute path to text). */
    files?: Record<string, string>;
    /** IPv6 settings: static addresses per interface, static routes, forwarding. */
    ip6?: {
      forwarding: boolean;
      addrs: Record<string, string[]>;
      routes: { dst: string; via?: string; dev: string }[];
    };
    /** The nftables ruleset, as `nft list ruleset` prints it. */
    firewall?: string;
    /** Addresses of the bridge's own interface (`br0`), on home routers. */
    bridgeAddrs?: string[];
    /** WireGuard interfaces with their keys and peers. */
    wireguard?: {
      name: string;
      up: boolean;
      addrs: string[];
      privateKey: string | null;
      listenPort: number | null;
      peers: { publicKey: string; endpoint?: string; allowedIps: string[]; keepalive?: number }[];
    }[];
    /** VLAN interfaces (`eth0.10`), in creation order. */
    vlanPorts?: { name: string; parent: string; vid: number; up: boolean; addrs: string[] }[];
    /** Switch VLAN settings, when they differ from the defaults. */
    bridge?: {
      vlanFiltering: boolean;
      /** Spanning Tree on, and the bridge priority. */
      stp?: boolean;
      priority?: number;
      vlans: Record<string, { vids: number[]; pvid: number | null; untagged: number[] }>;
    };
    /** IP settings beyond addresses; absent on devices without an IP stack. */
    ip?: {
      forwarding: boolean;
      dns: string[];
      routes: { dst: string; via?: string; dev: string }[];
    };
  }[];
  links: { id: string; a: { device: string; port: string }; b: { device: string; port: string } }[];
  counters: { device: number; link: number; mac: number; names: Record<string, number> };
}

type BridgeSnapshot = NonNullable<NetworkSnapshot['devices'][number]['bridge']>;
type Ip6Snapshot = NonNullable<NetworkSnapshot['devices'][number]['ip6']>;
type WgSnapshot = NonNullable<NetworkSnapshot['devices'][number]['wireguard']>[number];

function wireguardJSON(device: Device): WgSnapshot[] {
  return device.vlanPorts.flatMap((port) => {
    const wg = device.wireguard(port);
    if (!wg) return [];
    return [
      {
        name: port.name,
        up: port.adminUp,
        addrs: device.ip?.addrsOn(port).map(formatCidr) ?? [],
        privateKey: wg.privateKey,
        listenPort: wg.listenPort,
        peers: wg.peers.map((p) => ({
          publicKey: p.publicKey,
          ...(p.endpoint ? { endpoint: `${formatIp(p.endpoint.ip)}:${p.endpoint.port}` } : {}),
          allowedIps: p.allowedIps.map(formatCidr),
          ...(p.keepalive ? { keepalive: p.keepalive } : {}),
        })),
      },
    ];
  });
}

function loadWireguard(device: Device, saved: WgSnapshot): void {
  const bad = (what: string) => new Error(`Invalid WireGuard ${what} on ${device.id}`);
  if (device.addWireguard(saved.name)) throw bad('interface');
  const port = device.port(saved.name);
  const wg = device.wireguard(port);
  if (!port || !wg || !device.ip) throw bad('interface');
  if (saved.listenPort !== null && wg.setListenPort(saved.listenPort)) throw bad('port');
  if (saved.privateKey !== null) {
    if (!isKey(saved.privateKey)) throw bad('key');
    wg.setPrivateKey(saved.privateKey);
  }
  for (const p of saved.peers) {
    if (!isKey(p.publicKey)) throw bad('peer');
    const peer = wg.peer(p.publicKey);
    if (p.endpoint !== undefined) {
      const [host, portText] = p.endpoint.split(':');
      const ip = host === undefined ? null : parseIp(host);
      const n = Number(portText);
      if (ip === null || !Number.isInteger(n) || n < 1 || n > 65535) throw bad('endpoint');
      peer.endpoint = { ip, port: n };
    }
    peer.allowedIps = p.allowedIps.map((text) => {
      const cidr = parseCidr(text);
      if (!cidr) throw bad('allowed IP');
      return cidr;
    });
    peer.keepalive = p.keepalive ?? null;
  }
  for (const text of saved.addrs) {
    const cidr = parseCidr(text);
    if (!cidr) throw bad('address');
    device.ip.addAddress(port, cidr);
  }
  port.adminUp = saved.up;
}

/** Static IPv6 settings; link-local and autoconfigured addresses come back by themselves. */
function ip6JSON(v6: Ip6Stack): Ip6Snapshot {
  const addrs: Record<string, string[]> = {};
  for (const [name, list] of v6.addrs) {
    const statics = list.filter((a) => a.origin === 'static').map((a) => formatCidr6(a.cidr));
    if (statics.length > 0) addrs[name] = statics;
  }
  return {
    forwarding: v6.forwarding,
    addrs,
    routes: v6.staticRoutes.map((r) => ({
      dst: formatCidr6(r.dst),
      ...(r.via === null ? {} : { via: formatIp6(r.via) }),
      dev: r.dev.name,
    })),
  };
}

function loadIp6(device: Device, saved: Ip6Snapshot): void {
  const v6 = device.ip?.v6;
  if (!v6) return;
  v6.forwarding = saved.forwarding;
  for (const [name, list] of Object.entries(saved.addrs)) {
    const port = device.port(name);
    for (const text of list) {
      const cidr = parseCidr6(text);
      if (!port || !cidr || v6.addAddress(port, cidr)) {
        throw new Error(`Invalid IPv6 address ${text} on ${device.id}`);
      }
    }
  }
  for (const r of saved.routes) {
    const dst = parseCidr6(r.dst);
    const via = r.via === undefined ? null : parseIp6(r.via);
    const dev = device.port(r.dev);
    if (!dst || (r.via !== undefined && via === null) || !dev || v6.addRoute(dst, via, dev)) {
      throw new Error(`Invalid IPv6 route ${r.dst} on ${device.id}`);
    }
  }
}

function isDefaultBridge(bridge: Bridge): boolean {
  const def = defaultVlans();
  const same = (a: Set<number>, b: Set<number>) =>
    a.size === b.size && [...a].every((x) => b.has(x));
  return (
    !bridge.vlanFiltering &&
    !bridge.stp.enabled &&
    bridge.stp.priority === DEFAULT_PRIORITY &&
    [...bridge.vlans.values()].every(
      (v) => v.pvid === def.pvid && same(v.vids, def.vids) && same(v.untagged, def.untagged),
    )
  );
}

function bridgeJSON(bridge: Bridge): BridgeSnapshot {
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return {
    vlanFiltering: bridge.vlanFiltering,
    stp: bridge.stp.enabled,
    priority: bridge.stp.priority,
    vlans: Object.fromEntries(
      [...bridge.vlans].map(([port, v]) => [
        port.name,
        { vids: sorted(v.vids), pvid: v.pvid, untagged: sorted(v.untagged) },
      ]),
    ),
  };
}

function loadBridge(bridge: Bridge, saved: BridgeSnapshot, id: string): void {
  bridge.vlanFiltering = saved.vlanFiltering;
  const priority = saved.priority ?? DEFAULT_PRIORITY;
  if (!Number.isInteger(priority) || priority < 0 || priority > 65535) {
    throw new Error(`Invalid bridge priority on ${id}`);
  }
  bridge.stp.priority = priority;
  if (saved.stp) bridge.stp.setEnabled(true);
  for (const [name, v] of Object.entries(saved.vlans)) {
    const port = bridge.ports.find((p) => p.name === name);
    const valid = (vid: number) => Number.isInteger(vid) && vid >= 1 && vid <= 4094;
    if (!port || !v.vids.every(valid) || !v.untagged.every((x) => v.vids.includes(x))) {
      throw new Error(`Invalid VLAN settings for ${name} on ${id}`);
    }
    if (v.pvid !== null && !v.vids.includes(v.pvid)) {
      throw new Error(`Invalid PVID for ${name} on ${id}`);
    }
    bridge.vlans.set(port, { vids: new Set(v.vids), pvid: v.pvid, untagged: new Set(v.untagged) });
  }
}

/** Every switch in the domain runs STP, so redundant cables are safe. */
function stpEverywhere(domain: Set<Port>): boolean {
  const bridges = new Set([...domain].flatMap((p) => (p.device.bridge ? [p.device.bridge] : [])));
  return bridges.size > 0 && [...bridges].every((b) => b.stp.enabled);
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
    // Ready-made devices (like the internet cloud) configure themselves with shell commands.
    for (const line of spec.setup ?? []) {
      run(this, device, line, {
        out: (text) => {
          if (/error|fatal|bad|cannot/i.test(text)) throw new Error(`${spec.id} setup: ${text}`);
        },
        exit: () => {},
      });
    }
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
    const domain = this.#l2Domain(pa);
    if (domain.has(pb) && !stpEverywhere(domain)) {
      throw new Error(
        `${pa.device.name} and ${pb.device.name} are already connected through switches. A second path would create a switching loop. Turn on Spanning Tree (STP) on the switches to allow redundant cables.`,
      );
    }
    return this.#attach(this.#nextId('l'), pa, pb);
  }

  /** Free ports of `device` that could take a cable from `from` (never Wi-Fi radios). */
  freePortsFor(device: Device, from?: Port): Port[] {
    return device.ports.filter(
      (p) =>
        !p.link &&
        p !== from &&
        p.type !== 'wifi' &&
        (!from || MEDIUM_OF[p.type] === MEDIUM_OF[from.type]),
    );
  }

  /**
   * Where a device sits on the canvas, for Wi-Fi range. The UI provides it; without it every
   * device counts as out of range.
   */
  locate: ((id: string) => { x: number; y: number } | null) | null = null;

  /** Links a client's Wi-Fi radio to a free radio slot of an access point. */
  associate(radio: Port, slot: Port): Link {
    const error = cableError(radio, slot, true);
    if (error) throw new Error(error);
    return this.#attach(this.#nextId('l'), radio, slot);
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
    if (from.bridgeSelf) {
      if (from.adminUp) from.device.bridge?.sendLocal(frame);
      return;
    }
    if (from.parent) {
      // A VLAN interface sends through its parent port with an 802.1Q tag.
      if (from.adminUp) this.transmit(from.parent, { ...frame, vlan: from.vid ?? 0 });
      return;
    }
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
        ...(d.ip
          ? {
              ip: {
                forwarding: d.ip.forwarding,
                dns: d.ip.dns.map(formatIp),
                routes: d.ip.staticRoutes.map((r) => ({
                  dst: formatCidr(r.dst),
                  ...(r.via === null ? {} : { via: formatIp(r.via) }),
                  dev: r.dev.name,
                })),
              },
            }
          : {}),
        ...(d.dnsmasq ||
        d.httpd ||
        d.postfix ||
        d.dovecot ||
        d.hostapd ||
        d.bird ||
        d.sshd ||
        d.ip?.v6.radvd
          ? {
              services: {
                ...(d.sshd ? { sshd: [] } : {}),
                ...(d.ip?.v6.radvd ? { radvd: [...d.ip.v6.radvd.args] } : {}),
                ...(d.bird ? { bird: [...d.bird.args] } : {}),
                ...(d.hostapd ? { hostapd: [...d.hostapd.args] } : {}),
                ...(d.dnsmasq ? { dnsmasq: [...d.dnsmasq.args] } : {}),
                ...(d.httpd ? { httpd: [...d.httpd.args] } : {}),
                ...(d.postfix ? { postfix: [] } : {}),
                ...(d.dovecot ? { dovecot: [] } : {}),
              },
            }
          : {}),
        ...(d.fs ? { files: d.fs.toJSON() } : {}),
        ...(d.vlanPorts.some((p) => p.parent)
          ? {
              vlanPorts: d.vlanPorts
                .filter((p) => p.parent)
                .map((p) => ({
                  name: p.name,
                  parent: p.parent?.name ?? '',
                  vid: p.vid ?? 0,
                  up: p.adminUp,
                  addrs: d.ip?.addrsOn(p).map(formatCidr) ?? [],
                })),
            }
          : {}),
        ...(d.bridge && !isDefaultBridge(d.bridge) ? { bridge: bridgeJSON(d.bridge) } : {}),
        ...(d.ip?.nf.active ? { firewall: formatRuleset(d.ip.nf.tables).join('\n') } : {}),
        ...(d.ip ? { ip6: ip6JSON(d.ip.v6) } : {}),
        ...(d.bridgePort && d.ip
          ? { bridgeAddrs: d.ip.addrsOn(d.bridgePort).map(formatCidr) }
          : {}),
        ...(d.vlanPorts.some((p) => p.tunnel) ? { wireguard: wireguardJSON(d) } : {}),
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
      if (d.bridge && device.bridge) loadBridge(device.bridge, d.bridge, d.id);
      for (const text of d.bridgeAddrs ?? []) {
        const cidr = parseCidr(text);
        const br0 = device.bridgePort;
        if (!cidr || !br0 || !device.ip) throw new Error(`Invalid address ${text} on ${d.id}`);
        device.ip.addAddress(br0, cidr);
      }
      for (const v of d.vlanPorts ?? []) {
        const parent = device.port(v.parent);
        const error = parent ? device.addVlanPort(parent, v.name, v.vid) : 'no parent';
        const port = device.port(v.name);
        if (error || !port || !device.ip) throw new Error(`Invalid VLAN interface ${v.name}`);
        port.adminUp = v.up;
        for (const text of v.addrs) {
          const cidr = parseCidr(text);
          if (!cidr) throw new Error(`Invalid address ${text} on ${d.id}`);
          device.ip.addAddress(port, cidr);
        }
      }
      for (const w of d.wireguard ?? []) loadWireguard(device, w);
      if (d.ip && device.ip) {
        device.ip.forwarding = d.ip.forwarding;
        device.ip.dns = d.ip.dns.map((text) => {
          const ip = parseIp(text);
          if (ip === null) throw new Error(`Invalid DNS server ${text} on ${d.id}`);
          return ip;
        });
        for (const r of d.ip.routes) {
          const dst = parseCidr(r.dst);
          const via = r.via === undefined ? null : parseIp(r.via);
          const dev = device.port(r.dev);
          if (!dst || via === undefined || (r.via !== undefined && via === null) || !dev) {
            throw new Error(`Invalid route ${r.dst} on ${d.id}`);
          }
          const error = device.ip.addRoute(dst, via, dev);
          if (error) throw new Error(`Route ${r.dst} on ${d.id}: ${error}`);
        }
      }
      if (d.files && device.fs) {
        // The saved files replace the spec's starting files.
        for (const path of [...device.fs.files.keys()]) device.fs.remove(path);
        for (const [path, text] of Object.entries(d.files)) {
          const error = device.fs.write(path, text);
          if (error) throw new Error(`${d.id}: ${error}`);
        }
      }
      if (d.ip6 && device.ip) loadIp6(device, d.ip6);
      if (d.firewall !== undefined) {
        if (!device.ip) throw new Error(`${d.id} cannot have a firewall`);
        const error = runNft(device.ip.nf, d.firewall, () => {});
        if (error) throw new Error(`${d.id} firewall: ${error}`);
      }
      for (const kind of ['postfix', 'dovecot'] as const) {
        if (!d.services?.[kind]) continue;
        const error = device.startMail(kind);
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.hostapd) {
        const error = device.startHostapd(d.services.hostapd);
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.bird) {
        const error = device.startBird(d.services.bird);
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.sshd) {
        const error = device.startSshd((line, io) => run(net, device, line, io));
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.radvd) {
        const error = device.startRadvd(d.services.radvd);
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.httpd) {
        const error = device.startHttpd(d.services.httpd);
        if (error) throw new Error(`${d.id}: ${error}`);
      }
      if (d.services?.dnsmasq) {
        const started = device.startDnsmasq(d.services.dnsmasq);
        if (typeof started === 'string') throw new Error(`${d.id}: ${started}`);
      }
      net.devices.set(device.id, device);
    }
    // Spanning Tree converges as if the switches had been running all along.
    const stp = [...net.devices.values()].flatMap((d) =>
      d.bridge?.stp.enabled ? [d.bridge.stp] : [],
    );
    stp.forEach((s) => (s.instant = true));
    for (const l of snapshot.links) {
      const pa = net.devices.get(l.a.device)?.port(l.a.port);
      const pb = net.devices.get(l.b.device)?.port(l.b.port);
      const wireless = pa?.type === 'wifi' && pb?.type === 'wifi';
      if (!pa || !pb || cableError(pa, pb, wireless)) throw new Error(`Invalid link ${l.id}`);
      net.#attach(l.id, pa, pb);
    }
    if (stp.length > 0) {
      for (let i = 0; i < 1000 && net.scheduler.pending > 0; i++) {
        net.scheduler.runUntil(net.scheduler.now + 1);
      }
      stp.forEach((s) => (s.instant = false));
      net.trace = [];
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
   * Whether the switches around `device` form a loop (more cables than a tree needs).
   * Turning STP off there would make frames circle forever.
   */
  hasL2Loop(device: Device): boolean {
    const start = device.ports[0];
    if (!start) return false;
    const domain = this.#l2Domain(start);
    const nodes = new Set(
      [...domain].map((p) => (p.device.bridge?.owns(p) ? p.device.id : `${p.device.id}/${p.name}`)),
    );
    const links = new Set([...domain].flatMap((p) => (p.link ? [p.link] : [])));
    return links.size >= nodes.size;
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
