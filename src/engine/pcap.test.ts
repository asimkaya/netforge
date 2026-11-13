import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { checksum, encodeFrame, pcapFile } from './pcap.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

const word = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const sum = (b: Uint8Array, from: number, to: number, initial = 0) =>
  checksum([...b.slice(from, to)], initial);

/** Checks every checksum a receiver would check. Returns the protocols it saw. */
function verify(bytes: Uint8Array): string {
  let at = 12;
  if (word(bytes, at) === 0x8100) at += 4;
  const type = word(bytes, at);
  at += 2;
  if (type === 0x0806) return 'arp';
  if (type < 0x0600) {
    expect([bytes[at], bytes[at + 1], bytes[at + 2]]).toEqual([0x42, 0x42, 0x03]);
    return 'stp';
  }
  if (type === 0x86dd) {
    const length = word(bytes, at + 4);
    let pseudo = 0;
    for (let i = 8; i < 40; i += 2) pseudo += word(bytes, at + i);
    pseudo += length + 58;
    expect(sum(bytes, at + 40, at + 40 + length, pseudo)).toBe(0);
    return `icmp6-${bytes[at + 40]}`;
  }
  expect(type).toBe(0x0800);
  expect(sum(bytes, at, at + 20)).toBe(0);
  const total = word(bytes, at + 2);
  const proto = bytes[at + 9];
  const l4 = at + 20;
  const end = at + total;
  if (proto === 1 || proto === 89) {
    expect(sum(bytes, l4, end)).toBe(0);
    return proto === 1 ? 'icmp' : 'ospf';
  }
  const pseudo =
    word(bytes, at + 12) + word(bytes, at + 14) + word(bytes, at + 16) + word(bytes, at + 18);
  expect(sum(bytes, l4, end, pseudo + (proto ?? 0) + (end - l4))).toBe(0);
  return proto === 6 ? 'tcp' : 'udp';
}

describe('pcap export', () => {
  it('encodes every protocol with valid checksums', () => {
    const net = new Network();
    const inet = net.addDevice('internet');
    const r1 = net.addDevice('router');
    const sw = net.addDevice('switch');
    const pc = net.addDevice('pc');
    const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);
    net.connect(port(r1, 'eth1'), port(inet, 'eth0'));
    net.connect(port(r1, 'eth0'), port(sw, 'eth0'));
    net.connect(port(pc, 'eth0'), port(sw, 'eth1'));
    sh(net, sw, 'ip link set br0 type bridge stp_state 1');
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    net.scheduler.runUntil(net.scheduler.now + 31_000);
    sh(net, r1, 'dhclient eth1');
    sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth0');
    sh(net, r1, 'ip addr add 2001:db8:1::1/64 dev eth0');
    r1.fs?.write(
      '/etc/radvd.conf',
      'interface eth0 { AdvSendAdvert on; prefix 2001:db8:1::/64 { }; };',
    );
    sh(net, r1, 'radvd');
    sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199 --address=/web.lab/198.18.0.10');
    sh(net, r1, 'nft add table ip nat');
    sh(net, r1, 'nft add chain ip nat postrouting { type nat hook postrouting priority 100 ; }');
    sh(net, r1, 'nft add rule ip nat postrouting oifname eth1 masquerade');
    sh(net, r1, 'bird');
    sh(net, pc, 'dhclient eth0');
    sh(net, pc, 'ping -c 1 web.lab');
    sh(net, pc, 'curl -s http://web.lab/');
    sh(net, pc, 'traceroute -m 2 198.18.0.10');
    sh(net, pc, 'ping -c 1 2001:db8:1::1');
    const seen = new Set(net.trace.map((e) => verify(encodeFrame(e.frame))));
    expect([...seen].sort()).toEqual([
      'arp',
      'icmp',
      'icmp6-128',
      'icmp6-129',
      'icmp6-133',
      'icmp6-134',
      'icmp6-135',
      'icmp6-136',
      'ospf',
      'stp',
      'tcp',
      'udp',
    ]);
  });

  it('writes a libpcap file with Ethernet frames and virtual timestamps', () => {
    const net = new Network();
    const [a, b] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(a, b);
    sh(net, a, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(net, b, 'ip addr add 10.0.0.2/24 dev eth0');
    // Let the router solicitations from plugging in pass first.
    net.scheduler.runUntil(net.scheduler.now + 10);
    net.trace = [];
    sh(net, a, 'ping -c 1 10.0.0.2');
    const file = pcapFile(net.trace);
    expect([...file.slice(0, 4)]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
    expect(file[20]).toBe(1); // link type: Ethernet
    // The first record: the ARP request, timestamped with virtual time, padded to 60 bytes.
    const view = new DataView(file.buffer);
    const usec = Math.round((net.trace[0]?.time ?? 0) * 1000);
    expect(view.getUint32(24, true)).toBe(Math.floor(usec / 1e6));
    expect(view.getUint32(28, true)).toBe(usec % 1e6);
    expect(view.getUint32(32, true)).toBe(60);
    expect(file.length).toBe(24 + 4 * 16 + 60 + 60 + 98 + 98);
    // An echo request carries the 56 data bytes Linux ping sends.
    const echo = encodeFrame(net.trace[2]?.frame ?? (undefined as never));
    expect(echo.length).toBe(14 + 20 + 8 + 56);
  });
});
