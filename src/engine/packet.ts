import { formatIp, type Ip, type Mac } from './addr.ts';
import { formatCidr6, formatIp6, type Cidr6, type Ip6 } from './addr6.ts';

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

/** One link in an OSPF router LSA: to a neighbor router, or a network it serves. */
export type OspfLink =
  | { kind: 'router'; id: Ip; cost: number }
  | { kind: 'stub'; net: Ip; prefix: number; cost: number };

/** A router's description of its links, flooded to every OSPF router in the area. */
export interface OspfLsa {
  routerId: Ip;
  seq: number;
  links: OspfLink[];
}

/** OSPF (IP protocol 89): hellos find neighbors, link state updates flood LSAs. */
export type OspfPacket =
  | { kind: 'ospf'; type: 'hello'; routerId: Ip; area: number; neighbors: Ip[] }
  | { kind: 'ospf'; type: 'lsu'; routerId: Ip; area: number; lsas: OspfLsa[] };

export interface Ipv4Packet {
  kind: 'ipv4';
  src: Ip;
  dst: Ip;
  ttl: number;
  payload: IcmpPacket | UdpDatagram | TcpSegment | OspfPacket;
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

/** ICMPv6, including Neighbor Discovery (NDP) and router advertisements (SLAAC). */
export type Icmp6Packet =
  | { kind: 'icmp6'; type: 'echo-request' | 'echo-reply'; id: number; seq: number }
  | { kind: 'icmp6'; type: 'neighbor-solicitation'; target: Ip6 }
  | { kind: 'icmp6'; type: 'neighbor-advertisement'; target: Ip6; solicited: boolean }
  | { kind: 'icmp6'; type: 'router-solicitation' }
  | { kind: 'icmp6'; type: 'router-advertisement'; prefixes: Cidr6[]; lifetime: number }
  | { kind: 'icmp6'; type: 'time-exceeded'; original: Ipv6Packet }
  | {
      kind: 'icmp6';
      type: 'dest-unreachable';
      code: 'route' | 'address' | 'port';
      original: Ipv6Packet;
    };

export interface Ipv6Packet {
  kind: 'ipv6';
  src: Ip6;
  dst: Ip6;
  hopLimit: number;
  payload: Icmp6Packet;
}

/** Destination MAC of Spanning Tree BPDUs (the 802.1D bridge group address). */
export const STP_MAC = '01:80:c2:00:00:00';

/** A Spanning Tree configuration BPDU. */
export interface BpduPacket {
  kind: 'bpdu';
  rootId: string;
  rootCost: number;
  bridgeId: string;
  portId: number;
  /** Set while announcing a topology change; the id lets bridges pass it on once. */
  tc?: string;
}

export interface EthernetFrame {
  src: Mac;
  dst: Mac;
  /** 802.1Q tag: the VLAN id on trunk links; absent on untagged frames. */
  vlan?: number;
  payload: ArpPacket | Ipv4Packet | Ipv6Packet | BpduPacket;
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

/** The frame without its 802.1Q tag. */
export function untagged(frame: EthernetFrame): EthernetFrame {
  const copy = { ...frame };
  delete copy.vlan;
  return copy;
}

/** One-line, tcpdump-like summary of a frame; tagged frames start with their VLAN. */
export function describeFrame(frame: EthernetFrame): string {
  const text = describePayload(frame);
  return frame.vlan === undefined ? text : `vlan ${frame.vlan}, ${text}`;
}

function describeIcmp6(p: Ipv6Packet): string {
  const m = p.payload;
  switch (m.type) {
    case 'echo-request':
    case 'echo-reply':
      return `ICMP6, echo ${m.type === 'echo-request' ? 'request' : 'reply'}, id ${m.id}, seq ${m.seq}, length 64`;
    case 'neighbor-solicitation':
      return `ICMP6, neighbor solicitation, who has ${formatIp6(m.target)}, length 32`;
    case 'neighbor-advertisement':
      return `ICMP6, neighbor advertisement, tgt is ${formatIp6(m.target)}, length 32`;
    case 'router-solicitation':
      return 'ICMP6, router solicitation, length 16';
    case 'router-advertisement':
      return `ICMP6, router advertisement, length ${16 + 32 * m.prefixes.length}${m.prefixes.length ? `, prefix ${m.prefixes.map(formatCidr6).join(' ')}` : ''}`;
    case 'time-exceeded':
      return 'ICMP6, time exceeded in-transit';
    case 'dest-unreachable':
      return `ICMP6, destination unreachable, unreachable ${m.code} ${formatIp6(m.original.dst)}`;
  }
}

function describePayload(frame: EthernetFrame): string {
  const p = frame.payload;
  if (p.kind === 'ipv6') {
    return `IP6 ${formatIp6(p.src)} > ${formatIp6(p.dst)}: ${describeIcmp6(p)}`;
  }
  if (p.kind === 'bpdu') {
    const flags = p.tc ? 'Topology change' : 'none';
    return `STP 802.1d, Config, Flags [${flags}], bridge-id ${p.bridgeId}.${p.portId.toString(16)}, length 35`;
  }
  if (p.kind === 'arp') {
    return p.op === 'request'
      ? `ARP, Request who-has ${formatIp(p.targetIp)} tell ${formatIp(p.senderIp)}`
      : `ARP, Reply ${formatIp(p.senderIp)} is-at ${p.senderMac}`;
  }
  if (p.payload.kind === 'icmp') {
    return `IP ${formatIp(p.src)} > ${formatIp(p.dst)}: ${describeIcmp(p, p.payload)}`;
  }
  if (p.payload.kind === 'ospf') {
    const o = p.payload;
    const what = o.type === 'hello' ? 'Hello' : 'LS-Update';
    const length = o.type === 'hello' ? 44 : 24 + 36 * o.lsas.length;
    return `IP ${formatIp(p.src)} > ${formatIp(p.dst)}: OSPFv2, ${what}, length ${length}`;
  }
  const u = p.payload;
  const what = u.kind === 'udp' ? describeUdp(u) : describeTcp(u);
  return `IP ${formatIp(p.src)}.${u.srcPort} > ${formatIp(p.dst)}.${u.dstPort}: ${what}`;
}

export type Protocol =
  | 'arp'
  | 'stp'
  | 'icmp'
  | 'icmp6'
  | 'ospf'
  | 'udp'
  | 'dhcp'
  | 'dns'
  | 'tcp'
  | 'http'
  | 'smtp'
  | 'pop3'
  | 'ssh';

/** Protocol label used to color packets in the UI. */
export function protocolOf(frame: EthernetFrame): Protocol {
  const p = frame.payload;
  if (p.kind === 'arp') return 'arp';
  if (p.kind === 'bpdu') return 'stp';
  if (p.kind === 'ipv6') return 'icmp6';
  if (p.payload.kind === 'icmp') return 'icmp';
  if (p.payload.kind === 'ospf') return 'ospf';
  if (p.payload.kind === 'tcp') {
    const t = p.payload;
    return TCP_SERVICES[t.dstPort] ?? TCP_SERVICES[t.srcPort] ?? 'tcp';
  }
  const app = p.payload.data.app;
  return app === 'probe' ? 'udp' : app;
}
