import type { Mac } from './addr.ts';
import { Bridge } from './bridge.ts';
import { Dnsmasq } from './dnsmasq.ts';
import { IpStack } from './ip.ts';
import type { EthernetFrame } from './packet.ts';
import type { Port } from './port.ts';
import type { Scheduler } from './scheduler.ts';
import type { DeviceSpec } from './specs.ts';

/** What a device needs from the network it lives in. */
export interface Fabric {
  readonly scheduler: Scheduler;
  transmit(from: Port, frame: EthernetFrame): void;
  changed(): void;
}

/** A device built from a spec: ports plus the stack modules the spec asks for. */
export class Device {
  readonly ports: readonly Port[];
  readonly bridge: Bridge | null;
  readonly ip: IpStack | null;
  /** The running dnsmasq (DHCP and DNS server), if started. */
  dnsmasq: Dnsmasq | null = null;

  constructor(
    readonly fabric: Fabric,
    readonly id: string,
    public name: string,
    readonly spec: DeviceSpec,
    macs: readonly Mac[],
  ) {
    if (macs.length !== spec.ports.length) {
      throw new Error(`${spec.label} needs ${spec.ports.length} MAC addresses, got ${macs.length}`);
    }
    this.ports = spec.ports.map((p, i) => ({
      name: p.name,
      type: p.type,
      mac: macs[i] ?? '',
      device: this,
      link: null,
      adminUp: true,
    }));
    this.bridge = spec.bridge ? new Bridge(fabric, this.ports) : null;
    const routed = this.ports.filter((p) => !this.bridge?.owns(p));
    this.ip = spec.ip ? new IpStack(fabric, routed, spec.forwarding) : null;
  }

  /** Starts dnsmasq with command-line arguments. Returns its log lines or an error message. */
  startDnsmasq(args: readonly string[]): string[] | string {
    if (!this.ip) return 'dnsmasq: command not found';
    if (this.dnsmasq) {
      return 'dnsmasq: failed to create listening socket for port 53: Address already in use';
    }
    const server = Dnsmasq.start(this.fabric, this.ip, args);
    if (typeof server === 'string') return server;
    this.dnsmasq = server;
    return server.banner();
  }

  /** Stops dnsmasq. Returns false if it wasn't running. */
  stopDnsmasq(): boolean {
    if (!this.dnsmasq) return false;
    this.dnsmasq.stop();
    this.dnsmasq = null;
    this.fabric.changed();
    return true;
  }

  port(name: string): Port | undefined {
    return this.ports.find((p) => p.name === name);
  }

  receive(port: Port, frame: EthernetFrame): void {
    if (this.bridge?.owns(port)) this.bridge.receive(port, frame);
    else this.ip?.receive(port, frame);
  }

  /** Called when a port gains or loses carrier. */
  carrierChanged(port: Port): void {
    this.bridge?.carrierChanged(port);
    this.ip?.carrierChanged(port);
  }
}
