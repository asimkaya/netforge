import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { describeFrame } from './packet.ts';
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
const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);

/** Two offices behind routers whose eth1 gets a public address from the Internet cloud. */
function sites() {
  const net = new Network();
  const inet = net.addDevice('internet');
  const [rA, rB] = [net.addDevice('router'), net.addDevice('router')];
  const [pcA, pcB] = [net.addDevice('pc'), net.addDevice('pc')];
  net.connect(port(rA, 'eth1'), port(inet, 'eth0'));
  net.connect(port(rB, 'eth1'), port(inet, 'eth1'));
  net.connect(port(pcA, 'eth0'), port(rA, 'eth0'));
  net.connect(port(pcB, 'eth0'), port(rB, 'eth0'));
  sh(net, rA, 'dhclient eth1');
  sh(net, rB, 'dhclient eth1');
  sh(net, rA, 'ip addr add 192.168.1.1/24 dev eth0');
  sh(net, rB, 'ip addr add 192.168.2.1/24 dev eth0');
  sh(net, pcA, 'ip addr add 192.168.1.10/24 dev eth0');
  sh(net, pcA, 'ip route add default via 192.168.1.1');
  sh(net, pcB, 'ip addr add 192.168.2.10/24 dev eth0');
  sh(net, pcB, 'ip route add default via 192.168.2.1');
  return { net, inet, rA, rB, pcA, pcB };
}

/** Keys with the usual idiom, then a wg-quick file pointing at the other side. */
function tunnel(
  net: Network,
  a: Device,
  b: Device,
  addr: [string, string],
  ends: [string, string],
) {
  const keys = [a, b].map((r) => {
    const pub = sh(net, r, 'wg genkey | tee /etc/wireguard/private.key | wg pubkey')[0] ?? '';
    const priv = sh(net, r, 'cat /etc/wireguard/private.key')[0] ?? '';
    return { pub, priv };
  });
  const lan = ['192.168.1.0/24', '192.168.2.0/24'];
  [a, b].forEach((r, i) => {
    const me = keys[i];
    const other = keys[1 - i];
    r.fs?.write(
      '/etc/wireguard/wg0.conf',
      [
        '[Interface]',
        `PrivateKey = ${me?.priv ?? ''}`,
        `Address = ${addr[i] ?? ''}/24`,
        'ListenPort = 51820',
        '',
        '[Peer]',
        `PublicKey = ${other?.pub ?? ''}`,
        `Endpoint = ${ends[1 - i] ?? ''}:51820`,
        `AllowedIPs = ${addr[1 - i] ?? ''}/32, ${lan[1 - i] ?? ''}`,
        'PersistentKeepalive = 25',
        '',
      ].join('\n'),
    );
  });
  return keys;
}

describe('WireGuard', () => {
  it('makes keys like wg genkey and wg pubkey', () => {
    const { net, rA } = sites();
    const priv = sh(net, rA, 'wg genkey')[0] ?? '';
    expect(priv).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(sh(net, rA, 'wg genkey')[0]).not.toBe(priv);
    const pub = sh(net, rA, `echo ${priv} | wg pubkey`)[0];
    expect(pub).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(sh(net, rA, `echo ${priv} | wg pubkey`)[0]).toBe(pub);
    expect(sh(net, rA, 'echo nope | wg pubkey')).toEqual([
      "Key is not the correct length or format: `nope'",
    ]);
  });

  it('connects two offices through the Internet', () => {
    const { net, rA, rB, pcA, pcB } = sites();
    expect(received(sh(net, pcA, 'ping -c 1 192.168.2.10'))).toBe(false);
    const keys = tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    expect(sh(net, rA, 'wg-quick up wg0')).toEqual([
      '[#] ip link add wg0 type wireguard',
      '[#] wg setconf wg0 /dev/fd/63',
      '[#] ip -4 address add 10.8.0.1/24 dev wg0',
      '[#] ip link set mtu 1420 up dev wg0',
      '[#] ip -4 route add 192.168.2.0/24 dev wg0',
    ]);
    sh(net, rB, 'wg-quick up wg0');
    net.trace = [];
    const lines = sh(net, pcA, 'ping -c 1 192.168.2.10');
    expect(lines[1]).toBe('64 bytes from 192.168.2.10: icmp_seq=1 ttl=62 time=4.00 ms');
    // On the Internet the ping is sealed inside UDP between the two public addresses.
    const outside = net.trace.filter((e) => e.from.device === rA.id && e.from.port === 'eth1');
    expect(outside.map((e) => describeFrame(e.frame))).toEqual([
      'IP 192.0.2.100.51820 > 198.51.100.100.51820: WireGuard handshake initiation',
      'IP 192.0.2.100.51820 > 198.51.100.100.51820: WireGuard transport data',
    ]);
    const show = sh(net, rA, 'wg show');
    expect(show.slice(0, 4)).toEqual([
      'interface: wg0',
      `  public key: ${keys[0]?.pub}`,
      '  private key: (hidden)',
      '  listening port: 51820',
    ]);
    expect(show.slice(5)).toEqual([
      `peer: ${keys[1]?.pub}`,
      '  endpoint: 198.51.100.100:51820',
      '  allowed ips: 10.8.0.2/32, 192.168.2.0/24',
      '  latest handshake: 0 seconds ago',
      '  transfer: 116 B received, 116 B sent',
      '  persistent keepalive: every 25 seconds',
    ]);
    expect(received(sh(net, pcB, 'ping -c 1 10.8.0.1'))).toBe(true);
    expect(sh(net, rA, 'ip link show wg0')).toEqual([
      '6: wg0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420 state UNKNOWN',
      '    link/none',
    ]);
  });

  it('retries a handshake the other side missed', () => {
    const { net, rA, rB, pcA } = sites();
    tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    sh(net, rA, 'wg-quick up wg0');
    // rB has no tunnel yet, so the first initiation is lost.
    expect(received(sh(net, pcA, 'ping -c 1 192.168.2.10'))).toBe(false);
    sh(net, rB, 'wg-quick up wg0');
    net.scheduler.runUntil(net.scheduler.now + 5000);
    expect(received(sh(net, pcA, 'ping -c 1 192.168.2.10'))).toBe(true);
    // The packets that waited for the handshake were sent.
    expect(rA.wireguard(rA.port('wg0'))?.peers[0]?.queue).toEqual([]);
  });

  it('only accepts and sends what the allowed IPs permit', () => {
    const { net, rA, rB, pcA } = sites();
    tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    sh(net, rA, 'wg-quick up wg0');
    sh(net, rB, 'wg-quick up wg0');
    // A destination no peer is allowed to have.
    sh(net, rA, 'ip route add 172.16.0.0/16 dev wg0');
    expect(sh(net, rA, 'ping -c 1 172.16.0.1')[1]).toBe(
      'ping: sendmsg: Required key not available',
    );
    // rB stops allowing rA's LAN: pcA's packets arrive but are dropped.
    sh(
      net,
      rB,
      `wg set wg0 peer ${rB.wireguard(rB.port('wg0'))?.peers[0]?.publicKey ?? ''} allowed-ips 10.8.0.1/32`,
    );
    expect(received(sh(net, pcA, 'ping -c 1 192.168.2.10'))).toBe(false);
    expect(received(sh(net, rA, 'ping -c 1 10.8.0.2'))).toBe(true);
    expect(sh(net, rA, 'wg-quick up wg0')).toEqual(["wg-quick: `wg0' already exists"]);
    expect(sh(net, rA, 'wg-quick down wg0')).toEqual(['[#] ip link delete dev wg0']);
    expect(sh(net, rA, 'wg show wg0')).toEqual(['Unable to access interface: No such device']);
    expect(sh(net, rA, 'ip route').some((l) => l.includes('wg0'))).toBe(false);
  });

  it('keeps tunnels across a save and load', () => {
    const { net, rA, rB, pcA } = sites();
    tunnel(net, rA, rB, ['10.8.0.1', '10.8.0.2'], ['192.0.2.100', '198.51.100.100']);
    sh(net, rA, 'wg-quick up wg0');
    sh(net, rB, 'wg-quick up wg0');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const pc = copy.devices.get(pcA.id) ?? pcA;
    expect(received(sh(copy, pc, 'ping -c 1 192.168.2.10'))).toBe(true);
  });
});
