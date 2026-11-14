import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';
import { FORWARD_DELAY_MS } from './stp.ts';

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

/** Three switches in a triangle (sw1 lowest MAC), with a PC on sw2 and one on sw3. */
function triangle() {
  const net = new Network();
  const [sw1, sw2, sw3] = [
    net.addDevice('switch'),
    net.addDevice('switch'),
    net.addDevice('switch'),
  ];
  const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
  for (const sw of [sw1, sw2, sw3]) sh(net, sw, 'ip link set br0 type bridge stp_state 1');
  net.connect(port(sw1, 'eth0'), port(sw2, 'eth0'));
  net.connect(port(sw2, 'eth1'), port(sw3, 'eth1'));
  net.connect(port(sw3, 'eth0'), port(sw1, 'eth1'));
  net.connect(port(pc1, 'eth0'), port(sw2, 'eth7'));
  net.connect(port(pc2, 'eth0'), port(sw3, 'eth7'));
  sh(net, pc1, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, pc2, 'ip addr add 10.0.0.2/24 dev eth0');
  return { net, sw1, sw2, sw3, pc1, pc2 };
}

const states = (net: Network, sw: Device) =>
  sh(net, sw, 'bridge link')
    .filter((l) => !l.includes('state disabled'))
    .map((l) => /^\d+: (\S+):.* state (\S+) /.exec(l)?.slice(1).join(' '));

describe('Spanning Tree', () => {
  it('refuses a loop until every switch runs STP', () => {
    const net = new Network();
    const [a, b] = [net.addDevice('switch'), net.addDevice('switch')];
    net.connect(port(a, 'eth0'), port(b, 'eth0'));
    expect(() => net.connect(port(a, 'eth1'), port(b, 'eth1'))).toThrow(/Spanning Tree/);
    sh(net, a, 'ip link set br0 type bridge stp_state 1');
    expect(() => net.connect(port(a, 'eth1'), port(b, 'eth1'))).toThrow(/Spanning Tree/);
    sh(net, b, 'ip link set br0 type bridge stp_state 1');
    expect(() => net.connect(port(a, 'eth1'), port(b, 'eth1'))).not.toThrow();
    expect(sh(net, a, 'ip link set br0 type bridge stp_state 0')).toEqual([
      'Error: br0 is part of a switching loop; turning STP off would flood the network.',
    ]);
  });

  it('elects a root, blocks one port and forwards after listening and learning', () => {
    const { net, sw1, sw2, sw3, pc1 } = triangle();
    expect(states(net, sw2)).toEqual(['eth0 listening', 'eth1 listening', 'eth7 listening']);
    expect(received(sh(net, pc1, 'ping -c 1 10.0.0.2', 2000))).toBe(false);
    wait(net, FORWARD_DELAY_MS);
    expect(states(net, sw2)[0]).toBe('eth0 learning');
    wait(net, FORWARD_DELAY_MS);
    // sw1 is the root; sw3 (higher MAC than sw2) blocks its port towards sw2.
    expect(states(net, sw1)).toEqual(['eth0 forwarding', 'eth1 forwarding']);
    expect(states(net, sw2)).toEqual(['eth0 forwarding', 'eth1 forwarding', 'eth7 forwarding']);
    expect(states(net, sw3)).toEqual(['eth0 forwarding', 'eth1 blocking', 'eth7 forwarding']);
    expect(sh(net, sw3, 'ip -d link show br0')[2]).toMatch(
      new RegExp(
        `stp_state 1 priority 32768 vlan_filtering 0 bridge_id 8000\\.${sw3.ports[0]?.mac} root_id 8000\\.${sw1.ports[0]?.mac} root_port 1 root_path_cost 4$`,
      ),
    );
    expect(received(sh(net, pc1, 'ping -c 2 10.0.0.2'))).toBe(true);
    expect(net.trace.some((e) => e.frame.payload.kind === 'bpdu')).toBe(true);
  });

  it('heals when a link breaks and follows a new root priority', () => {
    const { net, sw1, sw2, sw3, pc1 } = triangle();
    wait(net, 2 * FORWARD_DELAY_MS);
    const link = port(sw1, 'eth1').link ?? (undefined as never);
    net.disconnect(link);
    // sw3 now reaches the root through sw2: its blocked port must open.
    expect(states(net, sw3)).toEqual(['eth1 listening', 'eth7 forwarding']);
    wait(net, 2 * FORWARD_DELAY_MS);
    expect(states(net, sw3)).toEqual(['eth1 forwarding', 'eth7 forwarding']);
    expect(received(sh(net, pc1, 'ping -c 1 10.0.0.2'))).toBe(true);
    net.connect(port(sw3, 'eth0'), port(sw1, 'eth1'));
    sh(net, sw3, 'ip link set br0 type bridge priority 4096');
    wait(net, 2 * FORWARD_DELAY_MS);
    expect(sh(net, sw1, 'ip -d link show br0')[2]).toContain(`root_id 1000.${sw3.ports[0]?.mac}`);
    // sw2 is now farthest from the root: one of its ports blocks.
    expect(states(net, sw2)).toEqual(['eth0 blocking', 'eth1 forwarding', 'eth7 forwarding']);
    expect(received(sh(net, pc1, 'ping -c 1 10.0.0.2'))).toBe(true);
    expect(sh(net, sw2, 'ip link set br0 type bridge priority x')[0]).toMatch(/^Usage/);
  });

  it('opens the blocked port when the designated side loses its way to the root', () => {
    const { net, sw1, sw2, sw3, pc1 } = triangle();
    wait(net, 2 * FORWARD_DELAY_MS);
    expect(states(net, sw3)).toContain('eth1 blocking');
    // sw2 was designated on the sw2-sw3 cable. Cut its own root link: sw3 must take over.
    const link = [...net.links.values()].find(
      (l) => [l.a.device, l.b.device].includes(sw1) && [l.a.device, l.b.device].includes(sw2),
    );
    net.disconnect(link ?? (undefined as never));
    wait(net, 2 * FORWARD_DELAY_MS + 100);
    expect(states(net, sw3)).toEqual(['eth0 forwarding', 'eth1 forwarding', 'eth7 forwarding']);
    expect(states(net, sw2)).toEqual(['eth1 forwarding', 'eth7 forwarding']);
    expect(received(sh(net, pc1, 'ping -c 1 10.0.0.2'))).toBe(true);
  });

  it('keeps STP across a save and load, already converged', () => {
    const { net, sw3, pc1 } = triangle();
    sh(net, sw3, 'ip link set br0 type bridge priority 4096');
    wait(net, 2 * FORWARD_DELAY_MS);
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const sw3copy = copy.devices.get(sw3.id) ?? (undefined as never);
    expect(sh(copy, sw3copy, 'ip -d link show br0')[2]).toContain('stp_state 1 priority 4096');
    for (const id of ['d1', 'd2', 'd3']) {
      const before = states(net, net.devices.get(id) ?? sw3);
      expect(states(copy, copy.devices.get(id) ?? sw3)).toEqual(before);
    }
    const pc = copy.devices.get(pc1.id) ?? pc1;
    expect(received(sh(copy, pc, 'ping -c 1 10.0.0.2'))).toBe(true);
    expect(copy.trace.filter((e) => e.frame.payload.kind === 'bpdu').length).toBe(0);
  });
});

describe('Spanning Tree forward delay', () => {
  it('shows the delay in centiseconds and validates it like the kernel', () => {
    const net = new Network();
    const sw = net.addDevice('switch');
    expect(sh(net, sw, 'ip -d link show br0')[2]).toContain('bridge forward_delay 1500 ');
    // Anything goes while STP is off; with STP on the kernel allows 2 s to 30 s.
    expect(sh(net, sw, 'ip link set br0 type bridge forward_delay 100')).toEqual([]);
    expect(sh(net, sw, 'ip link set br0 type bridge stp_state 1 forward_delay 100')).toEqual([
      'RTNETLINK answers: Numerical result out of range',
    ]);
    expect(sh(net, sw, 'ip link set br0 type bridge stp_state 1 forward_delay 200')).toEqual([]);
    expect(sh(net, sw, 'ip link set br0 type bridge forward_delay 3001')).toEqual([
      'RTNETLINK answers: Numerical result out of range',
    ]);
    expect(sh(net, sw, 'ip link set br0 type bridge forward_delay abc')).toEqual([
      'Error: argument "abc" is wrong: invalid forward_delay',
    ]);
    expect(sh(net, sw, 'ip -d link show br0')[2]).toContain('bridge forward_delay 200 ');
  });

  it('listens and learns for the configured time, then forwards', () => {
    const net = new Network();
    const [sw1, sw2] = [net.addDevice('switch'), net.addDevice('switch')];
    const pc = net.addDevice('pc');
    for (const sw of [sw1, sw2]) {
      sh(net, sw, 'ip link set br0 type bridge stp_state 1 forward_delay 200');
    }
    net.connect(port(sw1, 'eth0'), port(sw2, 'eth0'));
    net.connect(port(pc, 'eth0'), port(sw2, 'eth1'));
    wait(net, 1900);
    expect(states(net, sw1)).toEqual(['eth0 listening']);
    wait(net, 200);
    expect(states(net, sw1)).toEqual(['eth0 learning']);
    wait(net, 2000);
    expect(states(net, sw1)).toEqual(['eth0 forwarding']);
    expect(states(net, sw2)).toEqual(['eth0 forwarding', 'eth1 forwarding']);
    expect(net.scheduler.pending).toBe(0);
  });
});
