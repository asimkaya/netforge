import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

/** Helpers shared by engine tests: run shell commands and build small labs. */

/** Runs a command line and returns its output, advancing virtual time until it exits. */
export function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

export const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);
export const wait = (net: Network, ms: number) => net.scheduler.runUntil(net.scheduler.now + ms);
export const received = (lines: string[]) => lines.some((l) => / [1-9]\d* received/.test(l));

/** pc1 and pc2 on one switch, in one network (10.0.0.0/24), no gateways. */
export function office() {
  const net = new Network();
  const sw = net.addDevice('switch');
  const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
  net.connect(port(pc1, 'eth0'), port(sw, 'eth0'));
  net.connect(port(pc2, 'eth0'), port(sw, 'eth1'));
  sh(net, pc1, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, pc2, 'ip addr add 10.0.0.2/24 dev eth0');
  return { net, sw, pc1, pc2 };
}

/**
 * pc1 (192.168.1.10) and a server (192.168.2.20) on two LANs joined by router r1
 * (192.168.1.1 and 192.168.2.1). Both hosts have default routes through r1.
 */
export function routed() {
  const net = new Network();
  const r1 = net.addDevice('router');
  const [pc1, srv] = [net.addDevice('pc'), net.addDevice('server')];
  net.connect(port(pc1, 'eth0'), port(r1, 'eth0'));
  net.connect(port(srv, 'eth0'), port(r1, 'eth1'));
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth0');
  sh(net, r1, 'ip addr add 192.168.2.1/24 dev eth1');
  sh(net, pc1, 'ip addr add 192.168.1.10/24 dev eth0');
  sh(net, pc1, 'ip route add default via 192.168.1.1');
  sh(net, srv, 'ip addr add 192.168.2.20/24 dev eth0');
  sh(net, srv, 'ip route add default via 192.168.2.1');
  return { net, r1, pc1, srv };
}

/** Two offices behind routers whose eth1 gets a public address from the Internet cloud. */
export function sites() {
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

/** Writes wg-quick files for a tunnel between two routers; `wg-quick up wg0` starts it. */
export function tunnel(
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
