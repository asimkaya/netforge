/** IPv4 address as an unsigned 32-bit integer. */
export type Ip = number;
/** MAC address in canonical lowercase colon form, e.g. `02:00:00:00:00:01`. */
export type Mac = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';

export function parseIp(text: string): Ip | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let ip = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    ip = ip * 256 + octet;
  }
  return ip;
}

export function formatIp(ip: Ip): string {
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}

export interface Cidr {
  ip: Ip;
  prefix: number;
}

/** Parses `a.b.c.d/n`. A missing prefix means /32, like `ip addr add`. */
export function parseCidr(text: string): Cidr | null {
  const [ipText, prefixText, extra] = text.split('/');
  if (ipText === undefined || extra !== undefined) return null;
  const ip = parseIp(ipText);
  if (ip === null) return null;
  if (prefixText === undefined) return { ip, prefix: 32 };
  if (!/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= 32 ? { ip, prefix } : null;
}

export function formatCidr({ ip, prefix }: Cidr): string {
  return `${formatIp(ip)}/${prefix}`;
}

export function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function networkOf({ ip, prefix }: Cidr): Ip {
  return (ip & maskOf(prefix)) >>> 0;
}

export function broadcastOf({ ip, prefix }: Cidr): Ip {
  return (ip | ~maskOf(prefix)) >>> 0;
}

export function inSubnet(ip: Ip, subnet: Cidr): boolean {
  return networkOf({ ip, prefix: subnet.prefix }) === networkOf(subnet);
}

/** Deterministic, locally administered MAC from a counter. */
export function macFromIndex(index: number): Mac {
  const bytes = [
    0x02,
    0,
    (index >>> 24) & 255,
    (index >>> 16) & 255,
    (index >>> 8) & 255,
    index & 255,
  ];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}
