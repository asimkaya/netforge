import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

/** Runs a command and the simulation until it exits (or `ms` passes). */
function sh(net: Network, device: Device, line: string, ms = 20_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

function port(device: Device, name: string) {
  const p = device.port(name);
  if (!p) throw new Error(`no ${name}`);
  return p;
}

/** pcA 10.0.1.10 ── r1 (10.0.1.1 | 10.0.2.1) ── pcB 10.0.2.10 */
function twoNets() {
  const net = new Network();
  const r1 = net.addDevice('router');
  const pcA = net.addDevice('pc');
  const pcB = net.addDevice('pc');
  net.connect(port(pcA, 'eth0'), port(r1, 'eth0'));
  net.connect(port(pcB, 'eth0'), port(r1, 'eth1'));
  for (const [d, line] of [
    [r1, 'ip addr add 10.0.1.1/24 dev eth0'],
    [r1, 'ip addr add 10.0.2.1/24 dev eth1'],
    [pcA, 'ip addr add 10.0.1.10/24 dev eth0'],
    [pcB, 'ip addr add 10.0.2.10/24 dev eth0'],
  ] as const) {
    expect(sh(net, d, line)).toEqual([]);
  }
  return { net, r1, pcA, pcB };
}

function withGateways() {
  const lab = twoNets();
  expect(sh(lab.net, lab.pcA, 'ip route add default via 10.0.1.1')).toEqual([]);
  expect(sh(lab.net, lab.pcB, 'ip route add default via 10.0.2.1')).toEqual([]);
  return lab;
}

describe('routing', () => {
  it('needs a default gateway to reach another network', () => {
    const { net, pcA } = twoNets();
    expect(sh(net, pcA, 'ping -c 1 10.0.2.10').at(-1)).toBe(
      'ping: connect: Network is unreachable',
    );
  });

  it('forwards packets between networks and decrements the TTL', () => {
    const { net, pcA } = withGateways();
    const out = sh(net, pcA, 'ping -c 1 10.0.2.10');
    expect(out).toContain('64 bytes from 10.0.2.10: icmp_seq=1 ttl=63 time=2.00 ms');
    expect(out).toContain('1 packets transmitted, 1 received, 0% packet loss, time 2ms');
  });

  it('shows and explains routes like iproute2', () => {
    const { net, pcA, r1 } = withGateways();
    expect(sh(net, pcA, 'ip route')).toEqual([
      'default via 10.0.1.1 dev eth0',
      '10.0.1.0/24 dev eth0 proto kernel scope link src 10.0.1.10',
    ]);
    expect(sh(net, pcA, 'ip route get 10.0.2.10')).toEqual([
      '10.0.2.10 via 10.0.1.1 dev eth0 src 10.0.1.10',
    ]);
    expect(sh(net, pcA, 'ip route get 10.0.1.99')).toEqual(['10.0.1.99 dev eth0 src 10.0.1.10']);
    expect(sh(net, r1, 'ip route get 8.8.8.8')).toEqual([
      'RTNETLINK answers: Network is unreachable',
    ]);
  });

  it('validates ip route add and del', () => {
    const { net, pcA } = withGateways();
    expect(sh(net, pcA, 'ip route add default via 10.0.1.1')).toEqual([
      'RTNETLINK answers: File exists',
    ]);
    expect(sh(net, pcA, 'ip route add 172.16.0.0/16 via 192.168.9.9')).toEqual([
      'Error: Nexthop has invalid gateway.',
    ]);
    expect(sh(net, pcA, 'ip route add 172.16.0.0/16 via 10.0.1.300')).toEqual([
      'Error: inet address is expected rather than "10.0.1.300".',
    ]);
    expect(sh(net, pcA, 'ip route add 172.16.0.0/16')).toEqual([
      'Error: Device for nexthop is not up.',
    ]);
    expect(sh(net, pcA, 'ip route del 172.16.0.0/16')).toEqual([
      'RTNETLINK answers: No such process',
    ]);
    expect(sh(net, pcA, 'ip route del default')).toEqual([]);
    expect(sh(net, pcA, 'ip route')).toHaveLength(1);
  });

  it('does not forward when ip_forward is off', () => {
    const { net, pcA, r1 } = withGateways();
    expect(sh(net, r1, 'sysctl -w net.ipv4.ip_forward=0')).toEqual(['net.ipv4.ip_forward = 0']);
    expect(sh(net, pcA, 'ping -c 1 10.0.2.10')).toContain(
      '1 packets transmitted, 0 received, 100% packet loss, time 10000ms',
    );
    expect(sh(net, r1, 'sysctl net.ipv4.ip_forward=1')).toEqual(['net.ipv4.ip_forward = 1']);
    expect(sh(net, pcA, 'ping -c 1 10.0.2.10')).toContain(
      '1 packets transmitted, 1 received, 0% packet loss, time 2ms',
    );
    expect(sh(net, pcA, 'sysctl kernel.foo')).toEqual([
      'sysctl: cannot stat /proc/sys/kernel/foo: No such file or directory',
    ]);
  });

  it('answers with ICMP errors: unknown network, missing host, expired TTL', () => {
    const { net, pcA } = withGateways();
    expect(sh(net, pcA, 'ping -c 1 172.16.0.1')).toContain(
      'From 10.0.1.1 icmp_seq=1 Destination Net Unreachable',
    );
    // The router tries ARP three times before it gives up on 10.0.2.99.
    expect(sh(net, pcA, 'ping -c 1 10.0.2.99')).toContain(
      'From 10.0.1.1 icmp_seq=1 Destination Host Unreachable',
    );
    expect(sh(net, pcA, 'ping -c 1 -t 1 10.0.2.10')).toContain(
      'From 10.0.1.1 icmp_seq=1 Time to live exceeded',
    );
    const errors = net.trace.filter(
      (t) => t.frame.payload.kind === 'ipv4' && t.frame.payload.payload.kind === 'icmp',
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('routes across two routers with static routes', () => {
    const { net, r1, pcA } = withGateways();
    const r2 = net.addDevice('router');
    const pcC = net.addDevice('pc');
    net.connect(port(r1, 'eth2'), port(r2, 'eth0'));
    net.connect(port(pcC, 'eth0'), port(r2, 'eth1'));
    sh(net, r1, 'ip addr add 192.168.0.1/30 dev eth2');
    sh(net, r2, 'ip addr add 192.168.0.2/30 dev eth0');
    sh(net, r2, 'ip addr add 10.0.3.1/24 dev eth1');
    sh(net, pcC, 'ip addr add 10.0.3.10/24 dev eth0');
    sh(net, pcC, 'ip route add default via 10.0.3.1');
    expect(sh(net, pcA, 'ping -c 1 10.0.3.10')).toContain(
      'From 10.0.1.1 icmp_seq=1 Destination Net Unreachable',
    );
    expect(sh(net, r1, 'ip route add 10.0.3.0/24 via 192.168.0.2')).toEqual([]);
    expect(sh(net, r2, 'ip route add default via 192.168.0.1 dev eth0')).toEqual([]);
    expect(sh(net, pcA, 'ping -c 1 10.0.3.10')).toContain(
      // pcA already knows r1's MAC from the first ping; both routers still ARP.
      '64 bytes from 10.0.3.10: icmp_seq=1 ttl=62 time=2.50 ms',
    );
    expect(sh(net, r1, 'ip route')).toContain('10.0.3.0/24 via 192.168.0.2 dev eth2');
  });

  it('ends a routing loop when the TTL runs out', () => {
    const { net, r1, pcA } = withGateways();
    const r2 = net.addDevice('router');
    net.connect(port(r1, 'eth2'), port(r2, 'eth0'));
    sh(net, r1, 'ip addr add 192.168.0.1/30 dev eth2');
    sh(net, r2, 'ip addr add 192.168.0.2/30 dev eth0');
    // Each router thinks the other one knows the way.
    sh(net, r1, 'ip route add default via 192.168.0.2');
    sh(net, r2, 'ip route add default via 192.168.0.1');
    expect(sh(net, pcA, 'ping -c 1 172.16.0.1')).toContain(
      'From 192.168.0.2 icmp_seq=1 Time to live exceeded',
    );
    expect(net.scheduler.pending).toBe(0);
  });

  it('marks routes on interfaces without carrier', () => {
    const { net, pcA } = withGateways();
    sh(net, pcA, 'ip link set eth0 down');
    expect(sh(net, pcA, 'ip route')).toEqual(['default via 10.0.1.1 dev eth0 linkdown']);
  });

  it('keeps routes, forwarding and DNS servers in snapshots', () => {
    const { net, pcA, r1 } = withGateways();
    sh(net, r1, 'sysctl -w net.ipv4.ip_forward=0');
    pcA.ip?.setDns([0x0a000101]);
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const copyA = copy.devices.get(pcA.id);
    if (!copyA) throw new Error('missing');
    expect(sh(copy, copyA, 'ip route')[0]).toBe('default via 10.0.1.1 dev eth0');
    expect(copy.devices.get(r1.id)?.ip?.forwarding).toBe(false);
    expect(copyA.ip?.dns).toEqual([0x0a000101]);
  });

  it('traces the routers on the way with traceroute', () => {
    const { net, pcA, r1 } = withGateways();
    expect(sh(net, pcA, 'traceroute 10.0.2.10')).toEqual([
      'traceroute to 10.0.2.10 (10.0.2.10), 30 hops max, 60 byte packets',
      ' 1  10.0.1.1 (10.0.1.1)  1.000 ms  1.000 ms  1.000 ms',
      ' 2  10.0.2.10 (10.0.2.10)  1.500 ms  1.500 ms  1.500 ms',
    ]);
    // No route beyond the router: it says so with !N and traceroute stops.
    expect(sh(net, pcA, 'traceroute 172.16.0.1').at(-1)).toBe(
      ' 1  10.0.1.1 (10.0.1.1)  0.500 ms !N  0.500 ms !N  0.500 ms !N',
    );
    // With forwarding off the router silently drops what isn't for it: only stars.
    sh(net, r1, 'sysctl -w net.ipv4.ip_forward=0');
    expect(sh(net, pcA, 'traceroute -m 2 10.0.2.10')).toEqual([
      'traceroute to 10.0.2.10 (10.0.2.10), 2 hops max, 60 byte packets',
      ' 1  * * *',
      ' 2  * * *',
    ]);
    expect(net.scheduler.pending).toBe(0);
  });
});
