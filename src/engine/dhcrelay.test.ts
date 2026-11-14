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

const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);

/**
 * The DHCP server sits on 10.0.0.0/24 behind r1; pc1 and pc2 are on 10.0.1.0/24 and
 * 10.0.2.0/24, two more r1 interfaces. The server has a range for each client network.
 */
function lab() {
  const net = new Network();
  const r1 = net.addDevice('router');
  const server = net.addDevice('server');
  const pc1 = net.addDevice('pc');
  const pc2 = net.addDevice('pc');
  net.connect(port(server, 'eth0'), port(r1, 'eth0'));
  net.connect(port(pc1, 'eth0'), port(r1, 'eth1'));
  net.connect(port(pc2, 'eth0'), port(r1, 'eth2'));
  sh(net, r1, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, r1, 'ip addr add 10.0.1.1/24 dev eth1');
  sh(net, r1, 'ip addr add 10.0.2.1/24 dev eth2');
  sh(net, server, 'ip addr add 10.0.0.10/24 dev eth0');
  sh(net, server, 'ip route add default via 10.0.0.1');
  sh(
    net,
    server,
    'dnsmasq --dhcp-range=10.0.1.100,10.0.1.110,255.255.255.0,1h --dhcp-range=10.0.2.50,10.0.2.60,255.255.255.0',
  );
  return { net, r1, server, pc1, pc2 };
}

describe('dhcrelay', () => {
  it('prints the agent banner for each interface it listens on', () => {
    const { net, r1 } = lab();
    const mac = (name: string) => port(r1, name).mac;
    expect(sh(net, r1, 'dhcrelay -i eth1 -i eth2 10.0.0.10')).toEqual([
      'Internet Systems Consortium DHCP Relay Agent 4.4.3',
      'Copyright 2004-2022 Internet Systems Consortium.',
      'All rights reserved.',
      'For info, please visit https://www.isc.org/software/dhcp/',
      `Listening on LPF/eth1/${mac('eth1')}`,
      `Sending on   LPF/eth1/${mac('eth1')}`,
      `Listening on LPF/eth2/${mac('eth2')}`,
      `Sending on   LPF/eth2/${mac('eth2')}`,
      'Sending on   Socket/fallback',
    ]);
  });

  it('gives each network a lease from the range that contains its relay address', () => {
    const { net, r1, server, pc1, pc2 } = lab();
    sh(net, r1, 'dhcrelay 10.0.0.10');
    expect(sh(net, pc1, 'dhclient eth0')).toEqual([
      'DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 3',
      'DHCPOFFER of 10.0.1.100 from 10.0.0.10',
      'DHCPREQUEST for 10.0.1.100 on eth0 to 255.255.255.255 port 67',
      'DHCPACK of 10.0.1.100 from 10.0.0.10',
      'bound to 10.0.1.100 -- renewal in 1800 seconds.',
    ]);
    expect(sh(net, pc2, 'dhclient eth0')).toContain(
      'bound to 10.0.2.50 -- renewal in 1800 seconds.',
    );
    // The relay is the gateway of each client network, the server its own DNS server.
    expect(sh(net, pc1, 'ip route')).toContain('default via 10.0.1.1 dev eth0');
    expect(sh(net, pc2, 'ip route')).toContain('default via 10.0.2.1 dev eth0');
    expect(sh(net, pc1, 'resolvectl')).toContain('  DNS Servers: 10.0.0.10');
    expect(server.dnsmasq?.activeLeases().map((l) => l.ip)).toHaveLength(2);
    expect(sh(net, pc1, 'ping -c 1 10.0.2.50').join('\n')).toContain('1 received');
  });

  it('only listens on the interfaces named with -i', () => {
    const { net, r1, pc1, pc2 } = lab();
    sh(net, r1, 'dhcrelay -i eth1 10.0.0.10');
    expect(sh(net, pc1, 'dhclient eth0')).toContain(
      'bound to 10.0.1.100 -- renewal in 1800 seconds.',
    );
    expect(sh(net, pc2, 'dhclient eth0')).toContain('No DHCPOFFERS received.');
  });

  it('stops with killall and leaves no timers behind', () => {
    const { net, r1, pc1 } = lab();
    sh(net, r1, 'dhcrelay 10.0.0.10');
    expect(sh(net, r1, 'killall dhcrelay')).toEqual([]);
    expect(sh(net, r1, 'killall dhcrelay')).toEqual(['dhcrelay: no process found']);
    expect(sh(net, pc1, 'dhclient eth0')).toContain('No DHCPOFFERS received.');
    expect(net.scheduler.pending).toBe(0);
    // Its port is free again.
    expect(sh(net, r1, 'dhcrelay 10.0.0.10')[0]).toBe(
      'Internet Systems Consortium DHCP Relay Agent 4.4.3',
    );
  });

  it('reports misuse like dhcrelay', () => {
    const { net, r1, pc1, server } = lab();
    expect(sh(net, r1, 'dhcrelay')[0]).toBe('No servers specified.');
    expect(sh(net, r1, 'dhcrelay')[1]).toMatch(/^Usage: dhcrelay /);
    expect(sh(net, r1, 'dhcrelay -x 10.0.0.10')[0]).toMatch(/^Usage: dhcrelay /);
    expect(sh(net, r1, 'dhcrelay -i')[0]).toMatch(/^Usage: dhcrelay /);
    expect(sh(net, r1, 'dhcrelay -i eth9 10.0.0.10')).toEqual([
      'dhcrelay: eth9: interface not found',
    ]);
    expect(sh(net, r1, 'dhcrelay web.lab')).toEqual([
      'dhcrelay: Cannot resolve server name "web.lab"',
    ]);
    // Routers only.
    expect(sh(net, pc1, 'dhcrelay 10.0.0.10')).toEqual(['dhcrelay: command not found']);
    // Port 67 is taken by a running relay (or by dnsmasq).
    sh(net, r1, 'dhcrelay 10.0.0.10');
    expect(sh(net, r1, 'dhcrelay 10.0.0.10')[0]).toBe(
      "Can't bind to dhcp address: Address already in use",
    );
    expect(sh(net, server, 'dhcrelay 10.0.0.1')).toEqual(['dhcrelay: command not found']);
  });
});
