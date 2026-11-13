import type { Mac } from './addr.ts';
import type { EthernetFrame } from './packet.ts';
import type { Scheduler } from './scheduler.ts';

export interface Port {
  readonly name: string;
  readonly mac: Mac;
  readonly device: Device;
  link: Link | null;
  /** Administrative state (`ip link set <port> up|down`). */
  adminUp: boolean;
}

export interface Link {
  readonly id: string;
  readonly a: Port;
  readonly b: Port;
}

export function peerOf(port: Port): Port | null {
  const link = port.link;
  if (!link) return null;
  return link.a === port ? link.b : link.a;
}

/** Carrier is up when both ends are cabled and administratively up. */
export function hasCarrier(port: Port): boolean {
  const peer = peerOf(port);
  return port.adminUp && peer !== null && peer.adminUp;
}

/** What a device needs from the network it lives in. */
export interface Fabric {
  readonly scheduler: Scheduler;
  transmit(from: Port, frame: EthernetFrame): void;
  changed(): void;
}

export type DeviceKind = 'host' | 'switch';

export abstract class Device {
  abstract readonly kind: DeviceKind;
  readonly ports: Port[] = [];

  constructor(
    readonly fabric: Fabric,
    readonly id: string,
    public name: string,
  ) {}

  port(name: string): Port | undefined {
    return this.ports.find((p) => p.name === name);
  }

  protected addPort(name: string, mac: Mac): Port {
    const port: Port = { name, mac, device: this, link: null, adminUp: true };
    this.ports.push(port);
    return port;
  }

  abstract receive(port: Port, frame: EthernetFrame): void;

  /** Called when a port gains or loses carrier. */
  carrierChanged(port: Port): void {
    void port;
  }
}
