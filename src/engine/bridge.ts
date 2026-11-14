import { BROADCAST_MAC, type Mac } from './addr.ts';
import type { Fabric } from './device.ts';
import type { DropWhy } from './drops.ts';
import { untagged, type EthernetFrame } from './packet.ts';
import { hasCarrier, type Port } from './port.ts';
import { Stp } from './stp.ts';

/** Same default as the Linux bridge `ageing_time` (300 s). */
export const FDB_AGEING_MS = 300_000;
/** Linux gives every bridge port VLAN 1 as PVID, egress untagged (`default_pvid`). */
export const DEFAULT_VID = 1;

export interface FdbEntry {
  mac: Mac;
  port: Port;
  /** VLAN the address was learned in; 0 when VLAN filtering is off. */
  vlan: number;
  updated: number;
}

/** A port's VLAN membership, as `bridge vlan show` lists it. */
export interface PortVlans {
  vids: Set<number>;
  /** VLAN for untagged frames arriving on the port; null drops them. */
  pvid: number | null;
  /** VLANs sent without a tag on this port. */
  untagged: Set<number>;
}

export function defaultVlans(): PortVlans {
  return { vids: new Set([DEFAULT_VID]), pvid: DEFAULT_VID, untagged: new Set([DEFAULT_VID]) };
}

/** A learning bridge (L2 switching) over a set of ports, like a Linux `br0`. */
export class Bridge {
  readonly #fdb = new Map<string, FdbEntry>();
  /** `ip link set br0 type bridge vlan_filtering 1`: without it, VLAN settings are ignored. */
  vlanFiltering = false;
  readonly vlans = new Map<Port, PortVlans>();
  /** Spanning Tree (`stp_state`), off by default like on Linux. */
  readonly stp: Stp;
  /** The bridge's own interface (`br0` with an address), when the device routes too. */
  local: { port: Port; receive(frame: EthernetFrame): void } | null = null;

  constructor(
    readonly fabric: Fabric,
    readonly ports: readonly Port[],
  ) {
    for (const port of ports) this.vlans.set(port, defaultVlans());
    this.stp = new Stp(fabric, ports, () => this.#fdb.clear());
  }

  owns(port: Port): boolean {
    return this.ports.includes(port);
  }

  /** Current forwarding database, without expired entries. */
  fdb(): FdbEntry[] {
    this.#expire();
    return [...this.#fdb.values()];
  }

  setVlanFiltering(on: boolean): void {
    this.vlanFiltering = on;
    this.#fdb.clear();
    this.fabric.changed();
  }

  /** `bridge vlan add dev PORT vid VID [pvid] [untagged]`. */
  addVlan(port: Port, vid: number, flags: { pvid: boolean; untagged: boolean }): void {
    const v = this.vlans.get(port) ?? defaultVlans();
    v.vids.add(vid);
    if (flags.pvid) v.pvid = vid;
    else if (v.pvid === vid) v.pvid = null;
    if (flags.untagged) v.untagged.add(vid);
    else v.untagged.delete(vid);
    this.vlans.set(port, v);
    this.fabric.changed();
  }

  /** `bridge vlan del dev PORT vid VID`. Returns false if the port was not in that VLAN. */
  delVlan(port: Port, vid: number): boolean {
    const v = this.vlans.get(port);
    if (!v?.vids.delete(vid)) return false;
    v.untagged.delete(vid);
    if (v.pvid === vid) v.pvid = null;
    for (const [key, e] of this.#fdb) if (e.port === port && e.vlan === vid) this.#fdb.delete(key);
    this.fabric.changed();
    return true;
  }

  receive(port: Port, frame: EthernetFrame): void {
    if (frame.payload.kind === 'bpdu' && this.stp.enabled) {
      this.stp.receive(port, frame.payload);
      return;
    }
    if (!this.stp.learns(port)) {
      this.#dropStp(port, frame);
      return;
    }
    const vid = this.#ingress(port, frame);
    if (vid === null) {
      const v = this.vlans.get(port);
      const vids = [...(v?.vids ?? [])].sort((a, b) => a - b);
      this.#drop(port, frame, {
        reason: 'vlan-ingress',
        vid: frame.vlan ?? null,
        pvid: v?.pvid ?? null,
        vids,
      });
      return;
    }
    const now = this.fabric.scheduler.now;
    if (frame.src !== BROADCAST_MAC) {
      const key = `${vid}/${frame.src}`;
      if (this.#fdb.get(key)?.port !== port) this.fabric.changed();
      this.#fdb.set(key, { mac: frame.src, port, vlan: vid, updated: now });
    }
    this.#expire();
    // Listening and learning ports learn addresses (learning only) but forward nothing.
    if (!this.stp.forwards(port)) {
      this.#dropStp(port, frame);
      return;
    }
    const local = this.local;
    let heard = false;
    if (local) {
      const group = frame.dst === BROADCAST_MAC || /^(01:|33:33:)/.test(frame.dst);
      // shortcut: the bridge's own port is a member of every VLAN (no `bridge vlan add dev br0
      // self`); frames of VLANs above 1 reach the matching `br0.N` interface, or nothing.
      const tagged = vid > DEFAULT_VID ? { ...frame, vlan: vid } : untagged(frame);
      if (frame.dst === local.port.mac || group) local.receive(tagged);
      if (frame.dst === local.port.mac) return;
      heard = group;
    }
    const entry = frame.dst === BROADCAST_MAC ? undefined : this.#fdb.get(`${vid}/${frame.dst}`);
    if (entry) {
      if (entry.port === port) return;
      if (!this.stp.forwards(entry.port)) this.#dropStp(entry.port, frame);
      else if (!this.#egress(entry.port, frame, vid))
        this.#dropVlan(port, frame, vid, [entry.port]);
      return;
    }
    // Flooding: ports outside the VLAN are normal isolation, a drop only when nothing got it.
    let sent = 0;
    const refused: Port[] = [];
    for (const out of this.ports) {
      if (out === port || !hasCarrier(out) || !this.stp.forwards(out)) continue;
      if (this.#egress(out, frame, vid)) sent++;
      else refused.push(out);
    }
    if (sent === 0 && !heard && refused.length > 0) this.#dropVlan(port, frame, vid, refused);
  }

  /** Records a discarded frame worth explaining: ARP and unicast IP, not control traffic. */
  #drop(port: Port, frame: EthernetFrame, why: DropWhy): void {
    const p = frame.payload;
    const worth =
      p.kind === 'arp' ||
      (p.kind === 'ipv4' && p.payload.kind !== 'ospf') ||
      (p.kind === 'ipv6' && !frame.dst.startsWith('33:33:'));
    if (worth) this.fabric.drop(port.device, port, why, p);
  }

  #dropVlan(port: Port, frame: EthernetFrame, vid: number, refused: Port[]): void {
    const others = refused.map((p) => ({
      port: p.name,
      vids: [...(this.vlans.get(p)?.vids ?? [])].sort((a, b) => a - b),
    }));
    this.#drop(port, frame, { reason: 'vlan-egress', vid, others });
  }

  /** A port that is not forwarding is only a problem while Spanning Tree converges. */
  #dropStp(port: Port, frame: EthernetFrame): void {
    const s = this.stp.ports.get(port);
    if (s && s.role !== 'alternate') {
      this.#drop(port, frame, { reason: 'stp-not-forwarding', state: s.state, role: s.role });
    }
  }

  carrierChanged(port: Port): void {
    for (const [key, entry] of this.#fdb) if (entry.port === port) this.#fdb.delete(key);
    this.stp.carrierChanged(port);
  }

  /** Sends a frame from the bridge's own interface out of the right port, or floods it. */
  sendLocal(frame: EthernetFrame): void {
    // A `br0.N` interface sends its frames tagged with N.
    const vid = frame.vlan ?? (this.vlanFiltering ? DEFAULT_VID : 0);
    const entry = this.#fdb.get(`${vid}/${frame.dst}`);
    if (entry && this.stp.forwards(entry.port)) {
      this.#egress(entry.port, frame, vid);
      return;
    }
    for (const out of this.ports) {
      if (hasCarrier(out) && this.stp.forwards(out)) this.#egress(out, frame, vid);
    }
  }

  /** The VLAN a frame belongs to, or null if the port must drop it. */
  #ingress(port: Port, frame: EthernetFrame): number | null {
    if (!this.vlanFiltering) return 0;
    const v = this.vlans.get(port);
    const vid = frame.vlan ?? v?.pvid ?? null;
    return vid !== null && v?.vids.has(vid) ? vid : null;
  }

  /** Sends a frame out of a port; false when the port is not in the frame's VLAN. */
  #egress(out: Port, frame: EthernetFrame, vid: number): boolean {
    if (!this.vlanFiltering) {
      this.fabric.transmit(out, frame);
      return true;
    }
    const v = this.vlans.get(out);
    if (!v?.vids.has(vid)) return false;
    this.fabric.transmit(out, v.untagged.has(vid) ? untagged(frame) : { ...frame, vlan: vid });
    return true;
  }

  #expire(): void {
    const now = this.fabric.scheduler.now;
    for (const [key, entry] of this.#fdb) {
      if (now - entry.updated > FDB_AGEING_MS) this.#fdb.delete(key);
    }
  }
}
