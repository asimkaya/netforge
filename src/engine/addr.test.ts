import { describe, expect, it } from 'vitest';
import {
  broadcastOf,
  formatCidr,
  formatIp,
  inSubnet,
  macFromIndex,
  maskOf,
  networkOf,
  parseCidr,
  parseIp,
} from './addr.ts';

describe('IPv4 helpers', () => {
  it('parses and formats addresses', () => {
    for (const text of ['0.0.0.0', '10.0.0.1', '192.168.1.254', '255.255.255.255']) {
      const ip = parseIp(text);
      expect(ip).not.toBeNull();
      expect(formatIp(ip ?? -1)).toBe(text);
    }
    expect(parseIp('255.255.255.255')).toBe(0xffffffff);
  });

  it('rejects malformed addresses', () => {
    for (const bad of [
      '',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.a',
      '1..2.3',
      ' 1.2.3.4',
      '1.2.3.-1',
    ]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  it('parses CIDR notation', () => {
    expect(parseCidr('192.168.1.10/24')).toEqual({ ip: parseIp('192.168.1.10'), prefix: 24 });
    expect(parseCidr('10.0.0.1')).toEqual({ ip: parseIp('10.0.0.1'), prefix: 32 });
    expect(parseCidr('10.0.0.1/33')).toBeNull();
    expect(parseCidr('10.0.0.1/')).toBeNull();
    expect(parseCidr('10.0.0.1/24/1')).toBeNull();
    expect(formatCidr({ ip: parseIp('10.1.2.3') ?? 0, prefix: 8 })).toBe('10.1.2.3/8');
  });

  it('computes masks, network and broadcast addresses', () => {
    expect(maskOf(0)).toBe(0);
    expect(maskOf(24)).toBe(0xffffff00);
    expect(maskOf(32)).toBe(0xffffffff);
    const cidr = parseCidr('192.168.1.130/25');
    if (!cidr) throw new Error('parse failed');
    expect(formatIp(networkOf(cidr))).toBe('192.168.1.128');
    expect(formatIp(broadcastOf(cidr))).toBe('192.168.1.255');
  });

  it('checks subnet membership', () => {
    const subnet = parseCidr('10.0.0.1/24');
    if (!subnet) throw new Error('parse failed');
    expect(inSubnet(parseIp('10.0.0.200') ?? 0, subnet)).toBe(true);
    expect(inSubnet(parseIp('10.0.1.1') ?? 0, subnet)).toBe(false);
  });
});

describe('macFromIndex', () => {
  it('builds unique locally administered MACs', () => {
    expect(macFromIndex(1)).toBe('02:00:00:00:00:01');
    expect(macFromIndex(0x01020304)).toBe('02:00:01:02:03:04');
  });
});
