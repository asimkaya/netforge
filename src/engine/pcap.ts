import type { Ip, Mac } from './addr.ts';
import type { Ip6 } from './addr6.ts';
import type {
  BpduPacket,
  DhcpMessage,
  DnsMessage,
  EthernetFrame,
  Icmp6Packet,
  IcmpPacket,
  Ipv4Packet,
  Ipv6Packet,
  OspfPacket,
  TcpSegment,
  UdpDatagram,
} from './packet.ts';

/**
 * Encodes frames as real bytes and writes them to a pcap file that Wireshark and tcpdump
 * open. Fields NetForge does not model get the values a Linux host would typically send
 * (window sizes, ping payload, BOOTP padding). See docs/FEATURES.md.
 */

/** A growable byte buffer with network byte order writers. */
class Bytes {
  readonly data: number[] = [];

  u8(n: number): this {
    this.data.push(n & 0xff);
    return this;
  }

  u16(n: number): this {
    return this.u8(n >>> 8).u8(n);
  }

  u32(n: number): this {
    return this.u16(n >>> 16).u16(n);
  }

  mac(mac: Mac): this {
    for (const part of mac.split(':')) this.u8(parseInt(part, 16));
    return this;
  }

  ip(ip: Ip): this {
    return this.u32(ip);
  }

  ip6(ip: Ip6): this {
    for (let i = 15; i >= 0; i--) this.u8(Number((ip >> BigInt(8 * i)) & 0xffn));
    return this;
  }

  bytes(b: readonly number[]): this {
    for (const x of b) this.u8(x);
    return this;
  }

  /** ASCII text; shortcut: other characters become `?` (protocols here are ASCII). */
  text(s: string): this {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.u8(c < 0x80 ? c : 0x3f);
    }
    return this;
  }

  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }

  /** Writes a 16-bit value at an offset (for checksums and lengths). */
  set16(at: number, n: number): void {
    this.data[at] = (n >>> 8) & 0xff;
    this.data[at + 1] = n & 0xff;
  }
}

/** The Internet checksum: one's complement of the one's complement sum of 16-bit words. */
export function checksum(bytes: readonly number[], initial = 0): number {
  let sum = initial;
  for (let i = 0; i < bytes.length; i += 2) sum += ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** Sum of an IPv4 pseudo-header, for TCP and UDP checksums. */
function pseudo4(src: Ip, dst: Ip, proto: number, length: number): number {
  return (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + proto + length;
}

function pseudo6(src: Ip6, dst: Ip6, length: number): number {
  let sum = 0;
  for (const ip of [src, dst]) {
    for (let i = 7; i >= 0; i--) sum += Number((ip >> BigInt(16 * i)) & 0xffffn);
  }
  return sum + (length >>> 16) + (length & 0xffff) + 58;
}

/** The 56 data bytes Linux ping sends: a timestamp, then 0x10, 0x11, ... */
const PING_DATA = Array.from({ length: 56 }, (_, i) => (i < 16 ? 0 : i));

// ------------------------------------------------------------------ IPv4

function icmp(m: IcmpPacket, encodeOriginal: (p: Ipv4Packet) => number[]): number[] {
  const b = new Bytes();
  switch (m.type) {
    case 'echo-request':
    case 'echo-reply':
      b.u8(m.type === 'echo-request' ? 8 : 0)
        .u8(0)
        .u16(0)
        .u16(m.id)
        .u16(m.seq)
        .bytes(PING_DATA);
      break;
    case 'time-exceeded':
      b.u8(11).u8(0).u16(0).u32(0).bytes(encodeOriginal(m.original).slice(0, 28));
      break;
    case 'dest-unreachable':
      b.u8(3)
        .u8({ net: 0, host: 1, port: 3 }[m.code])
        .u16(0)
        .u32(0)
        .bytes(encodeOriginal(m.original).slice(0, 28));
      break;
  }
  b.set16(2, checksum(b.data));
  return b.data;
}

function dhcp(m: DhcpMessage): number[] {
  const b = new Bytes();
  const reply = m.op === 'offer' || m.op === 'ack' || m.op === 'nak';
  b.u8(reply ? 2 : 1)
    .u8(1)
    .u8(6)
    .u8(0)
    .u32(m.xid)
    .u16(0)
    .u16(0x8000);
  b.u32(0).ip(m.yiaddr).ip(m.serverId).u32(0).mac(m.chaddr).zeros(10).zeros(64).zeros(128);
  b.bytes([99, 130, 83, 99]);
  const type = { discover: 1, offer: 2, request: 3, ack: 5, nak: 6, release: 7 }[m.op];
  b.u8(53).u8(1).u8(type);
  if (m.serverId) b.u8(54).u8(4).ip(m.serverId);
  if (m.requested !== undefined) b.u8(50).u8(4).ip(m.requested);
  if (m.hostname) b.u8(12).u8(m.hostname.length).text(m.hostname);
  if (m.lease) {
    const mask = m.lease.prefix === 0 ? 0 : (0xffffffff << (32 - m.lease.prefix)) >>> 0;
    b.u8(1).u8(4).u32(mask);
    if (m.lease.router !== undefined) b.u8(3).u8(4).ip(m.lease.router);
    if (m.lease.dns !== undefined) b.u8(6).u8(4).ip(m.lease.dns);
    b.u8(51).u8(4).u32(m.lease.seconds);
  }
  b.u8(255);
  while (b.data.length < 300) b.u8(0);
  return b.data;
}

function dnsName(b: Bytes, name: string): void {
  for (const label of name.split('.')) b.u8(label.length).text(label);
  b.u8(0);
}

function dns(m: DnsMessage): number[] {
  const b = new Bytes();
  const response = m.qr === 'response';
  const nx = response && m.answer === null;
  b.u16(m.id).u16(response ? 0x8180 | (nx ? 3 : 0) : 0x0100);
  b.u16(1)
    .u16(response && m.answer ? 1 : 0)
    .u16(0)
    .u16(0);
  dnsName(b, m.name);
  b.u16(1).u16(1);
  if (response && m.answer) b.u16(0xc00c).u16(1).u16(1).u32(0).u16(4).ip(m.answer);
  return b.data;
}

function udp(p: Ipv4Packet, u: UdpDatagram): number[] {
  const d = u.data;
  const payload =
    d.app === 'dhcp' ? dhcp(d) : d.app === 'dns' ? dns(d) : new Array<number>(32).fill(0);
  const b = new Bytes()
    .u16(u.srcPort)
    .u16(u.dstPort)
    .u16(8 + payload.length)
    .u16(0)
    .bytes(payload);
  b.set16(6, checksum(b.data, pseudo4(p.src, p.dst, 17, b.data.length)) || 0xffff);
  return b.data;
}

const TCP_BITS = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16 } as const;

function tcp(p: Ipv4Packet, t: TcpSegment): number[] {
  const flags = t.flags.reduce((acc, f) => acc | TCP_BITS[f], 0);
  const b = new Bytes().u16(t.srcPort).u16(t.dstPort).u32(t.seq).u32(t.ack);
  b.u8(5 << 4)
    .u8(flags)
    .u16(64240)
    .u16(0)
    .u16(0)
    .text(t.data ?? '');
  b.set16(16, checksum(b.data, pseudo4(p.src, p.dst, 6, b.data.length)));
  return b.data;
}

function ospf(o: OspfPacket): number[] {
  const body = new Bytes();
  if (o.type === 'hello') {
    body.u32(0).u16(10).u8(0x02).u8(1).u32(40).u32(0).u32(0);
    for (const n of o.neighbors) body.ip(n);
  } else {
    body.u32(o.lsas.length);
    for (const lsa of o.lsas) {
      const links = new Bytes().u8(0).u8(0).u16(lsa.links.length);
      for (const l of lsa.links) {
        if (l.kind === 'router') links.ip(l.id).u32(0).u8(1).u8(0).u16(l.cost);
        else {
          const mask = l.prefix === 0 ? 0 : (0xffffffff << (32 - l.prefix)) >>> 0;
          links.ip(l.net).u32(mask).u8(3).u8(0).u16(l.cost);
        }
      }
      body.u16(0).u8(0x02).u8(1).ip(lsa.routerId).ip(lsa.routerId);
      body
        .u32((0x80000000 + lsa.seq) >>> 0)
        .u16(0)
        .u16(20 + links.data.length);
      body.bytes(links.data);
    }
  }
  const b = new Bytes()
    .u8(2)
    .u8(o.type === 'hello' ? 1 : 4)
    .u16(24 + body.data.length);
  b.ip(o.routerId).u32(o.area).u16(0).u16(0).zeros(8).bytes(body.data);
  b.set16(12, checksum(b.data));
  return b.data;
}

let ipId = 0;

function ipv4(p: Ipv4Packet): number[] {
  const l4 = p.payload;
  const [proto, payload] =
    l4.kind === 'icmp'
      ? [1, icmp(l4, ipv4)]
      : l4.kind === 'udp'
        ? [17, udp(p, l4)]
        : l4.kind === 'tcp'
          ? [6, tcp(p, l4)]
          : [89, ospf(l4)];
  const b = new Bytes()
    .u8(0x45)
    .u8(0)
    .u16(20 + payload.length)
    .u16(++ipId & 0xffff)
    .u16(0);
  b.u8(p.ttl).u8(proto).u16(0).ip(p.src).ip(p.dst);
  b.set16(10, checksum(b.data));
  return b.bytes(payload).data;
}

// ------------------------------------------------------------------ IPv6

function icmp6(p: Ipv6Packet, m: Icmp6Packet, srcMac: Mac): number[] {
  const b = new Bytes();
  switch (m.type) {
    case 'echo-request':
    case 'echo-reply':
      b.u8(m.type === 'echo-request' ? 128 : 129)
        .u8(0)
        .u16(0)
        .u16(m.id)
        .u16(m.seq)
        .bytes(PING_DATA);
      break;
    case 'router-solicitation':
      b.u8(133).u8(0).u16(0).u32(0).u8(1).u8(1).mac(srcMac);
      break;
    case 'router-advertisement':
      b.u8(134).u8(0).u16(0).u8(64).u8(0).u16(m.lifetime).u32(0).u32(0).u8(1).u8(1).mac(srcMac);
      for (const prefix of m.prefixes) {
        b.u8(3).u8(4).u8(prefix.prefix).u8(0xc0).u32(86400).u32(14400).u32(0).ip6(prefix.ip);
      }
      break;
    case 'neighbor-solicitation':
      b.u8(135).u8(0).u16(0).u32(0).ip6(m.target).u8(1).u8(1).mac(srcMac);
      break;
    case 'neighbor-advertisement':
      b.u8(136)
        .u8(0)
        .u16(0)
        .u32(m.solicited ? 0x60000000 : 0x20000000)
        .ip6(m.target);
      b.u8(2).u8(1).mac(srcMac);
      break;
    case 'time-exceeded':
      b.u8(3).u8(0).u16(0).u32(0).bytes(ipv6(m.original, srcMac));
      break;
    case 'dest-unreachable':
      b.u8(1).u8({ route: 0, address: 3, port: 4 }[m.code]).u16(0).u32(0);
      b.bytes(ipv6(m.original, srcMac));
      break;
  }
  b.set16(2, checksum(b.data, pseudo6(p.src, p.dst, b.data.length)));
  return b.data;
}

function ipv6(p: Ipv6Packet, srcMac: Mac): number[] {
  const payload = icmp6(p, p.payload, srcMac);
  const b = new Bytes().u32(0x60000000).u16(payload.length).u8(58).u8(p.hopLimit);
  return b.ip6(p.src).ip6(p.dst).bytes(payload).data;
}

// ------------------------------------------------------------- Ethernet

function bridgeId(id: string): Bytes {
  const [priority, mac] = id.split('.');
  return new Bytes().u16(parseInt(priority ?? '8000', 16)).mac(mac ?? '00:00:00:00:00:00');
}

function bpdu(m: BpduPacket): number[] {
  const b = new Bytes()
    .u16(0)
    .u8(0)
    .u8(0)
    .u8(m.tc ? 0x01 : 0);
  b.bytes(bridgeId(m.rootId).data).u32(m.rootCost).bytes(bridgeId(m.bridgeId).data);
  return b
    .u16(m.portId)
    .u16(0)
    .u16(20 * 256)
    .u16(2 * 256)
    .u16(15 * 256).data;
}

/** One Ethernet frame as bytes. */
export function encodeFrame(frame: EthernetFrame): Uint8Array {
  const b = new Bytes().mac(frame.dst).mac(frame.src);
  if (frame.vlan !== undefined) b.u16(0x8100).u16(frame.vlan);
  const p = frame.payload;
  if (p.kind === 'bpdu') {
    const body = bpdu(p);
    b.u16(3 + body.length)
      .bytes([0x42, 0x42, 0x03])
      .bytes(body);
  } else if (p.kind === 'arp') {
    b.u16(0x0806)
      .u16(1)
      .u16(0x0800)
      .u8(6)
      .u8(4)
      .u16(p.op === 'request' ? 1 : 2);
    b.mac(p.senderMac).ip(p.senderIp).mac(p.targetMac).ip(p.targetIp);
  } else if (p.kind === 'ipv4') {
    b.u16(0x0800).bytes(ipv4(p));
  } else {
    b.u16(0x86dd).bytes(ipv6(p, frame.src));
  }
  // Ethernet pads short frames to 60 bytes (without the FCS).
  while (b.data.length < 60) b.u8(0);
  return Uint8Array.from(b.data);
}

/** A pcap file (libpcap format, Ethernet link type) of frames at virtual times in ms. */
export function pcapFile(entries: readonly { time: number; frame: EthernetFrame }[]): Uint8Array {
  ipId = 0;
  const out: number[] = [];
  const le32 = (n: number) =>
    out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const le16 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff);
  le32(0xa1b2c3d4);
  le16(2);
  le16(4);
  le32(0);
  le32(0);
  le32(262144);
  le32(1);
  for (const { time, frame } of entries) {
    const bytes = encodeFrame(frame);
    const usec = Math.round(time * 1000);
    le32(Math.floor(usec / 1_000_000));
    le32(usec % 1_000_000);
    le32(bytes.length);
    le32(bytes.length);
    for (const x of bytes) out.push(x);
  }
  return Uint8Array.from(out);
}
