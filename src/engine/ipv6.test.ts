import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

const wait = (net: Network, ms: number) => net.scheduler.runUntil(net.scheduler.now + ms);
const received = (lines: string[]) => lines.some((l) => / [1-9]\d* received/.test(l));
const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);
/** The EUI-64 link-local address NetForge gives a port with MAC 02:00:00:00:00:XX. */
const linkLocal = (d: Device, name = 'eth0') => {
  const mac = port(d, name).mac;
  return `fe80::ff:fe00:${parseInt(mac.slice(-2), 16).toString(16)}`;
};

/** pc1 - r1 - pc2, with 2001:db8:1::/64 on the left and 2001:db8:2::/64 on the right. */
function routed() {
  const net = new Network();
  const r1 = net.addDevice('router');
  const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
  net.connect(port(pc1, 'eth0'), port(r1, 'eth0'));
  net.connect(port(pc2, 'eth0'), port(r1, 'eth1'));
  wait(net, 10);
  return { net, r1, pc1, pc2 };
}

describe('IPv6', () => {
  it('pings a neighbor on its link-local address, with the interface given', () => {
    const net = new Network();
    const [a, b] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(a, b);
    expect(sh(net, a, 'ip -6 addr')).toEqual([
      '1: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP',
      `    link/ether ${port(a, 'eth0').mac} brd ff:ff:ff:ff:ff:ff`,
      `    inet6 ${linkLocal(a)}/64 scope link`,
    ]);
    expect(sh(net, a, `ping -c 1 ${linkLocal(b)}`)).toEqual(['ping: connect: Invalid argument']);
    const lines = sh(net, a, `ping -c 1 ${linkLocal(b)}%eth0`);
    expect(lines[0]).toBe(`PING ${linkLocal(b)}%eth0(${linkLocal(b)}%eth0) 56 data bytes`);
    expect(lines[1]).toBe(`64 bytes from ${linkLocal(b)}%eth0: icmp_seq=1 ttl=64 time=1.00 ms`);
    expect(sh(net, a, 'ip -6 neigh')).toEqual([
      `${linkLocal(b)} dev eth0 lladdr ${port(b, 'eth0').mac} REACHABLE`,
    ]);
    // NDP asked for the neighbor on its solicited-node group.
    expect(net.trace.some((e) => e.frame.dst.startsWith('33:33:ff:'))).toBe(true);
  });

  it('routes between networks with static addresses and routes', () => {
    const { net, r1, pc1, pc2 } = routed();
    sh(net, r1, 'ip addr add 2001:db8:1::1/64 dev eth0');
    sh(net, r1, 'ip -6 addr add 2001:db8:2::1/64 dev eth1');
    sh(net, pc1, 'ip addr add 2001:db8:1::10/64 dev eth0');
    sh(net, pc2, 'ip addr add 2001:db8:2::10/64 dev eth0');
    expect(sh(net, pc1, 'ping -c 1 2001:db8:2::10')).toEqual([
      'ping: connect: Network is unreachable',
    ]);
    sh(net, pc1, 'ip -6 route add default via 2001:db8:1::1');
    sh(net, pc2, 'ip route add default via 2001:db8:2::1');
    const lines = sh(net, pc1, 'ping -c 1 2001:db8:2::10');
    expect(lines[1]).toBe('64 bytes from 2001:db8:2::10: icmp_seq=1 ttl=63 time=2.00 ms');
    expect(sh(net, pc1, 'ip -6 route')).toEqual([
      '2001:db8:1::/64 dev eth0 proto kernel metric 256 pref medium',
      'fe80::/64 dev eth0 proto kernel metric 256 pref medium',
      'default via 2001:db8:1::1 dev eth0 metric 1024 pref medium',
    ]);
    expect(sh(net, pc1, 'ping -c 1 -t 1 2001:db8:2::10')[1]).toBe(
      'From 2001:db8:1::1 icmp_seq=1 Time exceeded: Hop limit',
    );
    expect(sh(net, pc1, 'ping -c 1 2001:db8:9::1')[1]).toBe(
      'From 2001:db8:1::1 icmp_seq=1 Destination unreachable: No route',
    );
    // IPv4 output stays IPv4-only.
    expect(sh(net, pc1, 'ip -4 addr').some((l) => l.includes('inet6'))).toBe(false);
  });

  it('configures hosts automatically from router advertisements (SLAAC)', () => {
    const { net, r1, pc1, pc2 } = routed();
    r1.fs?.write(
      '/etc/radvd.conf',
      'interface eth0 {\n  AdvSendAdvert on;\n  prefix 2001:db8:1::/64 {\n  };\n};\ninterface eth1 {\n  AdvSendAdvert on;\n  prefix 2001:db8:2::/64 { };\n};\n',
    );
    sh(net, r1, 'ip addr add 2001:db8:1::1/64 dev eth0');
    sh(net, r1, 'ip addr add 2001:db8:2::1/64 dev eth1');
    sh(net, r1, 'sysctl -w net.ipv6.conf.all.forwarding=0');
    expect(sh(net, r1, 'radvd')).toEqual([
      'radvd: IPv6 forwarding setting is: 0, should be 1 or 2',
    ]);
    sh(net, r1, 'sysctl -w net.ipv6.conf.all.forwarding=1');
    expect(sh(net, r1, 'radvd')).toEqual([]);
    wait(net, 10);
    const mac = port(pc1, 'eth0').mac;
    const slaac = `2001:db8:1::ff:fe00:${parseInt(mac.slice(-2), 16).toString(16)}`;
    expect(sh(net, pc1, 'ip -6 addr')[2]).toBe(
      `    inet6 ${slaac}/64 scope global dynamic mngtmpaddr`,
    );
    expect(sh(net, pc1, 'ip -6 route').at(-1)).toBe(
      `default via ${linkLocal(r1)} dev eth0 proto ra metric 1024 pref medium`,
    );
    const pc2Addr = sh(net, pc2, 'ip -6 addr')[2]?.trim().split(' ')[1]?.split('/')[0] ?? '';
    expect(received(sh(net, pc1, `ping -c 1 ${pc2Addr}`))).toBe(true);
    sh(net, r1, 'killall radvd');
    wait(net, 10);
    // radvd says goodbye: hosts drop it as their default router.
    expect(sh(net, pc1, 'ip -6 route').some((l) => l.startsWith('default'))).toBe(false);
  });

  it('keeps static IPv6 settings and radvd across a save and load', () => {
    const { net, r1, pc1 } = routed();
    r1.fs?.write(
      '/etc/radvd.conf',
      'interface eth0 { AdvSendAdvert on; prefix 2001:db8:1::/64 { }; };',
    );
    sh(net, r1, 'ip addr add 2001:db8:1::1/64 dev eth0');
    sh(net, r1, 'ip -6 route add 2001:db8:99::/64 via 2001:db8:1::99');
    sh(net, r1, 'radvd');
    wait(net, 10);
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    wait(copy, 10);
    const pc = copy.devices.get(pc1.id) ?? pc1;
    expect(sh(copy, pc, 'ip -6 addr')[2]).toContain('scope global dynamic mngtmpaddr');
    expect(received(sh(copy, pc, 'ping -c 1 2001:db8:1::1'))).toBe(true);
    expect(copy.toJSON().devices.find((d) => d.id === pc1.id)?.ip6?.addrs).toEqual({});
  });
});
