import { BROADCAST_MAC, type Mac } from './addr.ts';
import type { Fabric } from './device.ts';
import { untagged, type EthernetFrame } from './packet.ts';
import { hasCarrier, type Port } from './port.ts';

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

  constructor(
    readonly fabric: Fabric,
    readonly ports: readonly Port[],
  ) {
    for (const port of ports) this.vlans.set(port, defaultVlans());
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
    const vid = this.#ingress(port, frame);
    if (vid === null) return;
    const now = this.fabric.scheduler.now;
    if (frame.src !== BROADCAST_MAC) {
      const key = `${vid}/${frame.src}`;
      if (this.#fdb.get(key)?.port !== port) this.fabric.changed();
      this.#fdb.set(key, { mac: frame.src, port, vlan: vid, updated: now });
    }
    this.#expire();
    const entry = frame.dst === BROADCAST_MAC ? undefined : this.#fdb.get(`${vid}/${frame.dst}`);
    if (entry) {
      if (entry.port !== port) this.#egress(entry.port, frame, vid);
      return;
    }
    for (const out of this.ports) {
      if (out !== port && hasCarrier(out)) this.#egress(out, frame, vid);
    }
  }

  carrierChanged(port: Port): void {
    for (const [key, entry] of this.#fdb) if (entry.port === port) this.#fdb.delete(key);
  }

  /** The VLAN a frame belongs to, or null if the port must drop it. */
  #ingress(port: Port, frame: EthernetFrame): number | null {
    if (!this.vlanFiltering) return 0;
    const v = this.vlans.get(port);
    const vid = frame.vlan ?? v?.pvid ?? null;
    return vid !== null && v?.vids.has(vid) ? vid : null;
  }

  #egress(out: Port, frame: EthernetFrame, vid: number): void {
    if (!this.vlanFiltering) {
      this.fabric.transmit(out, frame);
      return;
    }
    const v = this.vlans.get(out);
    if (!v?.vids.has(vid)) return;
    this.fabric.transmit(out, v.untagged.has(vid) ? untagged(frame) : { ...frame, vlan: vid });
  }

  #expire(): void {
    const now = this.fabric.scheduler.now;
    for (const [key, entry] of this.#fdb) {
      if (now - entry.updated > FDB_AGEING_MS) this.#fdb.delete(key);
    }
  }
}
