import { describe, expect, it } from 'vitest';
import { formatCidr, formatIp } from './addr.ts';
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

function port(device: Device, name: string) {
  const p = device.port(name);
  if (!p) throw new Error(`no ${name}`);
  return p;
}

/** r1 serves 192.168.1.0/24 on eth1 (through sw1) and routes to 10.0.0.0/24 on eth0. */
function lab(range = '192.168.1.100,192.168.1.110,12h') {
  const net = new Network();
  const r1 = net.addDevice('router');
  const sw = net.addDevice('switch');
  const pc1 = net.addDevice('pc');
  const pc2 = net.addDevice('pc');
  const server = net.addDevice('pc', 'server');
  net.connect(port(r1, 'eth1'), port(sw, 'eth0'));
  net.connect(pc1, sw);
  net.connect(pc2, sw);
  net.connect(port(server, 'eth0'), port(r1, 'eth0'));
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth1');
  sh(net, r1, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, server, 'ip addr add 10.0.0.10/24 dev eth0');
  sh(net, server, 'ip route add default via 10.0.0.1');
  const banner = sh(net, r1, `dnsmasq --dhcp-range=${range}`);
  return { net, r1, sw, pc1, pc2, server, banner };
}

describe('DHCP', () => {
  it('starts dnsmasq with its log lines', () => {
    expect(lab().banner).toEqual([
      'dnsmasq: started, version 2.90 cachesize 150',
      'dnsmasq-dhcp: DHCP, IP range 192.168.1.100 -- 192.168.1.110, lease time 43200s',
    ]);
  });

  it('configures address, gateway and name server with DISCOVER/OFFER/REQUEST/ACK', () => {
    const { net, pc1 } = lab();
    expect(sh(net, pc1, 'dhclient eth0')).toEqual([
      'DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 3',
      'DHCPOFFER of 192.168.1.100 from 192.168.1.1',
      'DHCPREQUEST for 192.168.1.100 on eth0 to 255.255.255.255 port 67',
      'DHCPACK of 192.168.1.100 from 192.168.1.1',
      'bound to 192.168.1.100 -- renewal in 21600 seconds.',
    ]);
    expect(pc1.ip?.allAddrs().map(formatCidr)).toEqual(['192.168.1.100/24']);
    expect(sh(net, pc1, 'ip route')[0]).toBe('default via 192.168.1.1 dev eth0');
    expect(pc1.ip?.dns.map(formatIp)).toEqual(['192.168.1.1']);
    // The new settings work across the router.
    expect(sh(net, pc1, 'ping -c 1 10.0.0.10')).toContain(
      '1 packets transmitted, 1 received, 0% packet loss, time 3ms',
    );
    const kinds = net.trace.flatMap((t) => {
      const p = t.frame.payload;
      return p.kind === 'ipv4' && p.payload.kind === 'udp' && p.payload.data.app === 'dhcp'
        ? [p.payload.data.op]
        : [];
    });
    // Broadcasts cross the switch to every port, so each message is seen more than once.
    expect([...new Set(kinds)]).toEqual(['discover', 'offer', 'request', 'ack']);
  });

  it('gives each client its own address and remembers their names', () => {
    const { net, r1, pc1, pc2 } = lab();
    sh(net, pc1, 'dhclient eth0');
    sh(net, pc2, 'dhclient eth0');
    expect(pc2.ip?.allAddrs().map(formatCidr)).toEqual(['192.168.1.101/24']);
    const leases = r1.dnsmasq?.activeLeases().map((l) => [l.hostname, formatIp(l.ip)]);
    expect(leases).toEqual([
      ['pc1', '192.168.1.100'],
      ['pc2', '192.168.1.101'],
    ]);
    // Asking again keeps the same address and doesn't stack a second one.
    sh(net, pc1, 'dhclient eth0');
    expect(pc1.ip?.allAddrs().map(formatCidr)).toEqual(['192.168.1.100/24']);
  });

  it('releases a lease with dhclient -r', () => {
    const { net, r1, pc1 } = lab();
    sh(net, pc1, 'dhclient eth0');
    expect(sh(net, pc1, 'dhclient -r eth0')).toEqual([
      'DHCPRELEASE of 192.168.1.100 on eth0 to 192.168.1.1 port 67',
    ]);
    expect(pc1.ip?.allAddrs()).toEqual([]);
    expect(sh(net, pc1, 'ip route')).toEqual([]);
    // The release travels to the server (after an ARP lookup for it).
    net.scheduler.runUntil(net.scheduler.now + 100);
    expect(r1.dnsmasq?.activeLeases()).toEqual([]);
  });

  it('gives up when nobody answers', () => {
    const { net, r1, pc1 } = lab();
    expect(sh(net, r1, 'killall dnsmasq')).toEqual([]);
    expect(sh(net, r1, 'killall dnsmasq')).toEqual(['dnsmasq: no process found']);
    const out = sh(net, pc1, 'dhclient eth0');
    expect(out.filter((l) => l.startsWith('DHCPDISCOVER'))).toHaveLength(4);
    expect(out.at(-1)).toBe('No DHCPOFFERS received.');
    expect(net.scheduler.now).toBeGreaterThanOrEqual(12_000);
  });

  it('only serves the subnet of the interface a request arrives on', () => {
    const { net, server } = lab();
    sh(net, server, 'ip addr flush dev eth0');
    // r1 has no range for 10.0.0.0/24, and DHCP broadcasts are never forwarded.
    expect(sh(net, server, 'dhclient eth0').at(-1)).toBe('No DHCPOFFERS received.');
  });

  it('runs out of addresses', () => {
    const { net, pc1, pc2 } = lab('192.168.1.100,192.168.1.100');
    expect(sh(net, pc1, 'dhclient eth0').at(-1)).toContain('bound to 192.168.1.100');
    expect(sh(net, pc2, 'dhclient eth0').at(-1)).toBe('No DHCPOFFERS received.');
  });

  it('checks dnsmasq options', () => {
    const { net, r1 } = lab();
    expect(sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.10,192.168.1.20')).toEqual([
      'dnsmasq: failed to create listening socket for port 53: Address already in use',
    ]);
    sh(net, r1, 'killall dnsmasq');
    expect(sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.20,192.168.1.10')).toEqual([
      'dnsmasq: bad dhcp-range at line 1 of command line',
    ]);
    expect(sh(net, r1, 'dnsmasq --dhcp-optoin=3,1.1.1.1')).toEqual([
      'dnsmasq: bad command line options: try --help',
    ]);
  });

  it('keeps dnsmasq running across a save and load', () => {
    const { net, r1 } = lab();
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.devices.get(r1.id)?.dnsmasq?.args).toEqual([
      '--dhcp-range=192.168.1.100,192.168.1.110,12h',
    ]);
    const pc = copy.devices.get('d3');
    if (!pc) throw new Error('missing pc1');
    expect(sh(copy, pc, 'dhclient eth0').at(-1)).toContain('bound to 192.168.1.100');
  });
});
