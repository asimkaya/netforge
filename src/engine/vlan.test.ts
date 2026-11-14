import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { describeFrame } from './packet.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

const pings = (net: Network, from: Device, to: string) =>
  sh(net, from, `ping -c 1 ${to}`).some((l) => l.includes(' 1 received'));

/** A switch with pc1 and pc3 in VLAN 10, pc2 in VLAN 20, and a trunk on eth7. */
function lab() {
  const net = new Network();
  const sw = net.addDevice('switch');
  const [pc1, pc2, pc3] = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
  const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);
  net.connect(port(pc1, 'eth0'), port(sw, 'eth0'));
  net.connect(port(pc2, 'eth0'), port(sw, 'eth1'));
  net.connect(port(pc3, 'eth0'), port(sw, 'eth2'));
  for (const [i, d] of [pc1, pc2, pc3].entries())
    sh(net, d, `ip addr add 10.0.0.${i + 1}/24 dev eth0`);
  const access = (dev: string, vid: number) => {
    sh(net, sw, `bridge vlan add dev ${dev} vid ${vid} pvid untagged`);
    sh(net, sw, `bridge vlan del dev ${dev} vid 1`);
  };
  access('eth0', 10);
  access('eth1', 20);
  access('eth2', 10);
  sh(net, sw, 'bridge vlan add dev eth7 vid 10');
  sh(net, sw, 'bridge vlan add dev eth7 vid 20');
  return { net, sw, pc1, pc2, pc3, port };
}

describe('VLANs', () => {
  it('are ignored until VLAN filtering is on, like a Linux bridge', () => {
    const { net, sw, pc1 } = lab();
    expect(pings(net, pc1, '10.0.0.2')).toBe(true);
    expect(sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1')).toEqual([]);
    sh(net, pc1, 'ip neigh flush all');
    expect(pings(net, pc1, '10.0.0.2')).toBe(false);
    expect(pings(net, pc1, '10.0.0.3')).toBe(true);
    expect(sh(net, sw, 'bridge fdb')).toContain(`${pc1.ports[0]?.mac} dev eth0 vlan 10 master br0`);
  });

  it('lists port VLANs like bridge vlan show', () => {
    const { net, sw } = lab();
    const lines = sh(net, sw, 'bridge vlan show');
    expect(lines.slice(0, 5)).toEqual([
      'port              vlan-id',
      'eth0              10 PVID Egress Untagged',
      'eth1              20 PVID Egress Untagged',
      'eth2              10 PVID Egress Untagged',
      'eth3              1 PVID Egress Untagged',
    ]);
    expect(lines.slice(-5)).toEqual([
      'eth7              1 PVID Egress Untagged',
      '                  10',
      '                  20',
      'eth8              1 PVID Egress Untagged',
      'eth9              1 PVID Egress Untagged',
    ]);
    expect(sh(net, sw, 'bridge vlan add dev eth0 vid 5000')).toEqual(['Invalid VLAN ID "5000"']);
    expect(sh(net, sw, 'bridge vlan add vid 5')).toEqual([
      'Device and VLAN ID are required arguments.',
    ]);
    expect(sh(net, sw, 'bridge vlan del dev eth0 vid 99')).toEqual([
      'RTNETLINK answers: No such file or directory',
    ]);
    expect(sh(net, sw, 'ip link show br0')[0]).toMatch(/^12: br0: /);
  });

  it('routes between VLANs over a trunk (router on a stick)', () => {
    const { net, sw, pc1, pc2, port } = lab();
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    const r1 = net.addDevice('router');
    net.connect(port(r1, 'eth0'), port(sw, 'eth7'));
    expect(sh(net, r1, 'ip link add link eth0 name eth0.10 type vlan id 10')).toEqual([]);
    sh(net, r1, 'ip link add link eth0 name eth0.20 type vlan id 20');
    sh(net, r1, 'ip addr add 192.168.10.1/24 dev eth0.10');
    sh(net, r1, 'ip addr add 192.168.20.1/24 dev eth0.20');
    // New links start down on Linux.
    expect(sh(net, r1, 'ip link show eth0.10')).toEqual([
      '6: eth0.10@eth0: <BROADCAST,MULTICAST> mtu 1500 state DOWN',
      `    link/ether ${r1.ports[0]?.mac} brd ff:ff:ff:ff:ff:ff`,
      '    vlan protocol 802.1Q id 10',
    ]);
    sh(net, r1, 'ip link set eth0.10 up');
    sh(net, r1, 'ip link set eth0.20 up');
    sh(net, pc1, 'ip addr flush dev eth0');
    sh(net, pc1, 'ip addr add 192.168.10.2/24 dev eth0');
    sh(net, pc1, 'ip route add default via 192.168.10.1');
    sh(net, pc2, 'ip addr flush dev eth0');
    sh(net, pc2, 'ip addr add 192.168.20.2/24 dev eth0');
    sh(net, pc2, 'ip route add default via 192.168.20.1');
    net.trace = [];
    expect(pings(net, pc1, '192.168.20.2')).toBe(true);
    const trunk = net.trace.filter(
      (e) => (e.from.device === r1.id || e.to.device === r1.id) && e.frame.payload.kind !== 'ipv6',
    );
    expect(trunk.length).toBeGreaterThan(0);
    expect(trunk.every((e) => e.frame.vlan === 10 || e.frame.vlan === 20)).toBe(true);
    const access = net.trace.filter((e) => e.from.device === pc1.id || e.to.device === pc1.id);
    expect(access.every((e) => e.frame.vlan === undefined)).toBe(true);
    expect(describeFrame(trunk[0]?.frame ?? (undefined as never))).toMatch(/^vlan 10, ARP/);
    expect(sh(net, pc1, 'traceroute 192.168.20.2').slice(1)).toEqual([
      ' 1  192.168.10.1 (192.168.10.1)  1.000 ms  1.000 ms  1.000 ms',
      ' 2  192.168.20.2 (192.168.20.2)  2.000 ms  2.000 ms  2.000 ms',
    ]);
  });

  it('keeps VLAN settings across a save and load, and deletes VLAN interfaces', () => {
    const { net, sw, port } = lab();
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    const r1 = net.addDevice('router');
    net.connect(port(r1, 'eth0'), port(sw, 'eth7'));
    sh(net, r1, 'ip link add link eth0 name eth0.10 type vlan id 10');
    sh(net, r1, 'ip addr add 192.168.10.1/24 dev eth0.10');
    sh(net, r1, 'ip link set eth0.10 up');
    sh(net, r1, 'ip route add 172.16.0.0/16 via 192.168.10.9');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const r2 = copy.devices.get(r1.id) ?? (undefined as never);
    expect(sh(copy, r2, 'ip route')).toContain('172.16.0.0/16 via 192.168.10.9 dev eth0.10');
    expect(sh(copy, r2, 'ip link add link eth0 name eth0.10 type vlan id 11')).toEqual([
      'RTNETLINK answers: File exists',
    ]);
    expect(sh(copy, r2, 'ip link add link eth0 name v type vlan id 4095')).toEqual([
      'Error: argument "4095" is wrong: id is invalid',
    ]);
    expect(sh(copy, r2, 'ip link del eth0')).toEqual([
      'RTNETLINK answers: Operation not supported',
    ]);
    expect(sh(copy, r2, 'ip link del eth0.10')).toEqual([]);
    expect(sh(copy, r2, 'ip route')).toEqual([]);
    expect(copy.devices.get(r1.id)?.port('eth0.10')).toBeUndefined();
  });
});
