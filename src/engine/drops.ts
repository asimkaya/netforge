import { formatIp } from './addr.ts';
import { formatIp6 } from './addr6.ts';
import type { ArpPacket, Ipv4Packet, Ipv6Packet } from './packet.ts';

/**
 * A record of every place the engine discards a frame or packet, with the facts needed to
 * explain it later (see explain.ts). Recording is passive: it never changes what happens.
 */

/** Why a packet or frame died, with the details of that reason. */
export type DropWhy =
  | { reason: 'no-route'; forwarded: boolean }
  /** The interface a route needs has no carrier: turned off, no cable, or the far end is off. */
  | { reason: 'link-down'; cause: 'admin-down' | 'no-cable' | 'peer-down' }
  | { reason: 'forwarding-off' }
  | { reason: 'ttl-expired' }
  | { reason: 'arp-failed'; nextHop: string }
  /** A firewall verdict. `rule` is the handle of the deciding rule, or null for the policy. */
  | {
      reason: 'netfilter';
      verdict: 'drop' | 'reject';
      hook: string;
      family: string;
      table: string;
      chain: string;
      rule: number | null;
    }
  | { reason: 'no-listener' }
  | { reason: 'vlan-ingress'; vid: number | null; pvid: number | null; vids: number[] }
  /** The frame found no way out in its VLAN; `others` are the ports it could not use. */
  | { reason: 'vlan-egress'; vid: number; others: { port: string; vids: number[] }[] }
  | { reason: 'stp-not-forwarding'; state: string; role: string }
  | {
      reason: 'wg-no-peer' | 'wg-no-endpoint' | 'wg-unknown-peer' | 'wg-allowed-ips';
      iface: string;
    }
  | { reason: 'wifi-out-of-range'; ssid: string }
  | {
      reason: 'dns-nxdomain' | 'dns-no-server' | 'dns-timeout' | 'dns-refused';
      name: string;
      server: string | null;
    };

export type DropReason = DropWhy['reason'];

/** What a discarded packet was, in words that do not depend on the packet's layers. */
export interface PacketSummary {
  family: 4 | 6;
  proto: 'icmp' | 'tcp' | 'udp' | 'arp' | 'ospf';
  src: string;
  dst: string;
  srcPort?: number;
  dstPort?: number;
  /** ICMP type, ARP operation, or TCP flags. */
  what?: string;
}

export type Drop = {
  seq: number;
  /** Virtual time of the drop, in ms. */
  time: number;
  /** Device id. */
  device: string;
  /** Interface or port where it happened, when there is one. */
  port: string | null;
  packet: PacketSummary | null;
} & DropWhy;

/** Fits at least a few long pings through a lab; older drops fall off. */
export const DROP_LIMIT = 500;

export function summarize(p: Ipv4Packet | Ipv6Packet | ArpPacket): PacketSummary {
  if (p.kind === 'arp') {
    return {
      family: 4,
      proto: 'arp',
      src: formatIp(p.senderIp),
      dst: formatIp(p.targetIp),
      what: p.op,
    };
  }
  if (p.kind === 'ipv6') {
    return {
      family: 6,
      proto: 'icmp',
      src: formatIp6(p.src),
      dst: formatIp6(p.dst),
      what: p.payload.type,
    };
  }
  const base = { family: 4 as const, src: formatIp(p.src), dst: formatIp(p.dst) };
  const l4 = p.payload;
  switch (l4.kind) {
    case 'icmp':
      return { ...base, proto: 'icmp', what: l4.type };
    case 'tcp':
      return {
        ...base,
        proto: 'tcp',
        srcPort: l4.srcPort,
        dstPort: l4.dstPort,
        what: l4.flags.join('+'),
      };
    case 'udp':
      return { ...base, proto: 'udp', srcPort: l4.srcPort, dstPort: l4.dstPort };
    case 'ospf':
      return { ...base, proto: 'ospf', what: l4.type };
  }
}
