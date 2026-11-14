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

function port(device: Device, name: string) {
  const p = device.port(name);
  if (!p) throw new Error(`no ${name}`);
  return p;
}

/** r1 runs dnsmasq for 192.168.1.0/24 and knows web.lab; server sits on 10.0.0.0/24. */
function lab() {
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
  expect(
    sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.150 --address=/web.lab/10.0.0.10'),
  ).toContain('dnsmasq: serving web.lab as 10.0.0.10');
  sh(net, pc1, 'dhclient eth0');
  sh(net, pc2, 'dhclient eth0');
  return { net, r1, pc1, pc2, server };
}

describe('DNS', () => {
  it('answers dig from host records, like dig prints it', () => {
    const { net, pc1 } = lab();
    expect(sh(net, pc1, 'dig web.lab')).toEqual([
      '; <<>> DiG 9.18 <<>> web.lab',
      ';; Got answer:',
      ';; ->>HEADER<<- opcode: QUERY, status: NOERROR',
      '',
      ';; QUESTION SECTION:',
      ';web.lab.\t\t\tIN\tA',
      '',
      ';; ANSWER SECTION:',
      'web.lab.\t\t0\tIN\tA\t10.0.0.10',
      '',
      ';; Query time: 2 msec',
      ';; SERVER: 192.168.1.1#53(192.168.1.1) (UDP)',
    ]);
    expect(sh(net, pc1, 'dig +short WEB.lab')).toEqual(['10.0.0.10']);
  });

  it('knows DHCP clients by their hostnames and says NXDOMAIN otherwise', () => {
    const { net, pc1 } = lab();
    expect(sh(net, pc1, 'dig +short pc2')).toEqual(['192.168.1.101']);
    const missing = sh(net, pc1, 'dig nope.lab');
    expect(missing).toContain(';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN');
    expect(missing).not.toContain(';; ANSWER SECTION:');
  });

  it('lets ping and traceroute use names', () => {
    const { net, pc1 } = lab();
    const out = sh(net, pc1, 'ping -c 1 web.lab');
    expect(out[0]).toBe('PING web.lab (10.0.0.10) 56(84) bytes of data.');
    expect(out).toContain('--- web.lab ping statistics ---');
    expect(sh(net, pc1, 'traceroute web.lab')[0]).toBe(
      'traceroute to web.lab (10.0.0.10), 30 hops max, 60 byte packets',
    );
    expect(sh(net, pc1, 'ping nope.lab')).toEqual(['ping: nope.lab: Name or service not known']);
  });

  it('fails cleanly without a name server or when nobody answers', () => {
    const { net, pc1, server } = lab();
    expect(sh(net, server, 'ping web.lab')).toEqual([
      'ping: web.lab: Temporary failure in name resolution',
    ]);
    expect(sh(net, server, 'dig web.lab')).toEqual([';; no servers could be reached']);
    // 10.0.0.10 runs no DNS server: its port 53 is closed.
    expect(sh(net, pc1, 'dig @10.0.0.10 web.lab')).toEqual([
      ';; communications error to 10.0.0.10#53: connection refused',
      ';; no servers could be reached',
    ]);
    expect(net.scheduler.pending).toBe(0);
  });

  it('sets name servers with resolvectl', () => {
    const { net, pc1, server } = lab();
    expect(sh(net, pc1, 'resolvectl status')).toEqual(['Global', '  DNS Servers: 192.168.1.1']);
    expect(sh(net, server, 'resolvectl dns eth0 10.0.0.1')).toEqual([]);
    expect(sh(net, server, 'resolvectl dns')).toEqual(['Global: 10.0.0.1']);
    expect(sh(net, server, 'dig +short web.lab')).toEqual(['10.0.0.10']);
    expect(sh(net, server, 'resolvectl query pc1')).toEqual([
      'pc1: 192.168.1.100',
      '',
      '-- Information acquired via protocol DNS in 0.5ms.',
    ]);
    expect(sh(net, server, 'resolvectl dns eth0 not-an-ip')).toEqual([
      'Failed to parse DNS server address: not-an-ip',
    ]);
    expect(sh(net, server, 'resolvectl revert eth0')).toEqual([]);
    expect(server.ip?.dns).toEqual([]);
  });
});

/** r1 serves 192.168.1.0/24 and forwards other names to the Internet's DNS server. */
function company(server = '--server=192.0.2.1') {
  const net = new Network();
  const r1 = net.addDevice('router');
  const internet = net.addDevice('internet');
  const pc1 = net.addDevice('pc');
  net.connect(port(r1, 'eth0'), port(internet, 'eth0'));
  net.connect(port(pc1, 'eth0'), port(r1, 'eth1'));
  sh(net, r1, 'dhclient eth0');
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth1');
  sh(net, r1, 'nft add table ip nat');
  sh(net, r1, 'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }');
  sh(net, r1, 'nft add rule ip nat postrouting oifname "eth0" masquerade');
  const banner = sh(
    net,
    r1,
    `dnsmasq --dhcp-range=192.168.1.100,192.168.1.150 --address=/web.lab/10.0.0.10 ${server} --no-resolv`,
  );
  sh(net, pc1, 'dhclient eth0');
  return { net, r1, pc1, banner };
}

describe('dnsmasq upstream servers', () => {
  it('lists the upstream server in its startup lines', () => {
    const { banner } = company();
    expect(banner).toEqual([
      'dnsmasq: started, version 2.90 cachesize 150',
      'dnsmasq-dhcp: DHCP, IP range 192.168.1.100 -- 192.168.1.150, lease time 3600s',
      'dnsmasq: using nameserver 192.0.2.1#53',
      'dnsmasq: serving web.lab as 10.0.0.10',
    ]);
  });

  it('forwards names it does not know and relays the answer', () => {
    const { net, pc1 } = company();
    expect(sh(net, pc1, 'dig +short www.example.com')).toEqual(['198.18.0.10']);
    expect(sh(net, pc1, 'ping -c 1 www.example.com').join('\n')).toContain('1 received');
    // Its own records are still answered locally.
    expect(sh(net, pc1, 'dig +short web.lab')).toEqual(['10.0.0.10']);
    expect(net.scheduler.pending).toBe(0);
  });

  it('passes NXDOMAIN through', () => {
    const { net, pc1 } = company();
    const out = sh(net, pc1, 'dig nothing.example.org');
    expect(out).toContain(';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN');
    expect(out).toContain(';; SERVER: 192.168.1.1#53(192.168.1.1) (UDP)');
  });

  it('stays silent when no upstream answers, so the client times out', () => {
    // 192.0.2.77 is on the Internet's network but nothing listens there; 10.9.9.9 has no route.
    const { net, pc1 } = company('--server=10.9.9.9 --server=192.0.2.77');
    expect(sh(net, pc1, 'dig www.example.com')).toEqual([
      ';; communications error to 192.168.1.1#53: timed out',
      ';; no servers could be reached',
    ]);
    expect(net.scheduler.pending).toBe(0);
  });

  it('asks the next server when the first does not answer', () => {
    const { net, pc1 } = company('--server=192.0.2.77 --server=192.0.2.1');
    expect(sh(net, pc1, 'dig +short www.example.com')).toEqual(['198.18.0.10']);
  });

  it('cancels waiting queries when it is stopped', () => {
    const { net, r1, pc1 } = company('--server=192.0.2.77');
    sh(net, pc1, 'dig www.example.com', 300);
    sh(net, r1, 'killall dnsmasq');
    net.scheduler.runUntil(net.scheduler.now + 6000);
    expect(net.scheduler.pending).toBe(0);
  });

  it('ignores an upstream that is the machine itself, and rejects bad addresses', () => {
    const { net, r1 } = company();
    sh(net, r1, 'killall dnsmasq');
    expect(sh(net, r1, 'dnsmasq --server=192.168.1.1')).toContain(
      'dnsmasq: ignoring nameserver 192.168.1.1 - local interface',
    );
    sh(net, r1, 'killall dnsmasq');
    expect(sh(net, r1, 'dnsmasq --server=/lab/10.0.0.1')).toEqual([
      'dnsmasq: bad server at line 1 of command line',
    ]);
  });
});
