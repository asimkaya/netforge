import type { Mac } from './addr.ts';

/** An IPv6 address as a 128-bit number. */
export type Ip6 = bigint;

export interface Cidr6 {
  ip: Ip6;
  prefix: number;
}

const ALL = (1n << 128n) - 1n;

/** Parses `2001:db8::1` (no embedded IPv4, no zone). */
export function parseIp6(text: string): Ip6 | null {
  if (!/^[0-9a-fA-F:]+$/.test(text) || text.includes(':::')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run of zero groups as `::`. */
export function formatIp6(ip: Ip6): string {
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((ip >> BigInt(112 - 16 * i)) & 0xffffn),
  );
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len && j - i >= 2) best = { start: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.start < 0) return hex.join(':');
  const left = hex.slice(0, best.start).join(':');
  const right = hex.slice(best.start + best.len).join(':');
  return `${left}::${right}`;
}

/** Parses `2001:db8::1/64`; a missing prefix means /128. */
export function parseCidr6(text: string): Cidr6 | null {
  const [ipText, prefixText, extra] = text.split('/');
  if (ipText === undefined || extra !== undefined) return null;
  const ip = parseIp6(ipText);
  if (ip === null) return null;
  if (prefixText === undefined) return { ip, prefix: 128 };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= 128 ? { ip, prefix } : null;
}

export function formatCidr6({ ip, prefix }: Cidr6): string {
  return `${formatIp6(ip)}/${prefix}`;
}

function mask6(prefix: number): Ip6 {
  return prefix === 0 ? 0n : (ALL << BigInt(128 - prefix)) & ALL;
}

export function networkOf6({ ip, prefix }: Cidr6): Ip6 {
  return ip & mask6(prefix);
}

export function inSubnet6(ip: Ip6, subnet: Cidr6): boolean {
  return networkOf6({ ip, prefix: subnet.prefix }) === networkOf6(subnet);
}

/** fe80::/10 */
export function isLinkLocal(ip: Ip6): boolean {
  return ip >> 118n === 0x3fan;
}

export function isMulticast6(ip: Ip6): boolean {
  return ip >> 120n === 0xffn;
}

export const ALL_NODES: Ip6 = (0xff02n << 112n) | 1n;
export const ALL_ROUTERS: Ip6 = (0xff02n << 112n) | 2n;
export const LINK_LOCAL_PREFIX: Ip6 = 0xfe80n << 112n;

/** Modified EUI-64 interface id from a MAC: flip the U/L bit and put ff:fe in the middle. */
export function eui64(mac: Mac): Ip6 {
  const b = mac.split(':').map((x) => parseInt(x, 16));
  const bytes = [(b[0] ?? 0) ^ 2, b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]];
  return bytes.reduce<bigint>((v, x) => (v << 8n) | BigInt(x ?? 0), 0n);
}

/** The solicited-node multicast group NDP asks on: ff02::1:ffXX:XXXX. */
export function solicitedNode(ip: Ip6): Ip6 {
  return (0xff02n << 112n) | (0x1ffn << 24n) | (ip & 0xffffffn);
}

/** Ethernet MAC of an IPv6 multicast group: 33:33 and the group's last 32 bits. */
export function multicastMac(ip: Ip6): Mac {
  const low = Number(ip & 0xffffffffn);
  const bytes = [0x33, 0x33, low >>> 24, (low >>> 16) & 255, (low >>> 8) & 255, low & 255];
  return bytes.map((x) => x.toString(16).padStart(2, '0')).join(':');
}
