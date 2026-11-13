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

const received = (lines: string[]) => lines.some((l) => / [1-9]\d* received/.test(l));

/**
 * A home network: pc1 and a server behind router r1, whose eth1 gets a public address from
 * the Internet cloud. The cloud has no route back to 192.168.1.0/24, so only NAT works.
 */
function home() {
  const net = new Network();
  const inet = net.addDevice('internet');
  const r1 = net.addDevice('router');
  const pc1 = net.addDevice('pc');
  const srv = net.addDevice('server');
  const sw = net.addDevice('switch');
  const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);
  net.connect(port(r1, 'eth1'), port(inet, 'eth0'));
  net.connect(port(r1, 'eth0'), port(sw, 'eth0'));
  net.connect(port(pc1, 'eth0'), port(sw, 'eth1'));
  net.connect(port(srv, 'eth0'), port(sw, 'eth2'));
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth0');
  expect(sh(net, r1, 'dhclient eth1').at(-1)).toContain('bound to 192.0.2.100');
  sh(net, pc1, 'ip addr add 192.168.1.10/24 dev eth0');
  sh(net, pc1, 'ip route add default via 192.168.1.1');
  sh(net, srv, 'ip addr add 192.168.1.20/24 dev eth0');
  sh(net, srv, 'ip route add default via 192.168.1.1');
  sh(net, srv, 'httpd');
  return { net, inet, r1, pc1, srv };
}

function masquerade(net: Network, r1: Device) {
  expect(sh(net, r1, 'nft add table ip nat')).toEqual([]);
  expect(
    sh(net, r1, 'nft add chain ip nat postrouting { type nat hook postrouting priority 100 ; }'),
  ).toEqual([]);
  expect(sh(net, r1, 'nft add rule ip nat postrouting oifname "eth1" masquerade')).toEqual([]);
}

describe('NAT', () => {
  it('lets a private network reach the Internet through masquerade', () => {
    const { net, r1, pc1 } = home();
    expect(received(sh(net, pc1, 'ping -c 1 198.18.0.10'))).toBe(false);
    masquerade(net, r1);
    expect(received(sh(net, pc1, 'ping -c 1 198.18.0.10'))).toBe(true);
    expect(sh(net, r1, 'conntrack -L')).toEqual([
      'icmp     1 29 src=192.168.1.10 dst=198.18.0.10 type=8 code=0 id=2 src=198.18.0.10 dst=192.0.2.100 type=0 code=0 id=2 mark=0 use=1',
      'conntrack v1.4.7 (conntrack-tools): 1 flow entries have been shown.',
    ]);
    expect(sh(net, pc1, 'curl -s http://198.18.0.10/').join('\n')).toContain(
      'Hello from the Internet',
    );
    // traceroute works too: ICMP errors from the cloud are matched to their connection.
    expect(sh(net, pc1, 'traceroute -m 3 198.18.0.10').slice(1)).toEqual([
      ' 1  192.168.1.1 (192.168.1.1)  1.000 ms  1.000 ms  1.000 ms',
      ' 2  198.18.0.10 (198.18.0.10)  1.500 ms  1.500 ms  1.500 ms',
    ]);
  });

  it('gives two hosts using the same source port different public ports', () => {
    const { net, r1, pc1, srv } = home();
    masquerade(net, r1);
    expect(received(sh(net, pc1, 'ping -c 1 198.18.0.10'))).toBe(true);
    // Both hosts' first ping uses ICMP id 1.
    expect(received(sh(net, srv, 'ping -c 1 198.18.0.10'))).toBe(true);
    const lines = sh(net, r1, 'conntrack -L');
    expect(lines[1]).toContain('src=192.168.1.20 dst=198.18.0.10 type=8 code=0 id=1 ');
    expect(lines[1]).toContain('dst=192.0.2.100 type=0 code=0 id=2 ');
  });

  it('forwards a public port to a server inside (DNAT)', () => {
    const { net, inet, r1 } = home();
    masquerade(net, r1);
    sh(net, r1, 'nft add chain ip nat prerouting { type nat hook prerouting priority dstnat ; }');
    sh(net, r1, 'nft add rule ip nat prerouting iifname eth1 tcp dport 80 dnat to 192.168.1.20');
    const page = sh(net, inet, 'curl -s http://192.0.2.100/').join('\n');
    expect(page).toContain('It works!');
    expect(sh(net, r1, 'nft list ruleset')).toEqual([
      'table ip nat {',
      '\tchain postrouting {',
      '\t\ttype nat hook postrouting priority srcnat; policy accept;',
      '\t\toifname "eth1" masquerade',
      '\t}',
      '',
      '\tchain prerouting {',
      '\t\ttype nat hook prerouting priority dstnat; policy accept;',
      '\t\tiifname "eth1" tcp dport 80 dnat to 192.168.1.20',
      '\t}',
      '}',
    ]);
  });
});

describe('firewall', () => {
  it('drops forwarded traffic except replies, with counters', () => {
    const { net, inet, r1, pc1 } = home();
    masquerade(net, r1);
    sh(net, r1, 'nft add table ip filter');
    sh(
      net,
      r1,
      'nft add chain ip filter forward { type filter hook forward priority 0 ; policy drop ; }',
    );
    sh(net, r1, 'nft add rule ip filter forward ct state established,related accept');
    expect(received(sh(net, pc1, 'ping -c 1 198.18.0.10'))).toBe(false);
    sh(net, r1, 'nft add rule ip filter forward iifname "eth0" oifname "eth1" counter accept');
    expect(received(sh(net, pc1, 'ping -c 2 198.18.0.10'))).toBe(true);
    expect(sh(net, r1, 'nft -a list table ip filter')).toEqual([
      'table ip filter {',
      '\tchain forward {',
      '\t\ttype filter hook forward priority filter; policy drop;',
      '\t\tct state established,related accept # handle 2',
      '\t\tiifname "eth0" oifname "eth1" counter packets 1 bytes 84 accept # handle 3',
      '\t}',
      '}',
    ]);
    // Without a port forward, nothing from outside gets in.
    sh(net, inet, 'ip route add 192.168.1.0/24 via 192.0.2.100');
    expect(received(sh(net, inet, 'ping -c 1 192.168.1.10'))).toBe(false);
    sh(net, r1, 'nft delete rule ip filter forward handle 2');
    expect(received(sh(net, pc1, 'ping -c 1 198.18.0.10'))).toBe(false);
  });

  it('rejects or drops traffic to the router itself and from it', () => {
    const { net, r1, pc1 } = home();
    sh(net, r1, 'nft add table inet filter');
    sh(net, r1, 'nft add chain inet filter input { type filter hook input priority 0 ; }');
    sh(net, r1, 'nft add rule inet filter input icmp type echo-request reject');
    expect(sh(net, pc1, 'ping -c 1 192.168.1.1')[1]).toBe(
      'From 192.168.1.1 icmp_seq=1 Destination Port Unreachable',
    );
    sh(net, r1, 'nft flush chain inet filter input');
    sh(
      net,
      r1,
      'nft add chain inet filter output { type filter hook output priority 0 ; policy drop ; }',
    );
    expect(sh(net, r1, 'ping -c 1 192.168.1.10')[1]).toBe('ping: sendmsg: Operation not permitted');
    sh(net, r1, 'nft flush ruleset');
    expect(sh(net, r1, 'nft list ruleset')).toEqual([]);
    expect(received(sh(net, r1, 'ping -c 1 192.168.1.10'))).toBe(true);
  });

  it('reports errors like nft and loads rules from a file', () => {
    const { net, r1 } = home();
    expect(sh(net, r1, 'nft add rule ip filter forward accept')).toEqual([
      'Error: Could not process rule: No such file or directory',
      'add rule ip filter forward accept',
    ]);
    sh(net, r1, 'nft add table ip filter');
    expect(
      sh(net, r1, 'nft add chain ip filter fwd { type filter hook sideways priority 0 ; }'),
    ).toEqual([
      'Error: unknown chain hook sideways',
      'add chain ip filter fwd { type filter hook sideways priority 0 ; }',
    ]);
    expect(sh(net, r1, 'nft -f /etc/nftables.conf')[0]).toBe(
      'Error: Could not process rule: No such file or directory',
    );
    sh(
      net,
      r1,
      'echo -e "flush ruleset\\ntable ip filter {\\n  chain input {\\n    type filter hook input priority 0; policy drop;\\n    tcp dport { 22, 80 } accept # web and ssh\\n  }\\n}" > /etc/nftables.conf',
    );
    expect(sh(net, r1, 'nft -f /etc/nftables.conf')).toEqual([]);
    expect(sh(net, r1, 'nft list ruleset')).toContain('\t\ttcp dport { 22, 80 } accept');
    // A bad file changes nothing.
    sh(net, r1, 'echo "table ip filter { chain input { tcp dport 99999 accept } }" > /tmp/bad');
    expect(sh(net, r1, 'nft -f /tmp/bad')).toEqual(['Error: Could not resolve service: 99999']);
    expect(sh(net, r1, 'nft list ruleset')).toHaveLength(6);
  });

  it('keeps the ruleset across a save and load', () => {
    const { net, r1 } = home();
    masquerade(net, r1);
    sh(net, r1, 'nft add table ip filter');
    sh(
      net,
      r1,
      'nft add chain ip filter input { type filter hook input priority 0 ; policy drop ; }',
    );
    sh(net, r1, 'nft add rule ip filter input ip saddr != 10.0.0.0/8 udp dport 53 counter drop');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const r2 = copy.devices.get(r1.id) ?? (undefined as never);
    expect(sh(copy, r2, 'nft list ruleset')).toEqual(sh(net, r1, 'nft list ruleset'));
  });
});
