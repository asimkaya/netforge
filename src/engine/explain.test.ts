import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { commandFailed, explainFailure, type Explanation } from './explain.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';
import { office, port, routed, sh, sites, tunnel } from './testing.ts';
import { WIFI_RANGE, checkWireless } from './wifi.ts';

/** Runs a command like the terminal does and explains what happened. */
function why(net: Network, device: Device, line: string): Explanation | null {
  const output: string[] = [];
  const after = net.dropSeq;
  let done = false;
  const proc = run(net, device, line, { out: (l) => output.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < 60_000; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return explainFailure(net, device, { line, output, after, until: net.dropSeq });
}

const FILTER = 'nft add table ip filter';
const forwardChain = (policy: string) =>
  `nft add chain ip filter forward { type filter hook forward priority 0 ; policy ${policy} ; }`;

describe('commandFailed', () => {
  it('reads failures from what each command printed', () => {
    const { net, pc1 } = routed();
    const failed = (line: string) => {
      const lines = sh(net, pc1, line);
      return commandFailed(line, lines);
    };
    expect(failed('ping -c 1 192.168.2.20')).toBe(false);
    expect(failed('ping -c 1 10.9.9.9')).toBe(true);
    expect(failed('ping -c 1 nope.invalid')).toBe(true);
    expect(failed('traceroute 192.168.2.20')).toBe(false);
    expect(failed('curl http://192.168.2.20/')).toBe(true);
    expect(failed('nc -z 192.168.2.20 80')).toBe(true);
    expect(failed('ssh 192.168.2.20')).toBe(true);
    expect(failed('echo hello')).toBe(false);
  });
});

describe('explainFailure', () => {
  it('says a PC without a default gateway does not know where to send', () => {
    const { net, pc1 } = routed();
    sh(net, pc1, 'ip route del default');
    expect(why(net, pc1, 'ping -c 1 8.8.8.8')).toEqual({
      kind: 'dropped',
      text: 'pc1 has no default gateway, so it does not know where to send packets for 8.8.8.8.',
      fix: 'ip route add default via 192.168.1.1',
      deviceId: pc1.id,
    });
  });

  it('says a PC without an address cannot send anything', () => {
    const { net, pc2 } = office();
    sh(net, pc2, 'ip addr flush dev eth0');
    expect(why(net, pc2, 'ping -c 1 10.0.0.1')).toMatchObject({
      kind: 'dropped',
      text: 'pc2 has no IP address, so it cannot send anything. Get one from a DHCP server, or set one by hand with ip addr add.',
      fix: 'dhclient eth0',
    });
  });

  it('points at the router that has no route to forward to', () => {
    const { net, r1, pc1 } = routed();
    expect(why(net, pc1, 'ping -c 1 10.9.9.9')).toEqual({
      kind: 'dropped',
      text: 'r1 received the ping to 10.9.9.9 but has no route to 10.9.9.9, so it cannot pass it on. Add a route for that network on r1 (Config tab, Routing).',
      fix: null,
      deviceId: r1.id,
    });
  });

  it('suggests the route a router is missing when a neighbour router knows the network', () => {
    const { net, r1, pc1 } = routed();
    const r2 = net.addDevice('router');
    const lan = net.addDevice('pc');
    net.connect(port(r2, 'eth0'), port(r1, 'eth2'));
    net.connect(port(lan, 'eth0'), port(r2, 'eth1'));
    sh(net, r1, 'ip addr add 10.1.1.1/24 dev eth2');
    sh(net, r2, 'ip addr add 10.1.1.2/24 dev eth0');
    sh(net, r2, 'ip addr add 10.2.2.1/24 dev eth1');
    sh(net, lan, 'ip addr add 10.2.2.10/24 dev eth0');
    expect(why(net, pc1, 'ping -c 1 10.2.2.10')).toMatchObject({
      text: expect.stringContaining('r1 received the ping to 10.2.2.10 but has no route'),
      fix: 'ip route add 10.2.2.0/24 via 10.1.1.2',
      fixDevice: 'r1',
      deviceId: r1.id,
    });
    expect(why(net, r1, 'ping -c 1 10.2.2.10')).toMatchObject({
      fix: 'ip route add 10.2.2.0/24 via 10.1.1.2',
      deviceId: r1.id,
    });
  });

  it('explains a host that is asked to forward but is not a router', () => {
    const { net, pc1, pc2 } = office();
    sh(net, pc1, 'ip route add default via 10.0.0.2');
    expect(why(net, pc1, 'ping -c 1 8.8.8.8')).toEqual({
      kind: 'dropped',
      text: 'pc2 received the ping to 8.8.8.8 for another address, but it is a host and IP forwarding is off, so it threw the packet away. Turn forwarding on, or make the sender use a real router as its gateway.',
      fix: 'sysctl -w net.ipv4.ip_forward=1',
      fixDevice: 'pc2',
      deviceId: pc2.id,
    });
  });

  it('explains a TTL that ran out', () => {
    const { net, pc1, r1 } = routed();
    expect(why(net, pc1, 'ping -c 1 -t 1 192.168.2.20')).toEqual({
      kind: 'dropped',
      text: 'The TTL of the ping to 192.168.2.20 ran out at r1 (eth0). A packet only lives for a limited number of hops, so this usually means a routing loop between routers, or a very low ping -t.',
      fix: null,
      deviceId: r1.id,
    });
  });

  it('explains ARP that nobody answers', () => {
    const { net, pc1 } = office();
    expect(why(net, pc1, 'ping -c 1 10.0.0.50')).toMatchObject({
      text: 'pc1 could not find the MAC address of 10.0.0.50 on eth0: nobody answered ARP, and no device in the lab has that address. Check the address for typos.',
      fix: null,
    });
    expect(why(net, pc1, 'ping -c 1 10.0.0.2')).toMatchObject({ kind: 'ok' });
  });

  it('explains an interface that is off and an unplugged cable', () => {
    const { net, pc1 } = office();
    sh(net, pc1, 'ip link set eth0 down');
    expect(why(net, pc1, 'ping -c 1 10.0.0.2')).toEqual({
      kind: 'dropped',
      text: 'pc1 eth0 is turned off, so nothing can leave through it.',
      fix: 'ip link set eth0 up',
      deviceId: pc1.id,
    });
    const lone = net.addDevice('pc', 'lone');
    sh(net, lone, 'ip addr add 10.0.0.9/24 dev eth0');
    expect(why(net, lone, 'ping -c 1 10.0.0.2')).toMatchObject({
      text: 'There is no cable plugged into lone eth0, so it has no link. Connect it to the next device with a cable.',
      fix: null,
    });
  });

  it('names the firewall chain and the rule or policy that dropped it', () => {
    const { net, r1, pc1 } = routed();
    sh(net, r1, FILTER);
    sh(net, r1, forwardChain('drop'));
    expect(why(net, pc1, 'ping -c 1 192.168.2.20')).toEqual({
      kind: 'dropped',
      text: "r1's firewall dropped the ping to 192.168.2.20 (chain forward, hook forward): no rule accepted it and the policy of chain forward is drop.",
      fix: 'nft add rule ip filter forward ip protocol icmp accept',
      fixDevice: 'r1',
      deviceId: r1.id,
    });
    sh(net, r1, 'nft flush chain ip filter forward');
    sh(
      net,
      r1,
      'nft add chain ip filter forward { type filter hook forward priority 0 ; policy accept ; }',
    );
    sh(net, r1, 'nft add rule ip filter forward tcp dport 80 reject');
    const e = why(net, pc1, 'curl http://192.168.2.20/');
    expect(e).toMatchObject({
      text: expect.stringContaining(
        'r1\'s firewall rejected the connection request to 192.168.2.20 port 80 (chain forward, hook forward): rule "tcp dport 80 reject"',
      ),
      deviceId: r1.id,
    });
    expect(e?.fix).toContain('nft delete rule ip filter forward handle');
    expect(e?.fixDevice).toBe('r1');
    expect(e?.text).not.toContain('nft delete');
  });

  it('names the other device only when the fix is not for the one that ran the command', () => {
    const { net, pc1 } = routed();
    sh(net, pc1, 'ip link set eth0 down');
    expect(why(net, pc1, 'ping -c 1 192.168.2.20')?.fix).toBe('ip link set eth0 up');
    expect(why(net, pc1, 'ping -c 1 192.168.2.20')).not.toHaveProperty('fixDevice');
  });

  it('explains a service that is not running', () => {
    const { net, pc1, srv } = routed();
    expect(why(net, pc1, 'curl http://192.168.2.20/')).toEqual({
      kind: 'dropped',
      text: `${srv.name} received the connection request but nothing is listening on TCP port 80: its web server is not running, so it refused it.`,
      fix: 'httpd',
      fixDevice: srv.name,
      deviceId: srv.id,
    });
    expect(why(net, pc1, 'nc -z 192.168.2.20 22')?.text).toContain('its SSH server is not running');
    sh(net, srv, 'httpd');
    expect(why(net, pc1, 'curl http://192.168.2.20/')).toMatchObject({ kind: 'ok' });
  });

  it('explains frames lost to VLANs, on the switch where it happens', () => {
    const { net, sw, pc1 } = office();
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    sh(net, sw, 'bridge vlan add dev eth0 vid 10 pvid untagged');
    sh(net, sw, 'bridge vlan del dev eth0 vid 1');
    sh(net, sw, 'bridge vlan add dev eth1 vid 20 pvid untagged');
    sh(net, sw, 'bridge vlan del dev eth1 vid 1');
    expect(why(net, pc1, 'ping -c 1 10.0.0.2')).toEqual({
      kind: 'dropped',
      text: `sw1 port eth0 puts pc1 in VLAN 10, but pc2's port eth1 is in VLAN 20: they are separate networks, so the frame has nowhere to go. Put both ports in the same VLAN.`,
      fix: 'bridge vlan add dev eth1 vid 10 pvid untagged && bridge vlan del dev eth1 vid 20',
      fixDevice: 'sw1',
      deviceId: sw.id,
    });
    sh(net, sw, 'bridge vlan del dev eth0 vid 10');
    expect(why(net, pc1, 'ping -c 1 10.0.0.2')).toMatchObject({
      text: expect.stringContaining(
        'sw1 port eth0 dropped the ARP request for 10.0.0.2: it arrived untagged and the port has no PVID',
      ),
      deviceId: sw.id,
    });
  });

  it('explains a Spanning Tree port that is still converging', () => {
    const { net, sw, pc1 } = office();
    sh(net, sw, 'ip link set br0 type bridge stp_state 1');
    expect(why(net, pc1, 'ping -c 1 10.0.0.2')).toMatchObject({
      kind: 'dropped',
      text: expect.stringContaining('sw1 port eth0 is still in Spanning Tree state'),
      deviceId: sw.id,
    });
  });

  it('explains WireGuard drops on both ends', () => {
    const { net, rA, rB, pcA } = sites();
    tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    sh(net, rA, 'wg-quick up wg0');
    sh(net, rB, 'wg-quick up wg0');
    sh(net, rA, 'ip route add 172.16.0.0/16 dev wg0');
    const key = rA.wireguard(rA.port('wg0'))?.peers[0]?.publicKey ?? '';
    expect(why(net, rA, 'ping -c 1 172.16.0.1')).toEqual({
      kind: 'dropped',
      text: "r1's tunnel wg0 has no peer whose allowed-ips include 172.16.0.1, so it has nobody to send it to.",
      fix: `wg set wg0 peer ${key} allowed-ips 10.8.0.2/32,192.168.2.0/24,172.16.0.1/32`,
      deviceId: rA.id,
    });
    const keyB = rB.wireguard(rB.port('wg0'))?.peers[0]?.publicKey ?? '';
    sh(net, rB, `wg set wg0 peer ${keyB} allowed-ips 10.8.0.1/32`);
    const e = why(net, pcA, 'ping -c 1 192.168.2.10');
    expect(e).toMatchObject({
      text: expect.stringContaining("r2's tunnel wg0 dropped a packet from 192.168.1.10"),
      deviceId: rB.id,
    });
  });

  it('explains Wi-Fi: out of range, and not connected', () => {
    const net = new Network();
    const where = new Map<string, { x: number; y: number }>();
    net.locate = (id) => where.get(id) ?? null;
    const ap = net.addDevice('ap');
    const laptop = net.addDevice('laptop');
    where.set(ap.id, { x: 0, y: 0 });
    where.set(laptop.id, { x: 100, y: 0 });
    sh(net, laptop, 'ip addr add 10.5.0.2/24 dev wlan0');
    expect(why(net, laptop, 'ping -c 1 10.5.0.1')).toMatchObject({
      text: 'laptop1 is not connected to a Wi-Fi network, so it has no link.',
      fix: 'nmcli dev wifi connect NetForge password netforge123',
    });
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    where.set(laptop.id, { x: WIFI_RANGE + 50, y: 0 });
    checkWireless(net);
    expect(why(net, laptop, 'ping -c 1 10.5.0.1')).toMatchObject({
      text: expect.stringContaining(
        'laptop1 lost its Wi-Fi connection to NetForge because it moved out of range',
      ),
    });
    // Forget the walk away: now no access point is in range at all.
    net.clearTrace();
    expect(why(net, laptop, 'ping -c 1 10.5.0.1')).toMatchObject({
      text: 'laptop1 is not connected to Wi-Fi, and no access point is in range. Move it closer to one.',
      fix: null,
    });
  });

  it('explains name lookups that fail', () => {
    const { net, pc1, pc2 } = office();
    expect(why(net, pc1, 'ping -c 1 web.lab')).toMatchObject({
      text: 'pc1 has no DNS server set, so it cannot turn "web.lab" into an address. Set one with resolvectl dns, or use the address directly.',
    });
    expect(why(net, pc1, 'dig web.lab')).toMatchObject({
      kind: 'config',
      text: 'pc1 has no DNS server set, so dig has nobody to ask. Set one with resolvectl dns, or use dig @server.',
    });
    sh(net, pc2, 'dnsmasq --address=/web.lab/10.0.0.9');
    expect(why(net, pc1, 'curl http://web.lab/')).toMatchObject({
      fix: 'resolvectl dns eth0 10.0.0.2',
    });
    sh(net, pc1, 'resolvectl dns eth0 10.0.0.2');
    expect(why(net, pc1, 'dig nope.lab')).toEqual({
      kind: 'dropped',
      text: 'The DNS server 10.0.0.2 (pc2) says that "nope.lab" does not exist. Check the spelling, or add the name on the DNS server (dnsmasq --address=/nope.lab/<address>).',
      fix: null,
      deviceId: pc1.id,
    });
  });

  it('explains a DNS server that cannot be reached', () => {
    const { net, r1, pc1 } = routed();
    sh(net, pc1, 'resolvectl dns eth0 192.168.2.20');
    sh(net, r1, FILTER);
    sh(net, r1, forwardChain('drop'));
    expect(why(net, pc1, 'dig web.lab')).toMatchObject({
      text: expect.stringContaining("r1's firewall dropped the DNS query to 192.168.2.20"),
      deviceId: r1.id,
    });
  });

  it('finds a reply that dies on the way back: no route home', () => {
    const { net, pc1, srv } = routed();
    sh(net, srv, 'ip route del default');
    expect(why(net, pc1, 'ping -c 1 192.168.2.20')).toEqual({
      kind: 'dropped',
      text: `Your ping reached 192.168.2.20, but the reply was lost on the way back. ${srv.name} has no default gateway, so it does not know where to send packets for 192.168.1.10.`,
      fix: 'ip route add default via 192.168.2.1',
      fixDevice: srv.name,
      deviceId: srv.id,
    });
  });

  it('finds a reply that dies on the way back: firewall on the return path', () => {
    const { net, r1, pc1 } = routed();
    sh(net, r1, FILTER);
    sh(net, r1, forwardChain('accept'));
    sh(net, r1, 'nft add rule ip filter forward ip saddr 192.168.2.20 drop');
    const e = why(net, pc1, 'ping -c 1 192.168.2.20');
    expect(e).toMatchObject({
      kind: 'dropped',
      text: expect.stringContaining(
        'Your ping reached 192.168.2.20, but the reply was lost on the way back. r1\'s firewall dropped the ping reply from 192.168.2.20 (chain forward, hook forward): rule "ip saddr 192.168.2.20 drop"',
      ),
      deviceId: r1.id,
    });
  });

  it('says so when nothing was dropped and replies arrived', () => {
    const { net, pc1 } = routed();
    expect(why(net, pc1, 'ping -c 1 192.168.2.20')).toEqual({
      kind: 'ok',
      text: 'Nothing was dropped on the way and replies arrived, so this worked.',
      fix: null,
      deviceId: null,
    });
  });

  it('is honest when the cause is unclear', () => {
    const { net, pc1 } = routed();
    // A failed ping that left no drop behind, as when nobody dropped anything we can see.
    const e = explainFailure(net, pc1, {
      line: 'ping -c 1 192.168.2.20',
      output: ['1 packets transmitted, 0 received, 100% packet loss, time 0ms'],
      after: net.dropSeq,
      until: net.dropSeq,
    });
    expect(e).toEqual({
      kind: 'unknown',
      text: 'No device reported dropping anything, so the cause is not clear from here. 192.168.2.20 may be off or not answering, or the command was stopped before it could finish.',
      fix: null,
      deviceId: null,
    });
  });

  it('ignores traceroute probes that die by design and other commands', () => {
    const { net, pc1 } = routed();
    expect(why(net, pc1, 'traceroute 192.168.2.20')).toMatchObject({ kind: 'ok' });
    expect(why(net, pc1, 'echo hi')).toBeNull();
  });
});
