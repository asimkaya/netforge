import { describe, expect, it } from 'vitest';
import { DEAD_MS, HELLO_MS } from './bird.ts';
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

/**
 * Three routers in a triangle: r1-r2 (10.0.12.0/24), r2-r3 (10.0.23.0/24) and a slower
 * direct link r1-r3 (10.0.13.0/24, cost 30). pc1 sits on r1's LAN, pc3 on r3's.
 */
function triangle() {
  const net = new Network();
  const [r1, r2, r3] = [net.addDevice('router'), net.addDevice('router'), net.addDevice('router')];
  const [pc1, pc3] = [net.addDevice('pc'), net.addDevice('pc')];
  const cable = (a: Device, ap: string, b: Device, bp: string) =>
    net.connect(port(a, ap), port(b, bp));
  cable(r1, 'eth1', r2, 'eth1');
  cable(r2, 'eth2', r3, 'eth2');
  cable(r1, 'eth2', r3, 'eth1');
  cable(pc1, 'eth0', r1, 'eth0');
  cable(pc3, 'eth0', r3, 'eth0');
  const addrs: [Device, string, string][] = [
    [r1, 'eth0', '192.168.1.1/24'],
    [r1, 'eth1', '10.0.12.1/24'],
    [r1, 'eth2', '10.0.13.1/24'],
    [r2, 'eth1', '10.0.12.2/24'],
    [r2, 'eth2', '10.0.23.2/24'],
    [r3, 'eth0', '192.168.3.1/24'],
    [r3, 'eth1', '10.0.13.3/24'],
    [r3, 'eth2', '10.0.23.3/24'],
    [pc1, 'eth0', '192.168.1.10/24'],
    [pc3, 'eth0', '192.168.3.10/24'],
  ];
  for (const [d, dev, a] of addrs) sh(net, d, `ip addr add ${a} dev ${dev}`);
  sh(net, pc1, 'ip route add default via 192.168.1.1');
  sh(net, pc3, 'ip route add default via 192.168.3.1');
  // The direct r1-r3 link is slow: cost 30 on both ends.
  for (const [r, dev] of [
    [r1, 'eth2'],
    [r3, 'eth1'],
  ] as const) {
    const conf = r.fs?.read('/etc/bird.conf') ?? '';
    r.fs?.write(
      '/etc/bird.conf',
      conf.replace(
        'interface "eth*" {',
        `interface "${dev}" {\n\t\t\tcost 30;\n\t\t};\n\t\tinterface "eth*" {`,
      ),
    );
  }
  return { net, r1, r2, r3, pc1, pc3 };
}

describe('OSPF with BIRD', () => {
  it('finds neighbors, learns routes and installs the cheapest path', () => {
    const { net, r1, r2, r3, pc1 } = triangle();
    expect(received(sh(net, pc1, 'ping -c 1 192.168.3.10'))).toBe(false);
    for (const r of [r1, r2, r3]) expect(sh(net, r, 'bird')).toEqual([]);
    wait(net, 100);
    expect(sh(net, r1, 'birdc show ospf neighbors')).toEqual([
      'BIRD 2.15 ready.',
      'ospf1:',
      'Router ID       Pri          State      DTime   Interface  Router IP',
      '10.0.12.2         1       Full/PtP    39.901  eth1       10.0.12.2',
      '10.0.13.3         1       Full/PtP    39.901  eth2       10.0.13.3',
    ]);
    // Through r2 costs 10 + 10 + 10; the direct link would cost 30 + 10.
    expect(sh(net, r1, 'ip route')).toContain(
      '192.168.3.0/24 via 10.0.12.2 dev eth1 proto bird metric 32',
    );
    expect(sh(net, r1, 'birdc show route')).toContain(
      '192.168.3.0/24       unicast [ospf1 00:00:00] * I (150/30) [10.0.13.3]',
    );
    expect(sh(net, r1, 'birdc show protocols')[4]).toBe(
      'ospf1      OSPF       master4    up     00:00:00      Running',
    );
    const trace = sh(net, pc1, 'traceroute 192.168.3.10')
      .slice(1)
      .map((l) => l.split('  ')[1]);
    expect(trace).toEqual([
      '192.168.1.1 (192.168.1.1)',
      '10.0.12.2 (10.0.12.2)',
      '10.0.23.3 (10.0.23.3)',
      '192.168.3.10 (192.168.3.10)',
    ]);
    expect(net.trace.some((e) => e.frame.dst === '01:00:5e:00:00:05')).toBe(true);
  });

  it('stops BIRD when its router is deleted', () => {
    const { net, r1 } = triangle();
    sh(net, r1, 'bird');
    net.removeDevice(r1);
    wait(net, 100);
    expect(net.scheduler.pending).toBe(0);
  });

  it('sends traffic over the cheaper of two links to the same router', () => {
    const net = new Network();
    const [r1, r2] = [net.addDevice('router'), net.addDevice('router')];
    net.connect(port(r1, 'eth1'), port(r2, 'eth1'));
    net.connect(port(r1, 'eth2'), port(r2, 'eth2'));
    sh(net, r1, 'ip addr add 10.0.1.1/24 dev eth1');
    sh(net, r2, 'ip addr add 10.0.1.2/24 dev eth1');
    sh(net, r1, 'ip addr add 10.0.2.1/24 dev eth2');
    sh(net, r2, 'ip addr add 10.0.2.2/24 dev eth2');
    sh(net, r2, 'ip addr add 192.168.2.1/24 dev eth0');
    net.connect(port(net.addDevice('pc'), 'eth0'), port(r2, 'eth0')); // a LAN needs a carrier
    // eth1 (found first) is the slow link.
    const conf = r1.fs?.read('/etc/bird.conf') ?? '';
    r1.fs?.write(
      '/etc/bird.conf',
      conf.replace(
        'interface "eth*" {',
        'interface "eth1" {\n\t\t\tcost 100;\n\t\t};\n\t\tinterface "eth*" {',
      ),
    );
    for (const r of [r1, r2]) sh(net, r, 'bird');
    wait(net, 100);
    expect(sh(net, r1, 'ip route').find((l) => l.startsWith('192.168.2.0/24'))).toMatch(
      /via 10\.0\.2\.2 dev eth2/,
    );
  });

  it('reroutes when a link fails and when a router goes silent', () => {
    const { net, r1, r2, r3, pc1 } = triangle();
    for (const r of [r1, r2, r3]) sh(net, r, 'bird');
    wait(net, 100);
    net.disconnect(port(r1, 'eth1').link ?? (undefined as never));
    expect(sh(net, r1, 'ip route')).toContain(
      '192.168.3.0/24 via 10.0.13.3 dev eth2 proto bird metric 32',
    );
    expect(received(sh(net, pc1, 'ping -c 1 192.168.3.10'))).toBe(true);
    net.connect(port(r1, 'eth1'), port(r2, 'eth1'));
    wait(net, 100);
    expect(sh(net, r1, 'ip route')).toContain(
      '192.168.3.0/24 via 10.0.12.2 dev eth1 proto bird metric 32',
    );
    // r2 stops: its neighbors notice after the dead interval (40 s).
    sh(net, r2, 'killall bird');
    wait(net, HELLO_MS);
    expect(sh(net, r1, 'ip route')).toContain(
      '192.168.3.0/24 via 10.0.12.2 dev eth1 proto bird metric 32',
    );
    wait(net, DEAD_MS);
    expect(sh(net, r1, 'ip route')).toContain(
      '192.168.3.0/24 via 10.0.13.3 dev eth2 proto bird metric 32',
    );
    expect(sh(net, r2, 'ip route').some((l) => l.includes('proto bird'))).toBe(false);
  });

  it('needs kernel export to change the routing table, and reports errors like BIRD', () => {
    const { net, r1, r2 } = triangle();
    expect(sh(net, r1, 'birdc show route')).toEqual([
      'Unable to connect to server control socket (/run/bird/bird.ctl): No such file or directory',
    ]);
    r1.fs?.write('/etc/bird.conf', 'protocol ospf v2 { area 0 { interface "eth*"; }; }\n');
    sh(net, r1, 'bird');
    sh(net, r2, 'bird');
    wait(net, 100);
    expect(sh(net, r1, 'birdc show route').length).toBeGreaterThan(4);
    expect(sh(net, r1, 'ip route').some((l) => l.includes('proto bird'))).toBe(false);
    expect(sh(net, r1, 'bird')).toEqual(['bird: I found another BIRD running.']);
    r1.fs?.write('/etc/bird.conf', 'protocol ospf { area 0 { interface "eth*" { cost 0; }; }; }');
    expect(sh(net, r1, 'birdc configure')).toEqual([
      'BIRD 2.15 ready.',
      'Reading configuration from /etc/bird.conf',
      'bird: /etc/bird.conf: Cost must be in range 1-65535',
    ]);
    expect(sh(net, r1, 'bird -c /etc/missing.conf')).toEqual([
      'bird: Unable to open configuration file /etc/missing.conf: No such file or directory',
    ]);
  });

  it('keeps BIRD running across a save and load, and stops cleanly', () => {
    const { net, r1, r2, r3, pc1 } = triangle();
    for (const r of [r1, r2, r3]) sh(net, r, 'bird');
    wait(net, 100);
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    wait(copy, 100);
    const pc = copy.devices.get(pc1.id) ?? pc1;
    expect(received(sh(copy, pc, 'ping -c 1 192.168.3.10'))).toBe(true);
    for (const id of [r1.id, r2.id, r3.id]) {
      expect(sh(copy, copy.devices.get(id) ?? r1, 'birdc down')).toEqual([
        'BIRD 2.15 ready.',
        'Shutdown requested',
      ]);
    }
    expect(copy.scheduler.pending).toBe(0);
  });
});
