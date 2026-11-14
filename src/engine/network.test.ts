import { describe, expect, it } from 'vitest';
import { formatIp, parseCidr, parseIp, type Ip } from './addr.ts';
import type { Device } from './device.ts';
import type { IcmpEvent, IpStack } from './ip.ts';
import { Network } from './network.ts';
import { routed, sh } from './testing.ts';

function ip(text: string): Ip {
  const value = parseIp(text);
  if (value === null) throw new Error(`bad ip ${text}`);
  return value;
}

function ipOf(device: Device): IpStack {
  if (!device.ip) throw new Error(`${device.name} has no IP stack`);
  return device.ip;
}

function fdbOf(device: Device) {
  if (!device.bridge) throw new Error(`${device.name} is not a bridge`);
  return device.bridge.fdb();
}

function addr(host: Device, cidr: string): void {
  const parsed = parseCidr(cidr);
  const port = host.port('eth0');
  if (!parsed || !port) throw new Error('bad setup');
  expect(ipOf(host).addAddress(port, parsed)).toBeNull();
}

/** Sends one echo request and runs the simulation for `ms`. */
function ping(net: Network, from: Device, to: string, ms = 5000): IcmpEvent[] {
  const events: IcmpEvent[] = [];
  const stack = ipOf(from);
  const id = stack.openIcmp((e) => events.push(e));
  const error = stack.sendIcmp(ip(to), { kind: 'icmp', type: 'echo-request', id, seq: 1 });
  if (error) throw new Error(error);
  net.scheduler.runUntil(net.scheduler.now + ms);
  stack.closeIcmp(id);
  return events;
}

function twoHosts() {
  const net = new Network();
  const pc1 = net.addDevice('pc');
  const pc2 = net.addDevice('pc');
  addr(pc1, '10.0.0.1/24');
  addr(pc2, '10.0.0.2/24');
  return { net, pc1, pc2 };
}

describe('Network', () => {
  it('names devices and gives each port a unique MAC', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    const sw = net.addDevice('switch');
    expect(pc.name).toBe('pc1');
    expect(sw.name).toBe('sw1');
    expect(sw.ports).toHaveLength(10);
    const macs = [...pc.ports, ...sw.ports].map((p) => p.mac);
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('pings across a direct cable, resolving ARP first', () => {
    const { net, pc1, pc2 } = twoHosts();
    net.connect(pc1, pc2);
    const events = ping(net, pc1, '10.0.0.2');
    expect(events).toEqual([{ kind: 'reply', from: ip('10.0.0.2'), seq: 1, ttl: 64 }]);
    // IPv6 router solicitations from the link coming up are left out.
    const v4 = net.trace.filter((t) => t.frame.payload.kind !== 'ipv6');
    expect(v4.map((t) => t.frame.payload.kind)).toEqual(['arp', 'arp', 'ipv4', 'ipv4']);
    expect(ipOf(pc1).neighbors.get(ip('10.0.0.2'))?.state).toBe('REACHABLE');
    expect(ipOf(pc2).neighbors.get(ip('10.0.0.1'))?.mac).toBe(pc1.ports[0]?.mac);
    expect(ipOf(pc1).echoRepliesFrom.has(ip('10.0.0.2'))).toBe(true);
    // The ARP retry timer was cancelled once the reply arrived.
    expect(net.scheduler.pending).toBe(0);
  });

  it('pings through a switch, which learns MAC addresses', () => {
    const net = new Network();
    const sw = net.addDevice('switch');
    const [pc1, pc2, pc3] = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
    if (!pc1 || !pc2 || !pc3) throw new Error('setup');
    [pc1, pc2, pc3].forEach((pc, i) => {
      addr(pc, `192.168.1.${i + 1}/24`);
      net.connect(pc, sw);
    });
    expect(ping(net, pc1, '192.168.1.3')).toHaveLength(1);
    const learned = fdbOf(sw).map((e) => [e.mac, e.port.name]);
    // pc2 never pinged, but its IPv6 router solicitation (sent when its cable went in)
    // taught the switch where it is.
    expect(learned).toEqual([
      [pc1.ports[0]?.mac, 'eth0'],
      [pc2.ports[0]?.mac, 'eth1'],
      [pc3.ports[0]?.mac, 'eth2'],
    ]);
    // The ARP request was flooded to pc2, but the unicast echo was not.
    const toPc2 = net.trace.filter(
      (t) => t.to.device === pc2.id && t.frame.payload.kind !== 'ipv6',
    );
    expect(toPc2.map((t) => t.frame.payload.kind)).toEqual(['arp']);
  });

  it('ages out switch entries after 300 s', () => {
    const { net, pc1, pc2 } = twoHosts();
    const sw = net.addDevice('switch');
    net.connect(pc1, sw);
    net.connect(pc2, sw);
    ping(net, pc1, '10.0.0.2');
    expect(fdbOf(sw)).toHaveLength(2);
    net.scheduler.runUntil(net.scheduler.now + 300_001);
    expect(fdbOf(sw)).toHaveLength(0);
  });

  it('reports Destination Host Unreachable after 3 unanswered ARP probes', () => {
    const { net, pc1 } = twoHosts();
    const sw = net.addDevice('switch');
    net.connect(pc1, sw);
    const events = ping(net, pc1, '10.0.0.99');
    expect(events).toEqual([{ kind: 'unreachable', from: ip('10.0.0.1'), seq: 1, code: 'host' }]);
    expect(net.trace.filter((t) => t.frame.payload.kind === 'arp')).toHaveLength(3);
    expect(net.scheduler.now).toBeGreaterThanOrEqual(3000);
    expect(ipOf(pc1).neighbors.get(ip('10.0.0.99'))?.state).toBe('FAILED');
  });

  it('has no route to other subnets or without a cable', () => {
    const { net, pc1, pc2 } = twoHosts();
    const echo = { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 } as const;
    expect(ipOf(pc1).sendIcmp(ip('10.0.0.2'), echo)).toBe('Network is unreachable');
    net.connect(pc1, pc2);
    expect(ipOf(pc1).sendIcmp(ip('10.0.0.2'), echo)).toBeNull();
    expect(ipOf(pc1).sendIcmp(ip('172.16.0.1'), echo)).toBe('Network is unreachable');
  });

  it('answers pings to its own address without touching the wire', () => {
    const { net, pc1 } = twoHosts();
    expect(ping(net, pc1, '10.0.0.1')).toHaveLength(1);
    expect(net.trace).toHaveLength(0);
  });

  it('drops traffic when an interface is down and flushes its neighbors', () => {
    const { net, pc1, pc2 } = twoHosts();
    net.connect(pc1, pc2);
    expect(ping(net, pc1, '10.0.0.2')).toHaveLength(1);
    const port = pc2.port('eth0');
    if (!port) throw new Error('setup');
    net.setPortUp(port, false);
    expect(ipOf(pc1).neighbors.size).toBe(0);
    const echo = { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 } as const;
    expect(ipOf(pc1).sendIcmp(ip('10.0.0.2'), echo)).toBe('Network is unreachable');
    net.setPortUp(port, true);
    expect(ping(net, pc1, '10.0.0.2')).toHaveLength(1);
  });

  it('refuses cables that would create a switching loop or have no free port', () => {
    const net = new Network();
    const [sw1, sw2, sw3] = [
      net.addDevice('switch'),
      net.addDevice('switch'),
      net.addDevice('switch'),
    ];
    net.connect(sw1, sw2);
    net.connect(sw2, sw3);
    expect(() => net.connect(sw3, sw1)).toThrow(/switching loop/);
    // A cable between two ports of the same switch is a loop too.
    expect(() => net.connect(sw1, sw1)).toThrow(/switching loop/);
    const port = sw1.port('eth5');
    if (!port) throw new Error('setup');
    expect(() => net.connect(port, port)).toThrow(/itself/);
    const pc1 = net.addDevice('pc');
    const pc2 = net.addDevice('pc');
    const pc3 = net.addDevice('pc');
    net.connect(pc1, pc2);
    expect(() => net.connect(pc1, pc3)).toThrow(/no free port/);
  });

  it('cables chosen ports and checks that the cable fits', () => {
    const net = new Network();
    const [sw1, sw2, pc] = [net.addDevice('switch'), net.addDevice('switch'), net.addDevice('pc')];
    const port = (d: Device, name: string) => {
      const p = d.port(name);
      if (!p) throw new Error(`no ${name}`);
      return p;
    };
    const copper = net.connect(port(pc, 'eth0'), port(sw1, 'eth3'));
    expect([copper.a.name, copper.b.name, copper.medium]).toEqual(['eth0', 'eth3', 'copper']);
    const fiber = net.connect(port(sw1, 'eth8'), port(sw2, 'eth9'));
    expect(fiber.medium).toBe('fiber');
    expect(() => net.connect(port(sw2, 'eth0'), port(sw1, 'eth9'))).toThrow(
      /need different cables/,
    );
    expect(() => net.connect(port(sw2, 'eth1'), port(sw1, 'eth3'))).toThrow(/already has a cable/);
    // Picking a port for a device skips ports the other end's cable does not fit.
    const sw3 = net.addDevice('switch');
    expect(net.freePortsFor(sw3, port(sw2, 'eth8')).map((p) => p.name)).toEqual(['eth8', 'eth9']);
    expect(net.connect(sw3, port(sw2, 'eth8')).a.name).toBe('eth8');
  });

  it('frees ports when a cable or device is removed', () => {
    const { net, pc1, pc2 } = twoHosts();
    const sw = net.addDevice('switch');
    const link = net.connect(pc1, sw);
    net.connect(pc2, sw);
    net.disconnect(link);
    expect(pc1.ports[0]?.link).toBeNull();
    net.removeDevice(sw);
    expect(pc2.ports[0]?.link).toBeNull();
    expect(net.links.size).toBe(0);
    expect(net.devices.has(sw.id)).toBe(false);
  });

  it('round-trips through a snapshot and keeps working', () => {
    const { net, pc1, pc2 } = twoHosts();
    const sw = net.addDevice('switch');
    net.connect(pc1, sw);
    net.connect(pc2, sw);
    const port = sw.port('eth5');
    if (port) net.setPortUp(port, false);
    const snapshot = JSON.parse(JSON.stringify(net.toJSON()));
    const copy = Network.fromJSON(snapshot);
    expect(copy.toJSON()).toEqual(net.toJSON());
    const copyPc1 = copy.devices.get(pc1.id) as Device;
    expect(ping(copy, copyPc1, '10.0.0.2')).toHaveLength(1);
    // New ids continue after the restored counters.
    expect(copy.addDevice('pc').id).toBe('d4');
  });

  it('loads a static route whose gateway went off-link as the same inactive route', () => {
    const { net, pc1 } = routed();
    sh(net, pc1, 'ip addr flush dev eth0');
    sh(net, pc1, 'ip addr add 192.168.1.10/30 dev eth0');
    const before = sh(net, pc1, 'ip route');
    expect(before.join(' ')).toContain('default via 192.168.1.1');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    const again = copy.devices.get(pc1.id) as Device;
    expect(sh(copy, again, 'ip route')).toEqual(before);
    expect(ipOf(again).routeTo(ip('192.168.2.20'))).toBeNull();
    sh(copy, again, 'ip addr flush dev eth0');
    sh(copy, again, 'ip addr add 192.168.1.10/24 dev eth0');
    expect(ping(copy, again, '192.168.2.20')).toHaveLength(1);
  });

  it('rejects inconsistent snapshots', () => {
    const { net, pc1, pc2 } = twoHosts();
    net.connect(pc1, pc2);
    const snapshot = net.toJSON();
    const broken = {
      ...snapshot,
      links: [{ id: 'l9', a: { device: 'd1', port: 'eth0' }, b: { device: 'd404', port: 'eth0' } }],
    };
    expect(() => Network.fromJSON(broken)).toThrow(/Invalid link/);
    const badAddr: typeof snapshot = JSON.parse(JSON.stringify(snapshot));
    const firstPort = badAddr.devices[0]?.ports[0];
    if (firstPort) firstPort.addrs = ['999.0.0.1/24'];
    expect(() => Network.fromJSON(badAddr)).toThrow(/Invalid address/);
  });

  it('is deterministic', () => {
    const run = () => {
      const net = new Network();
      const sw = net.addDevice('switch');
      const hosts = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
      hosts.forEach((h, i) => {
        addr(h, `10.1.0.${i + 1}/16`);
        net.connect(h, sw);
      });
      const first = hosts[0];
      if (!first) throw new Error('setup');
      ping(net, first, '10.1.0.2');
      ping(net, first, '10.1.0.3');
      return net.trace.map((t) => `${t.time}:${t.from.device}>${t.to.device}`).join(',');
    };
    expect(run()).toBe(run());
    expect(formatIp(ip('10.1.0.3'))).toBe('10.1.0.3');
  });
});
