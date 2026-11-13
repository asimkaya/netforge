import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

/** Runs a command and the simulation until it exits (or `ms` passes). */
function sh(net: Network, device: Device, line: string, ms = 20_000) {
  const lines: string[] = [];
  let exited = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (exited = true) });
  if (proc) net.scheduler.runUntil(net.scheduler.now + ms);
  return { lines, exited, proc };
}

function lab() {
  const net = new Network();
  const sw = net.addDevice('switch');
  const pc1 = net.addDevice('pc');
  const pc2 = net.addDevice('pc');
  net.connect(pc1, sw);
  net.connect(pc2, sw);
  expect(sh(net, pc1, 'ip addr add 192.168.1.10/24 dev eth0').lines).toEqual([]);
  expect(sh(net, pc2, 'ip a add 192.168.1.20/24 dev eth0').lines).toEqual([]);
  return { net, sw, pc1, pc2 };
}

describe('shell', () => {
  it('shows interfaces and addresses like iproute2', () => {
    const { net, pc1 } = lab();
    expect(sh(net, pc1, 'ip addr').lines).toEqual([
      '1: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP',
      `    link/ether ${pc1.ports[0]?.mac} brd ff:ff:ff:ff:ff:ff`,
      '    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0',
    ]);
    expect(sh(net, pc1, 'ip route').lines).toEqual([
      '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10',
    ]);
  });

  it('reports a missing cable as NO-CARRIER', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    expect(sh(net, pc, 'ip link').lines[0]).toBe(
      '1: eth0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 state DOWN',
    );
  });

  it('validates ip addr arguments with Linux error messages', () => {
    const { net, pc1 } = lab();
    expect(sh(net, pc1, 'ip addr add 192.168.1.10/24 dev eth0').lines).toEqual([
      'Error: ipv4: Address already assigned.',
    ]);
    expect(sh(net, pc1, 'ip addr add 300.1.1.1/24 dev eth0').lines).toEqual([
      'Error: any valid prefix is expected rather than "300.1.1.1/24".',
    ]);
    expect(sh(net, pc1, 'ip addr add 10.0.0.1/8').lines).toEqual([
      'Not enough information: "dev" argument is required.',
    ]);
    expect(sh(net, pc1, 'ip addr add 10.0.0.1/8 dev eth7').lines).toEqual([
      'Cannot find device "eth7"',
    ]);
    expect(sh(net, pc1, 'ip addr del 10.9.9.9/8 dev eth0').lines).toEqual([
      'Error: ipv4: Address not found.',
    ]);
    expect(sh(net, pc1, 'ip addr flush dev eth0').lines).toEqual([]);
    expect(pc1.ip?.allAddrs()).toEqual([]);
    expect(sh(net, pc1, 'ip foo').lines).toEqual(['Object "foo" is unknown, try "ip help".']);
    expect(sh(net, pc1, 'nmap').lines).toEqual(['nmap: command not found']);
  });

  it('pings with Linux-style output and statistics', () => {
    const { net, pc1, pc2 } = lab();
    const { lines, exited } = sh(net, pc1, 'ping -c 2 192.168.1.20', 1001);
    expect(exited).toBe(true);
    expect(net.scheduler.pending).toBe(0);
    expect(lines).toEqual([
      'PING 192.168.1.20 (192.168.1.20) 56(84) bytes of data.',
      '64 bytes from 192.168.1.20: icmp_seq=1 ttl=64 time=2.00 ms',
      '64 bytes from 192.168.1.20: icmp_seq=2 ttl=64 time=1.00 ms',
      '',
      '--- 192.168.1.20 ping statistics ---',
      '2 packets transmitted, 2 received, 0% packet loss, time 1001ms',
      'rtt min/avg/max/mdev = 1.000/1.500/2.000/0.500 ms',
    ]);
    expect(sh(net, pc1, 'ip neigh').lines).toEqual([
      `192.168.1.20 dev eth0 lladdr ${pc2.ports[0]?.mac} REACHABLE`,
    ]);
  });

  it('reports unreachable hosts and missing routes', () => {
    const { net, pc1 } = lab();
    const lost = sh(net, pc1, 'ping -c 1 192.168.1.99').lines;
    expect(lost).toContain('From 192.168.1.10 icmp_seq=1 Destination Host Unreachable');
    expect(lost).toContain(
      '1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 3000ms',
    );
    expect(sh(net, pc1, 'ping 8.8.8.8').lines).toEqual([
      'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.',
      'ping: connect: Network is unreachable',
    ]);
    expect(sh(net, pc1, 'ping example.com').lines).toEqual([
      'ping: example.com: Name or service not known',
    ]);
    expect(sh(net, pc1, 'ping -c 0 1.1.1.1').lines).toEqual(["ping: invalid argument: '0'"]);
  });

  it('can be interrupted like Ctrl+C', () => {
    const { net, pc1 } = lab();
    const lines: string[] = [];
    const proc = run(net, pc1, 'ping -c 100 192.168.1.20', {
      out: (l) => lines.push(l),
      exit: () => {},
    });
    net.scheduler.runUntil(2500);
    proc?.interrupt();
    expect(lines.at(-2)).toBe('3 packets transmitted, 3 received, 0% packet loss, time 2500ms');
    const after = lines.length;
    net.scheduler.runUntil(10_000);
    expect(lines.length).toBe(after);
  });

  it('brings interfaces up and down', () => {
    const { net, pc1 } = lab();
    sh(net, pc1, 'ip link set eth0 down');
    expect(pc1.ports[0]?.adminUp).toBe(false);
    expect(sh(net, pc1, 'ping 192.168.1.20').lines.at(-1)).toBe(
      'ping: connect: Network is unreachable',
    );
    sh(net, pc1, 'ip link set dev eth0 up');
    expect(pc1.ports[0]?.adminUp).toBe(true);
  });

  it('shows the switch forwarding database and supports hostname', () => {
    const { net, sw, pc1, pc2 } = lab();
    sh(net, pc1, 'ping -c 1 192.168.1.20');
    expect(sh(net, sw, 'bridge fdb show').lines).toEqual([
      `${pc1.ports[0]?.mac} dev eth0 master br0`,
      `${pc2.ports[0]?.mac} dev eth1 master br0`,
    ]);
    expect(sh(net, sw, 'ip addr add 1.1.1.1/24 dev eth0').lines).toEqual([
      'RTNETLINK answers: Operation not supported',
    ]);
    sh(net, sw, 'hostname core-sw');
    expect(sh(net, sw, 'hostname').lines).toEqual(['core-sw']);
    expect(sh(net, sw, 'hostname bad_name!').lines).toEqual([
      'hostname: the specified hostname is invalid',
    ]);
  });

  it('flushes the neighbor table', () => {
    const { net, pc1 } = lab();
    sh(net, pc1, 'ping -c 1 192.168.1.20');
    expect(pc1.ip?.neighbors.size).toBe(1);
    sh(net, pc1, 'ip neigh flush all');
    expect(pc1.ip?.neighbors.size).toBe(0);
  });
});
