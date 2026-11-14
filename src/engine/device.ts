import type { Mac } from './addr.ts';
import { BIRD_CONF, Bird, parseBirdConf } from './bird.ts';
import { RADVD_CONF, parseRadvd } from './ip6.ts';
import { Bridge } from './bridge.ts';
import { dhclient } from './dhcp.ts';
import { WireGuard } from './wireguard.ts';
import type { Process, ShellIO } from './shell.ts';
import { startSshd } from './ssh.ts';
import { Dnsmasq } from './dnsmasq.ts';
import { DhcpRelay } from './dhcrelay.ts';
import { FileSystem } from './fs.ts';
import { Httpd } from './http.ts';
import { startPop3, startSmtp } from './mail.ts';
import { startHostapd, type HostapdConfig } from './wifi.ts';
import { IpStack } from './ip.ts';
import type { DropWhy } from './drops.ts';
import {
  untagged,
  type ArpPacket,
  type EthernetFrame,
  type Ipv4Packet,
  type Ipv6Packet,
} from './packet.ts';
import { hasCarrier, type Port } from './port.ts';
import type { Scheduler } from './scheduler.ts';
import type { DeviceSpec } from './specs.ts';

/** What a device needs from the network it lives in. */
export interface Fabric {
  readonly scheduler: Scheduler;
  transmit(from: Port, frame: EthernetFrame): void;
  changed(): void;
  /** Records that a frame or packet was discarded, and why (see drops.ts). */
  drop(
    device: Device,
    port: Port | null,
    why: DropWhy,
    packet: Ipv4Packet | Ipv6Packet | ArpPacket | null,
  ): void;
}

/** A device built from a spec: ports plus the stack modules the spec asks for. */
export class Device {
  readonly ports: readonly Port[];
  /** VLAN interfaces added with `ip link add link eth0 name eth0.10 type vlan id 10`. */
  readonly vlanPorts: Port[] = [];
  /** The bridge's own IP interface (`br0`), on devices that route and bridge. */
  bridgePort: Port | null = null;
  #bridgeCarrier = false;
  readonly bridge: Bridge | null;
  readonly ip: IpStack | null;
  /** Files, on devices with an IP stack (hosts, servers, routers). */
  readonly fs: FileSystem | null;
  /** The running dnsmasq (DHCP and DNS server), if started. */
  dnsmasq: Dnsmasq | null = null;
  /** The running DHCP relay agent (dhcrelay), if started. */
  dhcrelay: DhcpRelay | null = null;
  /** The running web server, if started. */
  httpd: Httpd | null = null;
  /** Stop functions of the running mail servers (postfix: SMTP, dovecot: POP3). */
  postfix: (() => void) | null = null;
  dovecot: (() => void) | null = null;
  /** Stops the running SSH server, if started. */
  sshd: (() => void) | null = null;
  /** The running BIRD routing daemon (OSPF), if started. */
  bird: Bird | null = null;
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
    const bridged = this.ports.filter((p) => spec.bridgePorts?.includes(p.name) ?? true);
    this.bridge = spec.bridge ? new Bridge(fabric, bridged) : null;
    const routed = this.ports.filter((p) => !this.bridge?.owns(p));
    this.ip = spec.ip ? new IpStack(fabric, routed, spec.forwarding) : null;
    if (spec.bridgeIp && this.bridge && this.ip) {
      // Linux gives br0 the MAC address of its first port.
      const br0: Port = {
        name: 'br0',
        type: 'ethernet',
        mac: bridged[0]?.mac ?? '',
        device: this,
        link: null,
        adminUp: true,
        bridgeSelf: this.bridge,
      };
      this.bridgePort = br0;
      this.bridge.local = { port: br0, receive: (frame) => this.ip?.receive(br0, frame) };
      this.ip.addPort(br0);
    }
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

  /** Starts dhcrelay (routers only). Returns its log lines, or its error lines. */
  startDhcrelay(args: readonly string[]): { ok: boolean; lines: string[] } {
    if (!this.ip?.forwarding) return { ok: false, lines: ['dhcrelay: command not found'] };
    const started = DhcpRelay.start(this.fabric, this.ip, args, (name) => this.port(name));
    if (Array.isArray(started)) return { ok: false, lines: started };
    this.dhcrelay = started.relay;
    return { ok: true, lines: started.lines };
  }

  stopDhcrelay(): boolean {
    if (!this.dhcrelay) return false;
    this.dhcrelay.stop();
    this.dhcrelay = null;
    this.fabric.changed();
    return true;
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

  /** Starts BIRD from its config file (`bird [-c FILE]`). Returns an error, or null. */
  startBird(args: readonly string[]): string | null {
    if (!this.ip || !this.fs) return 'bird: command not found';
    if (this.bird) return 'bird: I found another BIRD running.';
    const i = args.indexOf('-c');
    const path = i >= 0 ? args[i + 1] : BIRD_CONF;
    const text = path === undefined ? undefined : this.fs.read(path);
    if (text === undefined) {
      return `bird: Unable to open configuration file ${path ?? ''}: No such file or directory`;
    }
    const config = parseBirdConf(text);
    if (typeof config === 'string') return `bird: ${config}`;
    this.bird = Bird.start(this.fabric, this.ip, config, [...args]);
    this.ip.routing = this.bird;
    this.fabric.changed();
    return null;
  }

  /** Starts sshd; `runLine` runs a command line in this device's shell for a session. */
  startSshd(runLine: (line: string, io: ShellIO) => Process | undefined): string | null {
    if (!this.ip || !this.fs) return 'sshd: command not found';
    if (this.sshd) return 'sshd: error: Bind to port 22 failed: Address already in use.';
    const stop = startSshd(this, this.ip, this.fs, runLine);
    if (typeof stop === 'string') return stop;
    this.sshd = stop;
    this.fabric.changed();
    return null;
  }

  stopSshd(): boolean {
    if (!this.sshd) return false;
    this.sshd();
    this.sshd = null;
    this.fabric.changed();
    return true;
  }

  /** Starts radvd (`radvd [-C FILE]`): router advertisements for SLAAC. */
  startRadvd(args: readonly string[]): string | null {
    if (!this.ip || !this.fs) return 'radvd: command not found';
    const v6 = this.ip.v6;
    if (v6.radvd) return 'radvd: another radvd is already running';
    const i = args.indexOf('-C');
    const path = i >= 0 ? args[i + 1] : RADVD_CONF;
    const text = path === undefined ? undefined : this.fs.read(path);
    if (text === undefined) return `radvd: can't open ${path ?? ''}: No such file or directory`;
    const config = parseRadvd(text);
    if (typeof config === 'string') return config;
    const missing = config.interfaces.find((c) => !this.ip?.ports.some((p) => p.name === c.name));
    if (missing) return `radvd: interface ${missing.name} does not exist`;
    if (!v6.forwarding) return 'radvd: IPv6 forwarding setting is: 0, should be 1 or 2';
    v6.radvd = { ...config, args: [...args] };
    for (const port of this.ip.ports) v6.advertise(port);
    this.fabric.changed();
    return null;
  }

  /** Stops radvd; like the real one, it first announces that it is no longer a router. */
  stopRadvd(): boolean {
    const v6 = this.ip?.v6;
    if (!v6?.radvd) return false;
    for (const port of this.ip?.ports ?? []) v6.advertise(port, 0);
    v6.radvd = null;
    this.fabric.changed();
    return true;
  }

  stopBird(): boolean {
    if (!this.bird || !this.ip) return false;
    this.bird.stop();
    this.bird = null;
    this.ip.routing = null;
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

  /** Physical ports, the bridge interface, then VLAN and tunnel interfaces (`ip link` order). */
  interfaces(): Port[] {
    return [...this.ports, ...(this.bridgePort ? [this.bridgePort] : []), ...this.vlanPorts];
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

  /** Adds a WireGuard interface (`ip link add wg0 type wireguard`). It starts down. */
  addWireguard(name: string): string | null {
    if (!this.ip) return 'RTNETLINK answers: Operation not supported';
    if (!/^[A-Za-z][\w.-]{0,14}$/.test(name)) {
      return `Error: argument "${name}" is wrong: "name" not a valid ifname`;
    }
    if (this.port(name)) return 'RTNETLINK answers: File exists';
    const wg = new WireGuard(this.fabric, this.ip);
    const port: Port = {
      name,
      type: 'ethernet',
      mac: '00:00:00:00:00:00',
      device: this,
      link: null,
      adminUp: false,
      tunnel: wg,
    };
    wg.port = port;
    this.vlanPorts.push(port);
    this.ip.addPort(port);
    this.fabric.changed();
    return null;
  }

  /** The WireGuard tunnel behind an interface, if it is one. */
  wireguard(port: Port | undefined): WireGuard | null {
    return port?.tunnel instanceof WireGuard ? port.tunnel : null;
  }

  /** Deletes a VLAN or WireGuard interface with its addresses and routes. */
  removeVlanPort(port: Port): void {
    const i = this.vlanPorts.indexOf(port);
    if (i < 0) return;
    this.wireguard(port)?.stop();
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
    if (!this.bridge?.owns(port)) this.ip?.carrierChanged(port);
    for (const sub of this.vlanPorts) if (sub.parent === port) this.ip?.carrierChanged(sub);
    const br0 = this.bridgePort;
    if (br0 && hasCarrier(br0) !== this.#bridgeCarrier) {
      this.#bridgeCarrier = hasCarrier(br0);
      this.ip?.carrierChanged(br0);
    }
    // A WAN port asks for an address when plugged in, unless it already has one.
    const ip = this.ip;
    if (port.name === this.spec.wanDhcp && hasCarrier(port) && ip?.addrsOn(port).length === 0) {
      dhclient(this, port, { out: () => {}, exit: () => {} });
    }
  }
}
