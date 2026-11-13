import { describe, expect, it } from 'vitest';
import { formatIp, parseCidr, parseIp, type Ip } from './addr.ts';
import type { Host, IcmpEvent } from './host.ts';
import { Network } from './network.ts';

function ip(text: string): Ip {
  const value = parseIp(text);
  if (value === null) throw new Error(`bad ip ${text}`);
  return value;
}

function addr(host: Host, cidr: string): void {
  const parsed = parseCidr(cidr);
  const port = host.port('eth0');
  if (!parsed || !port) throw new Error('bad setup');
  expect(host.addAddress(port, parsed)).toBeNull();
}

/** Sends one echo request and runs the simulation for `ms`. */
function ping(net: Network, from: Host, to: string, ms = 5000): IcmpEvent[] {
  const events: IcmpEvent[] = [];
  const id = from.openIcmp((e) => events.push(e));
  const error = from.sendIcmp(ip(to), { kind: 'icmp', type: 'echo-request', id, seq: 1 });
  if (error) throw new Error(error);
  net.scheduler.runUntil(net.scheduler.now + ms);
  from.closeIcmp(id);
  return events;
}

function twoHosts() {
  const net = new Network();
  const pc1 = net.addHost();
  const pc2 = net.addHost();
  addr(pc1, '10.0.0.1/24');
  addr(pc2, '10.0.0.2/24');
  return { net, pc1, pc2 };
}

describe('Network', () => {
  it('names devices and gives each port a unique MAC', () => {
    const net = new Network();
    const pc = net.addHost();
    const sw = net.addSwitch();
    expect(pc.name).toBe('pc1');
    expect(sw.name).toBe('sw1');
    expect(sw.ports).toHaveLength(8);
    const macs = [...pc.ports, ...sw.ports].map((p) => p.mac);
    expect(new Set(macs).size).toBe(macs.length);
  });

  it('pings across a direct cable, resolving ARP first', () => {
    const { net, pc1, pc2 } = twoHosts();
    net.connect(pc1, pc2);
    const events = ping(net, pc1, '10.0.0.2');
    expect(events).toEqual([{ kind: 'reply', from: ip('10.0.0.2'), seq: 1, ttl: 64 }]);
    expect(net.trace.map((t) => t.frame.payload.kind)).toEqual(['arp', 'arp', 'ipv4', 'ipv4']);
    expect(pc1.neighbors.get(ip('10.0.0.2'))?.state).toBe('REACHABLE');
    expect(pc2.neighbors.get(ip('10.0.0.1'))?.mac).toBe(pc1.ports[0]?.mac);
    expect(pc1.echoRepliesFrom.has(ip('10.0.0.2'))).toBe(true);
  });

  it('pings through a switch, which learns MAC addresses', () => {
    const net = new Network();
    const sw = net.addSwitch();
    const [pc1, pc2, pc3] = [net.addHost(), net.addHost(), net.addHost()];
    if (!pc1 || !pc2 || !pc3) throw new Error('setup');
    [pc1, pc2, pc3].forEach((pc, i) => {
      addr(pc, `192.168.1.${i + 1}/24`);
      net.connect(pc, sw);
    });
    expect(ping(net, pc1, '192.168.1.3')).toHaveLength(1);
    const learned = sw.fdb().map((e) => [e.mac, e.port.name]);
    expect(learned).toEqual([
      [pc1.ports[0]?.mac, 'eth0'],
      [pc3.ports[0]?.mac, 'eth2'],
    ]);
    // The ARP request was flooded to pc2, but the unicast echo was not.
    const toPc2 = net.trace.filter((t) => t.to.device === pc2.id);
    expect(toPc2.map((t) => t.frame.payload.kind)).toEqual(['arp']);
  });

  it('ages out switch entries after 300 s', () => {
    const { net, pc1, pc2 } = twoHosts();
    const sw = net.addSwitch();
    net.connect(pc1, sw);
    net.connect(pc2, sw);
    ping(net, pc1, '10.0.0.2');
    expect(sw.fdb()).toHaveLength(2);
    net.scheduler.runUntil(net.scheduler.now + 300_001);
    expect(sw.fdb()).toHaveLength(0);
  });

  it('reports Destination Host Unreachable after 3 unanswered ARP probes', () => {
    const { net, pc1 } = twoHosts();
    const sw = net.addSwitch();
    net.connect(pc1, sw);
    const events = ping(net, pc1, '10.0.0.99');
    expect(events).toEqual([{ kind: 'unreachable', from: ip('10.0.0.1'), seq: 1 }]);
    expect(net.trace.filter((t) => t.frame.payload.kind === 'arp')).toHaveLength(3);
    expect(net.scheduler.now).toBeGreaterThanOrEqual(3000);
    expect(pc1.neighbors.get(ip('10.0.0.99'))?.state).toBe('FAILED');
  });

  it('has no route to other subnets or without a cable', () => {
    const { net, pc1, pc2 } = twoHosts();
    const echo = { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 } as const;
    expect(pc1.sendIcmp(ip('10.0.0.2'), echo)).toBe('Network is unreachable');
    net.connect(pc1, pc2);
    expect(pc1.sendIcmp(ip('10.0.0.2'), echo)).toBeNull();
    expect(pc1.sendIcmp(ip('172.16.0.1'), echo)).toBe('Network is unreachable');
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
    expect(pc1.neighbors.size).toBe(0);
    const echo = { kind: 'icmp', type: 'echo-request', id: 1, seq: 1 } as const;
    expect(pc1.sendIcmp(ip('10.0.0.2'), echo)).toBe('Network is unreachable');
    net.setPortUp(port, true);
    expect(ping(net, pc1, '10.0.0.2')).toHaveLength(1);
  });

  it('refuses cables that would create a switching loop or have no free port', () => {
    const net = new Network();
    const [sw1, sw2, sw3] = [net.addSwitch(), net.addSwitch(), net.addSwitch()];
    net.connect(sw1, sw2);
    net.connect(sw2, sw3);
    expect(() => net.connect(sw3, sw1)).toThrow(/switching loop/);
    expect(() => net.connect(sw1, sw1)).toThrow(/itself/);
    const pc1 = net.addHost();
    const pc2 = net.addHost();
    const pc3 = net.addHost();
    net.connect(pc1, pc2);
    expect(() => net.connect(pc1, pc3)).toThrow(/no free port/);
  });

  it('frees ports when a cable or device is removed', () => {
    const { net, pc1, pc2 } = twoHosts();
    const sw = net.addSwitch();
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
    const sw = net.addSwitch();
    net.connect(pc1, sw);
    net.connect(pc2, sw);
    const port = sw.port('eth5');
    if (port) net.setPortUp(port, false);
    const snapshot = JSON.parse(JSON.stringify(net.toJSON()));
    const copy = Network.fromJSON(snapshot);
    expect(copy.toJSON()).toEqual(net.toJSON());
    const copyPc1 = copy.devices.get(pc1.id) as Host;
    expect(ping(copy, copyPc1, '10.0.0.2')).toHaveLength(1);
    // New ids continue after the restored counters.
    expect(copy.addHost().id).toBe('d4');
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
      const sw = net.addSwitch();
      const hosts = [net.addHost(), net.addHost(), net.addHost()];
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
