import { describe, expect, it } from 'vitest';
import type { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import { SCENARIOS } from './scenarios.ts';

/** Runs a command on the device called `name` and returns its output. */
function sh(net: Network, name: string, line: string): string {
  const device = [...net.devices.values()].find((d) => d.name === name);
  if (!device) throw new Error(`no device ${name}`);
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < 30_000; t += 100) {
    net.scheduler.runUntil(net.scheduler.now + 100);
  }
  return lines.join('\n');
}

const build = (id: string) => {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  return scenario.build();
};

describe('ready-made scenarios', () => {
  it('home: every device reaches the Internet through the home router', () => {
    const { net, layout } = build('home');
    expect(net.devices.size).toBe(5);
    expect(Object.keys(layout)).toHaveLength(5);
    for (const name of ['pc1', 'laptop1', 'phone1']) {
      expect(sh(net, name, 'ping -c 1 198.18.0.10')).toContain('1 received');
    }
  });

  it('office: PCs get addresses, resolve the server by name and reach the Internet', () => {
    const { net } = build('office');
    expect(net.devices.size).toBe(8);
    expect(sh(net, 'pc4', 'ip -4 addr show eth0')).toContain('inet 192.168.10.103/24');
    expect(sh(net, 'pc1', 'ping -c 1 intranet.office')).toContain('1 received');
    expect(sh(net, 'pc2', 'curl -I http://intranet.office/')).toContain('HTTP/1.1 200 OK');
    expect(sh(net, 'pc3', 'ping -c 1 198.18.0.10')).toContain('1 received');
  });

  it('company: VLANs, firewall, Wi-Fi, port forwarding and a redundant cable all work', () => {
    const { net } = build('company');
    expect(net.devices.size).toBe(17);
    // Office VLAN reaches the servers; the classroom only reaches the web page.
    expect(sh(net, 'pc1', 'ping -c 1 mail.corp')).toContain('1 received');
    expect(sh(net, 'pc3', 'ping -c 1 mail.corp')).toContain('0 received');
    expect(sh(net, 'pc3', 'curl -I http://intranet.corp/')).toContain('HTTP/1.1 200 OK');
    expect(sh(net, 'phone1', 'ping -c 1 intranet.corp')).toContain('1 received');
    // The branch sees the web server through the port forward, and nothing else.
    expect(sh(net, 'pc6', 'curl -s http://192.0.2.100/')).toContain('It works!');
    expect(sh(net, 'laptop1', 'ping -c 1 198.18.0.10')).toContain('1 received');
    // Cut the fiber between the core and the office switch: the spare cable takes over.
    const fiber = [...net.links.values()].find(
      (l) => [l.a.device.name, l.b.device.name].sort().join() === 'sw1,sw2',
    );
    net.disconnect(fiber ?? (undefined as never));
    net.scheduler.runUntil(net.scheduler.now + 31_000);
    expect(sh(net, 'pc1', 'ping -c 1 mail.corp')).toContain('1 received');
  });
});
