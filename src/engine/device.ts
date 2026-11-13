import type { Mac } from './addr.ts';
import { Bridge } from './bridge.ts';
import { Dnsmasq } from './dnsmasq.ts';
import { FileSystem } from './fs.ts';
import { Httpd } from './http.ts';
import { startPop3, startSmtp } from './mail.ts';
import { startHostapd, type HostapdConfig } from './wifi.ts';
import { IpStack } from './ip.ts';
import { untagged, type EthernetFrame } from './packet.ts';
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
  /** VLAN interfaces added with `ip link add link eth0 name eth0.10 type vlan id 10`. */
  readonly vlanPorts: Port[] = [];
  readonly bridge: Bridge | null;
  readonly ip: IpStack | null;
  /** Files, on devices with an IP stack (hosts, servers, routers). */
  readonly fs: FileSystem | null;
  /** The running dnsmasq (DHCP and DNS server), if started. */
  dnsmasq: Dnsmasq | null = null;
  /** The running web server, if started. */
  httpd: Httpd | null = null;
  /** Stop functions of the running mail servers (postfix: SMTP, dovecot: POP3). */
  postfix: (() => void) | null = null;
  dovecot: (() => void) | null = null;
  /** The running access point (hostapd) and the arguments it was started with. */
  hostapd: (HostapdConfig & { args: string[] }) | null = null;

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
    this.fs = spec.ip ? new FileSystem(spec.files ?? {}, () => fabric.changed()) : null;
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

  /** Starts busybox-style httpd. Returns an error message, or null. */
  startHttpd(args: readonly string[]): string | null {
    if (!this.ip || !this.fs) return 'httpd: command not found';
    if (this.httpd) return 'httpd: bind: Address already in use';
    const server = Httpd.start(this.ip, this.fs, args);
    if (typeof server === 'string') return server;
    this.httpd = server;
    this.fabric.changed();
    return null;
  }

  stopHttpd(): boolean {
    if (!this.httpd) return false;
    this.httpd.stop();
    this.httpd = null;
    this.fabric.changed();
    return true;
  }

  /** Starts a mail server. Returns an error message, or null. */
  startMail(kind: 'postfix' | 'dovecot'): string | null {
    if (!this.ip || !this.fs) return `${kind}: command not found`;
    if (this[kind])
      return kind === 'postfix'
        ? 'postfix: fatal: the Postfix mail system is already running'
        : 'dovecot: Fatal: Dovecot is already running';
    const stop =
      kind === 'postfix' ? startSmtp(this, this.ip, this.fs) : startPop3(this.ip, this.fs);
    if (typeof stop === 'string') return stop;
    this[kind] = stop;
    this.fabric.changed();
    return null;
  }

  stopMail(kind: 'postfix' | 'dovecot'): boolean {
    const stop = this[kind];
    if (!stop) return false;
    stop();
    this[kind] = null;
    this.fabric.changed();
    return true;
  }

  /** Starts hostapd from its config file. Returns an error message, or null. */
  startHostapd(args: readonly string[]): string | null {
    if (this.hostapd) return 'hostapd: already running';
    const config = startHostapd(this, args);
    if (typeof config === 'string') return config;
    this.hostapd = { ...config, args: [...args] };
    this.fabric.changed();
    return null;
  }

  /** Stops hostapd; associated clients lose their link (the network drops them). */
  stopHostapd(): boolean {
    if (!this.hostapd) return false;
    this.hostapd = null;
    this.fabric.changed();
    return true;
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
    return this.interfaces().find((p) => p.name === name);
  }

  /** Physical ports, then VLAN interfaces, in `ip link` order. */
  interfaces(): Port[] {
    return [...this.ports, ...this.vlanPorts];
  }

  /** Adds a VLAN interface on a routed port. It starts down, like on Linux. */
  addVlanPort(parent: Port, name: string, vid: number): string | null {
    if (!this.ip?.ports.includes(parent) || parent.parent) {
      return 'RTNETLINK answers: Operation not supported';
    }
    if (!/^[A-Za-z][\w.-]{0,14}$/.test(name)) {
      return `Error: argument "${name}" is wrong: "name" not a valid ifname`;
    }
    if (this.port(name)) return 'RTNETLINK answers: File exists';
    if (this.vlanPorts.some((p) => p.parent === parent && p.vid === vid)) {
      return 'RTNETLINK answers: File exists';
    }
    const port: Port = {
      name,
      type: parent.type,
      mac: parent.mac,
      device: this,
      link: null,
      adminUp: false,
      parent,
      vid,
    };
    this.vlanPorts.push(port);
    this.ip.addPort(port);
    this.fabric.changed();
    return null;
  }

  /** Deletes a VLAN interface with its addresses and routes. */
  removeVlanPort(port: Port): void {
    const i = this.vlanPorts.indexOf(port);
    if (i < 0) return;
    this.vlanPorts.splice(i, 1);
    this.ip?.removePort(port);
    this.fabric.changed();
  }

  receive(port: Port, frame: EthernetFrame): void {
    if (this.bridge?.owns(port)) {
      this.bridge.receive(port, frame);
      return;
    }
    if (frame.vlan === undefined) {
      this.ip?.receive(port, frame);
      return;
    }
    // A tagged frame goes to the VLAN interface for its tag; Linux drops it if there is none.
    const sub = this.vlanPorts.find((p) => p.parent === port && p.vid === frame.vlan);
    if (!sub?.adminUp) return;
    this.ip?.receive(sub, untagged(frame));
  }

  /** Called when a port gains or loses carrier. */
  carrierChanged(port: Port): void {
    this.bridge?.carrierChanged(port);
    this.ip?.carrierChanged(port);
    for (const sub of this.vlanPorts) if (sub.parent === port) this.ip?.carrierChanged(sub);
  }
}
