import { describe, expect, it } from 'vitest';
import { parseIp, type Ip } from './addr.ts';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';
import type { TcpConnection } from './tcp.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

function ip(text: string): Ip {
  const v = parseIp(text);
  if (v === null) throw new Error(text);
  return v;
}

function lab() {
  const net = new Network();
  const client = net.addDevice('pc', 'client');
  const server = net.addDevice('pc', 'server');
  net.connect(client, server);
  sh(net, client, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, server, 'ip addr add 10.0.0.2/24 dev eth0');
  const tcp = (d: Device) => {
    if (!d.ip) throw new Error('no ip');
    return d.ip.tcp;
  };
  return { net, client, server, tcp };
}

function flagsOnWire(net: Network): string[] {
  return net.trace.flatMap((t) => {
    const p = t.frame.payload;
    return p.kind === 'ipv4' && p.payload.kind === 'tcp' ? [p.payload.flags.join('+')] : [];
  });
}

describe('TCP', () => {
  it('connects with a handshake, carries data both ways and closes with FIN', () => {
    const { net, client, server, tcp } = lab();
    const got: string[] = [];
    tcp(server).listen(7, () => ({
      onData: (text, conn) => {
        got.push(`server got ${text}`);
        conn.send(text.toUpperCase());
      },
      onClose: (conn) => got.push(`server closed ${conn.state}`),
    }));
    const conn: TcpConnection | string = tcp(client).connect(ip('10.0.0.2'), 7, {
      onOpen: (c) => c.send('hello'),
      onData: (text, c) => {
        got.push(`client got ${text}`);
        c.close();
      },
      onClose: () => got.push('client closed'),
    });
    expect(typeof conn).not.toBe('string');
    net.scheduler.runUntil(1000);
    expect(got).toEqual([
      'server got hello',
      'client got HELLO',
      'server closed closing',
      'client closed',
    ]);
    expect(flagsOnWire(net)).toEqual([
      'SYN',
      'SYN+ACK',
      'ACK',
      'PSH+ACK', // hello
      'ACK',
      'PSH+ACK', // HELLO
      'ACK',
      'FIN+ACK', // client closes
      'FIN+ACK', // server closes in the same segment it acknowledges with
      'ACK',
    ]);
    expect(tcp(client).connections()).toEqual([]);
    expect(tcp(server).connections()).toEqual([]);
    expect(net.scheduler.pending).toBe(0);
  });

  it('remembers the servers it opened a connection to, not refused ones', () => {
    const { net, client, server, tcp } = lab();
    tcp(client).connect(ip('10.0.0.2'), 7, { onData: () => {} });
    net.scheduler.runUntil(1000);
    expect([...tcp(client).connectedTo]).toEqual([]);
    tcp(server).listen(7, () => ({ onData: () => {} }));
    tcp(client).connect(ip('10.0.0.2'), 7, { onData: () => {} });
    net.scheduler.runUntil(2000);
    expect([...tcp(client).connectedTo]).toEqual([ip('10.0.0.2')]);
  });

  it('is refused with RST on a closed port', () => {
    const { net, client } = lab();
    expect(sh(net, client, 'nc -z 10.0.0.2 80')).toEqual([
      'nc: connect to 10.0.0.2 (10.0.0.2) port 80 (tcp) failed: Connection refused',
    ]);
    expect(flagsOnWire(net)).toEqual(['SYN', 'RST+ACK']);
  });

  it('retries the SYN and times out when nobody answers', () => {
    const { net, client } = lab();
    const out = sh(net, client, 'nc -z 10.0.0.99 80');
    expect(out).toEqual([
      'nc: connect to 10.0.0.99 (10.0.0.99) port 80 (tcp) failed: No route to host',
    ]);
    // An address in no network at all: nothing to send to.
    expect(sh(net, client, 'nc -z 172.16.0.1 80')).toEqual([
      'nc: connect to 172.16.0.1 port 80 (tcp) failed: Network is unreachable',
    ]);
  });

  it('times out after three SYNs when packets vanish', () => {
    const { net, client, server } = lab();
    // The client learns the server's MAC, then the server forgets its address: frames still
    // arrive, but the server silently drops packets that aren't for it.
    sh(net, client, 'ping -c 1 10.0.0.2');
    sh(net, server, 'ip addr flush dev eth0');
    const out = sh(net, client, 'nc -z 10.0.0.2 80');
    expect(out).toEqual([
      'nc: connect to 10.0.0.2 (10.0.0.2) port 80 (tcp) failed: Connection timed out',
    ]);
    expect(net.scheduler.now).toBeGreaterThanOrEqual(7000);
  });

  it('nc -z succeeds on a listening port and ss shows sockets', () => {
    const { net, client, server, tcp } = lab();
    tcp(server).listen(80, () => ({ onData: () => {} }));
    expect(sh(net, client, 'nc -z 10.0.0.2 80')).toEqual([
      'Connection to 10.0.0.2 (10.0.0.2) 80 port [tcp/http] succeeded!',
    ]);
    expect(sh(net, server, 'ss -tln')).toEqual([
      'State      Local Address:Port      Peer Address:Port',
      'LISTEN     0.0.0.0:80              0.0.0.0:*',
    ]);
    expect(net.scheduler.pending).toBe(0);
  });

  it('works across a router', () => {
    const net = new Network();
    const r1 = net.addDevice('router');
    const a = net.addDevice('pc');
    const b = net.addDevice('pc');
    net.connect(a, r1);
    net.connect(b, r1);
    sh(net, r1, 'ip addr add 10.0.1.1/24 dev eth0');
    sh(net, r1, 'ip addr add 10.0.2.1/24 dev eth1');
    sh(net, a, 'ip addr add 10.0.1.10/24 dev eth0');
    sh(net, a, 'ip route add default via 10.0.1.1');
    sh(net, b, 'ip addr add 10.0.2.10/24 dev eth0');
    sh(net, b, 'ip route add default via 10.0.2.1');
    b.ip?.tcp.listen(25, () => ({ onData: () => {} }));
    expect(sh(net, a, 'nc -z 10.0.2.10 25')).toEqual([
      'Connection to 10.0.2.10 (10.0.2.10) 25 port [tcp/smtp] succeeded!',
    ]);
  });
});
