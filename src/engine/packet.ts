import { formatIp, type Ip, type Mac } from './addr.ts';

export interface ArpPacket {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: Mac;
  senderIp: Ip;
  targetMac: Mac;
  targetIp: Ip;
}

export type UnreachableCode = 'net' | 'host' | 'port';

export type IcmpPacket =
  | { kind: 'icmp'; type: 'echo-request' | 'echo-reply'; id: number; seq: number }
  /** Errors carry the packet that caused them, so the sender can match them up. */
  | { kind: 'icmp'; type: 'time-exceeded'; original: Ipv4Packet }
  | { kind: 'icmp'; type: 'dest-unreachable'; code: UnreachableCode; original: Ipv4Packet };

export type DhcpOp = 'discover' | 'offer' | 'request' | 'ack' | 'nak' | 'release';

export interface DhcpMessage {
  app: 'dhcp';
  op: DhcpOp;
  /** Transaction id chosen by the client. */
  xid: number;
  /** Client hardware address. */
  chaddr: Mac;
  /** "Your" address offered or assigned by the server (0 if none). */
  yiaddr: Ip;
  /** The server's address (0 in a discover). */
  serverId: Ip;
  requested?: Ip;
  hostname?: string;
  /** Network settings handed out with an offer or ack. */
  lease?: { prefix: number; router?: Ip; dns?: Ip; seconds: number };
}

export interface DnsMessage {
  app: 'dns';
  id: number;
  qr: 'query' | 'response';
  /** Fully qualified name without the trailing dot, e.g. `web.lab`. */
  name: string;
  /** A response's address; null means NXDOMAIN (no such name). */
  answer?: Ip | null;
}

/** An empty datagram, e.g. a traceroute probe. */
export interface ProbeData {
  app: 'probe';
}

export interface UdpDatagram {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  data: DhcpMessage | DnsMessage | ProbeData;
}

export type TcpFlag = 'SYN' | 'ACK' | 'FIN' | 'RST' | 'PSH';

/** A TCP segment. Application protocols here are text (HTTP, SMTP, POP3), carried in `data`. */
export interface TcpSegment {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  flags: TcpFlag[];
  seq: number;
  ack: number;
  data?: string;
}

export interface Ipv4Packet {
  kind: 'ipv4';
  src: Ip;
  dst: Ip;
  ttl: number;
  payload: IcmpPacket | UdpDatagram | TcpSegment;
}

/** Well-known TCP ports and the protocol name shown for them. */
export const TCP_SERVICES: Record<number, 'http' | 'smtp' | 'pop3' | 'ssh'> = {
  80: 'http',
  25: 'smtp',
  110: 'pop3',
  22: 'ssh',
};

function tcpFlags(flags: TcpFlag[]): string {
  const letters = flags
    .filter((f) => f !== 'ACK')
    .map((f) => ({ SYN: 'S', FIN: 'F', RST: 'R', PSH: 'P' })[f as 'SYN'])
    .join('');
  return `[${letters}${flags.includes('ACK') ? '.' : ''}]`;
}

function describeTcp(t: TcpSegment): string {
  const length = t.data?.length ?? 0;
  const seq = length > 0 ? `seq ${t.seq}:${t.seq + length}` : `seq ${t.seq}`;
  const ack = t.flags.includes('ACK') ? `, ack ${t.ack}` : '';
  const service = TCP_SERVICES[t.dstPort] ?? TCP_SERVICES[t.srcPort];
  const first = t.data?.split(/\r?\n/)[0]?.slice(0, 60);
  const app = length > 0 && service ? `: ${service.toUpperCase()}: ${first}` : '';
  return `Flags ${tcpFlags(t.flags)}, ${seq}${ack}, length ${length}${app}`;
}

export interface EthernetFrame {
  src: Mac;
  dst: Mac;
  payload: ArpPacket | Ipv4Packet;
}

function describeIcmp(p: Ipv4Packet, icmp: IcmpPacket): string {
  switch (icmp.type) {
    case 'echo-request':
    case 'echo-reply': {
      const what = icmp.type === 'echo-request' ? 'echo request' : 'echo reply';
      return `ICMP ${what}, id ${icmp.id}, seq ${icmp.seq}, ttl ${p.ttl}`;
    }
    case 'time-exceeded':
      return 'ICMP time exceeded in-transit';
    case 'dest-unreachable': {
      const o = icmp.original;
      if (icmp.code === 'port' && o.payload.kind === 'udp') {
        return `ICMP ${formatIp(o.dst)} udp port ${o.payload.dstPort} unreachable`;
      }
      return `ICMP ${icmp.code} ${formatIp(o.dst)} unreachable`;
    }
  }
}

function describeUdp(u: UdpDatagram): string {
  const d = u.data;
  if (d.app === 'dhcp') {
    const op = d.op[0]?.toUpperCase() + d.op.slice(1);
    const addr = d.yiaddr ? `, your-ip ${formatIp(d.yiaddr)}` : '';
    return `DHCP ${op}, xid 0x${d.xid.toString(16)}${addr}`;
  }
  if (d.app === 'dns') {
    if (d.qr === 'query') return `DNS A? ${d.name}.`;
    return d.answer ? `DNS ${d.name}. A ${formatIp(d.answer)}` : `DNS ${d.name}. NXDomain`;
  }
  return 'UDP, length 32';
}

/** One-line, tcpdump-like summary of a frame. */
export function describeFrame(frame: EthernetFrame): string {
  const p = frame.payload;
  if (p.kind === 'arp') {
    return p.op === 'request'
      ? `ARP, Request who-has ${formatIp(p.targetIp)} tell ${formatIp(p.senderIp)}`
      : `ARP, Reply ${formatIp(p.senderIp)} is-at ${p.senderMac}`;
  }
  if (p.payload.kind === 'icmp') {
    return `IP ${formatIp(p.src)} > ${formatIp(p.dst)}: ${describeIcmp(p, p.payload)}`;
  }
  const u = p.payload;
  const what = u.kind === 'udp' ? describeUdp(u) : describeTcp(u);
  return `IP ${formatIp(p.src)}.${u.srcPort} > ${formatIp(p.dst)}.${u.dstPort}: ${what}`;
}

export type Protocol =
  'arp' | 'icmp' | 'udp' | 'dhcp' | 'dns' | 'tcp' | 'http' | 'smtp' | 'pop3' | 'ssh';

/** Protocol label used to color packets in the UI. */
export function protocolOf(frame: EthernetFrame): Protocol {
  const p = frame.payload;
  if (p.kind === 'arp') return 'arp';
  if (p.payload.kind === 'icmp') return 'icmp';
  if (p.payload.kind === 'tcp') {
    const t = p.payload;
    return TCP_SERVICES[t.dstPort] ?? TCP_SERVICES[t.srcPort] ?? 'tcp';
  }
  const app = p.payload.data.app;
  return app === 'probe' ? 'udp' : app;
}
