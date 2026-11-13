import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run, type Process } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

describe('internet cloud', () => {
  it('comes ready: DHCP, DNS and a website on every port', () => {
    const net = new Network();
    const cloud = net.addDevice('internet');
    expect(cloud.name).toBe('internet1');
    expect(cloud.dnsmasq?.config.ranges).toHaveLength(4);
    expect(cloud.httpd).not.toBeNull();
    const pc = net.addDevice('pc');
    net.connect(pc.ports[0] ?? (undefined as never), cloud.port('eth2') ?? (undefined as never));
    expect(sh(net, pc, 'dhclient eth0').at(-1)).toBe(
      'bound to 203.0.113.100 -- renewal in 21600 seconds.',
    );
    expect(sh(net, pc, 'curl www.example.com')).toContain('    <h1>Hello from the Internet</h1>');
    expect(sh(net, pc, 'traceroute -m 3 example.com')).toEqual([
      'traceroute to example.com (198.18.0.10), 3 hops max, 60 byte packets',
      ' 1  198.18.0.10 (198.18.0.10)  0.500 ms  0.500 ms  0.500 ms',
    ]);
  });

  it('survives a save and load without running its setup again', () => {
    const net = new Network();
    net.addDevice('internet');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    const cloud = [...copy.devices.values()][0];
    expect(cloud?.ip?.allAddrs()).toHaveLength(5);
    expect(cloud?.dnsmasq).not.toBeNull();
  });
});

describe('tcpdump', () => {
  it('prints the frames a device sees until it is stopped', () => {
    const net = new Network();
    const a = net.addDevice('pc');
    const b = net.addDevice('pc');
    net.connect(a, b);
    sh(net, a, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(net, b, 'ip addr add 10.0.0.2/24 dev eth0');
    const lines: string[] = [];
    let exited = false;
    const dump = run(net, b, 'tcpdump -i eth0 -n', {
      out: (l) => lines.push(l),
      exit: () => (exited = true),
    }) as Process;
    sh(net, a, 'ping -c 1 10.0.0.2');
    dump.interrupt();
    expect(exited).toBe(true);
    expect(lines).toEqual([
      'tcpdump: verbose output suppressed, use -v[v]... for full protocol decode',
      'listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes',
      '00:00:00.000250 ARP, Request who-has 10.0.0.2 tell 10.0.0.1',
      '00:00:00.000500 ARP, Reply 10.0.0.2 is-at 02:00:00:00:00:02',
      '00:00:00.000750 IP 10.0.0.1 > 10.0.0.2: ICMP echo request, id 1, seq 1, ttl 64',
      '00:00:00.001000 IP 10.0.0.2 > 10.0.0.1: ICMP echo reply, id 1, seq 1, ttl 64',
      '',
      '4 packets captured',
      '4 packets received by filter',
      '0 packets dropped by kernel',
    ]);
  });

  it('stops after -c packets and rejects unknown interfaces', () => {
    const net = new Network();
    const a = net.addDevice('pc');
    const b = net.addDevice('pc');
    net.connect(a, b);
    sh(net, a, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(net, b, 'ip addr add 10.0.0.2/24 dev eth0');
    const lines: string[] = [];
    run(net, b, 'tcpdump -c 1', { out: (l) => lines.push(l), exit: () => {} });
    sh(net, a, 'ping -c 1 10.0.0.2');
    expect(lines.filter((l) => l.startsWith('00:'))).toHaveLength(1);
    expect(lines).toContain('1 packet captured');
    expect(sh(net, b, 'tcpdump -i eth9')).toEqual(['tcpdump: eth9: No such device exists']);
  });
});
