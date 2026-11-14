import { describe, expect, it } from 'vitest';
import { DROP_LIMIT } from './drops.ts';
import { Network } from './network.ts';
import { WIFI_RANGE, checkWireless } from './wifi.ts';
import { office, port, routed, sh, sites, tunnel, wait } from './testing.ts';

/** The recorded drops with the device names that matter in these tests. */
function dropsOf(net: Network) {
  return net.drops.map((d) => ({ ...d, device: net.devices.get(d.device)?.name }));
}

const FILTER = 'nft add table ip filter';
const forwardChain = (policy: string) =>
  `nft add chain ip filter forward { type filter hook forward priority 0 ; policy ${policy} ; }`;

describe('drops: where the engine discards packets', () => {
  it('records a local send with no route', () => {
    const { net, pc1 } = office();
    expect(sh(net, pc1, 'ping -c 1 8.8.8.8')).toContain('ping: connect: Network is unreachable');
    expect(dropsOf(net)).toMatchObject([
      {
        device: 'pc1',
        reason: 'no-route',
        forwarded: false,
        packet: { proto: 'icmp', what: 'echo-request', dst: '8.8.8.8', src: '10.0.0.1' },
      },
    ]);
  });

  it('records a router that has no route to forward to', () => {
    const { net, pc1 } = routed();
    sh(net, pc1, 'ping -c 1 10.9.9.9');
    expect(dropsOf(net)).toMatchObject([
      { device: 'r1', port: null, reason: 'no-route', forwarded: true },
    ]);
    expect(net.drops[0]?.packet?.dst).toBe('10.9.9.9');
  });

  it('records a host that gets a packet for someone else when it does not forward', () => {
    const { net, pc1, pc2 } = office();
    sh(net, pc1, 'ip route add default via 10.0.0.2');
    sh(net, pc1, 'ping -c 1 8.8.8.8');
    expect(dropsOf(net).filter((d) => d.reason === 'forwarding-off')).toMatchObject([
      { device: pc2.name, port: 'eth0', packet: { dst: '8.8.8.8' } },
    ]);
  });

  it('records a TTL that ran out on the ingress interface', () => {
    const { net, pc1 } = routed();
    sh(net, pc1, 'ping -c 1 -t 1 192.168.2.20');
    expect(dropsOf(net)).toMatchObject([{ device: 'r1', port: 'eth0', reason: 'ttl-expired' }]);
  });

  it('records ARP that nobody answered', () => {
    const { net, pc1 } = office();
    sh(net, pc1, 'ping -c 1 10.0.0.50');
    expect(dropsOf(net)).toMatchObject([
      {
        device: 'pc1',
        port: 'eth0',
        reason: 'arp-failed',
        nextHop: '10.0.0.50',
        packet: { dst: '10.0.0.50' },
      },
    ]);
  });

  it('records an interface that is down, and a missing cable', () => {
    const { net, sw, pc1 } = office();
    sh(net, pc1, 'ip link set eth0 down');
    sh(net, pc1, 'ping -c 1 10.0.0.2');
    const lone = net.addDevice('pc', 'lone');
    sh(net, lone, 'ip addr add 10.0.0.9/24 dev eth0');
    sh(net, lone, 'ping -c 1 10.0.0.2');
    expect(dropsOf(net)).toMatchObject([
      { device: 'pc1', port: 'eth0', reason: 'link-down', cause: 'admin-down' },
      { device: 'lone', port: 'eth0', reason: 'link-down', cause: 'no-cable' },
    ]);
    net.drops = [];
    sh(net, pc1, 'ip link set eth0 up');
    net.setPortUp(port(sw, 'eth1'), false);
    sh(net, pc1, 'ping -c 1 10.0.0.2');
    // pc1 itself is fine; the other end is off, so ARP fails instead.
    expect(dropsOf(net)[0]).toMatchObject({ device: 'pc1', reason: 'arp-failed' });
  });

  it('records the firewall chain and the rule or policy that decided', () => {
    const { net, r1, pc1 } = routed();
    sh(net, r1, FILTER);
    sh(net, r1, forwardChain('drop'));
    sh(net, pc1, 'ping -c 1 192.168.2.20');
    expect(dropsOf(net)).toMatchObject([
      {
        device: 'r1',
        port: 'eth0',
        reason: 'netfilter',
        verdict: 'drop',
        hook: 'forward',
        family: 'ip',
        table: 'filter',
        chain: 'forward',
        rule: null,
      },
    ]);
    net.drops = [];
    sh(net, r1, 'nft add rule ip filter forward ip daddr 192.168.2.20 reject');
    sh(net, pc1, 'ping -c 1 192.168.2.20');
    expect(dropsOf(net)).toMatchObject([{ verdict: 'reject', rule: 1 }]);
  });

  it('records an output rule on the sending host', () => {
    const { net, pc1 } = office();
    sh(net, pc1, FILTER);
    sh(
      net,
      pc1,
      'nft add chain ip filter output { type filter hook output priority 0 ; policy drop ; }',
    );
    expect(sh(net, pc1, 'ping -c 1 10.0.0.2')).toContain('ping: sendmsg: Operation not permitted');
    expect(dropsOf(net)).toMatchObject([
      { device: 'pc1', reason: 'netfilter', hook: 'output', chain: 'output', rule: null },
    ]);
  });

  it('records TCP and UDP packets for a port nobody listens on', () => {
    const { net, pc1, srv } = routed();
    sh(net, pc1, 'curl http://192.168.2.20/');
    sh(net, pc1, 'resolvectl dns eth0 192.168.2.20');
    sh(net, pc1, 'dig web.lab');
    expect(dropsOf(net).filter((d) => d.reason === 'no-listener')).toMatchObject([
      { device: srv.name, packet: { proto: 'tcp', dstPort: 80, what: 'SYN' } },
      { device: srv.name, packet: { proto: 'udp', dstPort: 53 } },
    ]);
  });

  it('records frames a bridge drops for VLAN reasons', () => {
    const { net, sw, pc1 } = office();
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    sh(net, sw, 'bridge vlan del dev eth0 vid 1');
    sh(net, pc1, 'ping -c 1 10.0.0.2');
    // ARP is tried three times, then the ping gives up.
    expect(dropsOf(net).map((d) => d.reason)).toEqual([
      'vlan-ingress',
      'vlan-ingress',
      'vlan-ingress',
      'arp-failed',
    ]);
    expect(dropsOf(net).slice(0, 1)).toMatchObject([
      {
        device: 'sw1',
        port: 'eth0',
        reason: 'vlan-ingress',
        vid: null,
        pvid: null,
        vids: [],
        packet: { proto: 'arp' },
      },
    ]);
    net.drops = [];
    sh(net, sw, 'bridge vlan add dev eth0 vid 10 pvid untagged');
    sh(net, sw, 'bridge vlan add dev eth1 vid 20 pvid untagged');
    sh(net, sw, 'bridge vlan del dev eth1 vid 1');
    sh(net, pc1, 'ping -c 1 10.0.0.2');
    expect(dropsOf(net).slice(0, 1)).toMatchObject([
      {
        device: 'sw1',
        port: 'eth0',
        reason: 'vlan-egress',
        vid: 10,
        others: [{ port: 'eth1', vids: [20] }],
      },
    ]);
  });

  it('records frames on a Spanning Tree port that is not forwarding yet', () => {
    const net = new Network();
    const sw = net.addDevice('switch');
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    sh(net, sw, 'ip link set br0 type bridge stp_state 1');
    net.connect(port(pc1, 'eth0'), port(sw, 'eth0'));
    net.connect(port(pc2, 'eth0'), port(sw, 'eth1'));
    sh(net, pc1, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(net, pc2, 'ip addr add 10.0.0.2/24 dev eth0');
    net.drops = [];
    wait(net, 1);
    sh(net, pc1, 'ping -c 1 10.0.0.2', 1000);
    const stp = dropsOf(net).filter((d) => d.reason === 'stp-not-forwarding');
    expect(stp[0]).toMatchObject({ device: 'sw1', port: 'eth0', role: 'designated' });
    expect(['blocking', 'listening']).toContain((stp[0] as { state: string }).state);
  });

  it('records WireGuard drops: no peer, no endpoint, and allowed IPs', () => {
    const { net, rA, rB, pcA } = sites();
    sh(net, rA, 'ip link add wg0 type wireguard');
    sh(net, rA, 'ip addr add 10.8.0.1/24 dev wg0');
    sh(net, rA, 'ip link set wg0 up');
    sh(net, rA, 'ping -c 1 10.8.0.2');
    expect(dropsOf(net)).toMatchObject([{ device: 'r1', port: 'wg0', reason: 'wg-no-peer' }]);
    net.drops = [];
    tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    sh(net, rB, 'wg-quick up wg0');
    sh(net, rA, 'ip link del wg0');
    sh(net, rA, 'wg-quick up wg0');
    sh(
      net,
      rB,
      'wg set wg0 peer ' +
        (rB.wireguard(rB.port('wg0'))?.peers[0]?.publicKey ?? '') +
        ' allowed-ips 10.8.0.1/32',
    );
    sh(net, pcA, 'ping -c 1 192.168.2.10');
    expect(dropsOf(net)).toMatchObject([
      { device: 'r2', port: 'wg0', reason: 'wg-allowed-ips', packet: { src: '192.168.1.10' } },
    ]);
  });

  it('records a WireGuard peer without an endpoint', () => {
    const { net, rA } = sites();
    sh(net, rA, 'wg genkey > /etc/wireguard/k');
    sh(net, rA, 'ip link add wg0 type wireguard');
    sh(net, rA, 'wg set wg0 private-key /etc/wireguard/k');
    const other = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    sh(net, rA, `wg set wg0 peer ${other} allowed-ips 10.8.0.2/32`);
    sh(net, rA, 'ip addr add 10.8.0.1/24 dev wg0');
    sh(net, rA, 'ip link set wg0 up');
    sh(net, rA, 'ping -c 1 10.8.0.2');
    expect(dropsOf(net)).toMatchObject([{ device: 'r1', port: 'wg0', reason: 'wg-no-endpoint' }]);
  });

  it('records a Wi-Fi client that walked out of range', () => {
    const net = new Network();
    const where = new Map<string, { x: number; y: number }>();
    net.locate = (id) => where.get(id) ?? null;
    const ap = net.addDevice('ap');
    const laptop = net.addDevice('laptop');
    where.set(ap.id, { x: 0, y: 0 });
    where.set(laptop.id, { x: 100, y: 0 });
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    where.set(laptop.id, { x: WIFI_RANGE + 50, y: 0 });
    checkWireless(net);
    expect(dropsOf(net)).toMatchObject([
      { device: 'laptop1', reason: 'wifi-out-of-range', ssid: 'NetForge', packet: null },
    ]);
  });

  it('records where a name lookup gives up', () => {
    const { net, pc1, pc2 } = office();
    // No name server at all.
    sh(net, pc1, 'ping -c 1 web.lab');
    // A server that answers NXDOMAIN, one with no DNS service, and one that never answers.
    sh(net, pc2, 'dnsmasq --address=/web.lab/10.0.0.9');
    sh(net, pc1, 'resolvectl dns eth0 10.0.0.2');
    sh(net, pc1, 'dig nope.lab');
    sh(net, pc2, 'killall dnsmasq');
    sh(net, pc1, 'dig web.lab');
    expect(dropsOf(net).filter((d) => d.reason.startsWith('dns-'))).toMatchObject([
      { device: 'pc1', reason: 'dns-no-server', name: 'web.lab', server: null },
      { device: 'pc1', reason: 'dns-nxdomain', name: 'nope.lab', server: '10.0.0.2' },
      { device: 'pc1', reason: 'dns-refused', name: 'web.lab', server: '10.0.0.2' },
    ]);
    const { net: n2, r1, pc1: p1 } = routed();
    sh(n2, p1, 'resolvectl dns eth0 192.168.2.20');
    sh(n2, r1, FILTER);
    sh(n2, r1, forwardChain('drop'));
    sh(n2, p1, 'dig web.lab');
    expect(dropsOf(n2).map((d) => d.reason)).toEqual(['netfilter', 'dns-timeout']);
    expect(n2.drops[1]).toMatchObject({ name: 'web.lab', server: '192.168.2.20' });
  });

  it('keeps a bounded buffer and clears it with the trace', () => {
    const { net, pc1 } = office();
    for (let i = 0; i < DROP_LIMIT + 50; i++) net.drop(pc1, null, { reason: 'ttl-expired' }, null);
    expect(net.drops).toHaveLength(DROP_LIMIT);
    expect(net.drops[0]?.seq).toBe(51);
    net.clearTrace();
    expect(net.drops).toEqual([]);
  });

  it('records nothing when everything works', () => {
    const { net, pc1 } = routed();
    expect(sh(net, pc1, 'ping -c 1 192.168.2.20').join('\n')).toContain('1 received');
    expect(net.drops).toEqual([]);
  });

  it('keeps no drops in saved labs', () => {
    const { net, pc1 } = office();
    sh(net, pc1, 'ping -c 1 8.8.8.8');
    expect(net.drops.length).toBeGreaterThan(0);
    expect(Network.fromJSON(net.toJSON()).drops).toEqual([]);
  });
});
