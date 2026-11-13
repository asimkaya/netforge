import { BROADCAST_MAC, type Mac } from './addr.ts';
import { Device, hasCarrier, type Fabric, type Port } from './device.ts';
import type { EthernetFrame } from './packet.ts';

export const SWITCH_PORT_COUNT = 8;
/** Same default as the Linux bridge `ageing_time` (300 s). */
export const FDB_AGEING_MS = 300_000;

export interface FdbEntry {
  mac: Mac;
  port: Port;
  updated: number;
}

/** Unmanaged learning switch (a Linux bridge with all ports enslaved). */
export class Switch extends Device {
  readonly kind = 'switch';
  readonly #fdb = new Map<Mac, FdbEntry>();

  constructor(fabric: Fabric, id: string, name: string, macs: Mac[]) {
    super(fabric, id, name);
    macs.forEach((mac, i) => this.addPort(`eth${i}`, mac));
  }

  /** Current forwarding database, without expired entries. */
  fdb(): FdbEntry[] {
    this.#expire();
    return [...this.#fdb.values()];
  }

  receive(port: Port, frame: EthernetFrame): void {
    const now = this.fabric.scheduler.now;
    if (frame.src !== BROADCAST_MAC) {
      const known = this.#fdb.get(frame.src);
      if (known?.port !== port) this.fabric.changed();
      this.#fdb.set(frame.src, { mac: frame.src, port, updated: now });
    }
    this.#expire();
    const entry = frame.dst === BROADCAST_MAC ? undefined : this.#fdb.get(frame.dst);
    if (entry) {
      if (entry.port !== port) this.fabric.transmit(entry.port, frame);
      return;
    }
    for (const out of this.ports) {
      if (out !== port && hasCarrier(out)) this.fabric.transmit(out, frame);
    }
  }

  override carrierChanged(port: Port): void {
    for (const [mac, entry] of this.#fdb) if (entry.port === port) this.#fdb.delete(mac);
  }

  #expire(): void {
    const now = this.fabric.scheduler.now;
    for (const [mac, entry] of this.#fdb) {
      if (now - entry.updated > FDB_AGEING_MS) this.#fdb.delete(mac);
    }
  }
}
