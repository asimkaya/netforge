import { formatIp, type Ip, type Mac } from './addr.ts';

export interface ArpPacket {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: Mac;
  senderIp: Ip;
  targetMac: Mac;
  targetIp: Ip;
}

export type IcmpType = 'echo-request' | 'echo-reply';

export interface IcmpPacket {
  kind: 'icmp';
  type: IcmpType;
  id: number;
  seq: number;
}

export interface Ipv4Packet {
  kind: 'ipv4';
  src: Ip;
  dst: Ip;
  ttl: number;
  payload: IcmpPacket;
}

export interface EthernetFrame {
  src: Mac;
  dst: Mac;
  payload: ArpPacket | Ipv4Packet;
}

/** One-line, tcpdump-like summary of a frame. */
export function describeFrame(frame: EthernetFrame): string {
  const p = frame.payload;
  if (p.kind === 'arp') {
    return p.op === 'request'
      ? `ARP, Request who-has ${formatIp(p.targetIp)} tell ${formatIp(p.senderIp)}`
      : `ARP, Reply ${formatIp(p.senderIp)} is-at ${p.senderMac}`;
  }
  const icmp = p.payload;
  const what = icmp.type === 'echo-request' ? 'echo request' : 'echo reply';
  return `IP ${formatIp(p.src)} > ${formatIp(p.dst)}: ICMP ${what}, id ${icmp.id}, seq ${icmp.seq}, ttl ${p.ttl}`;
}

/** Protocol label used to color packets in the UI. */
export function protocolOf(frame: EthernetFrame): 'arp' | 'icmp' {
  return frame.payload.kind === 'arp' ? 'arp' : 'icmp';
}
