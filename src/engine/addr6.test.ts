import { describe, expect, it } from 'vitest';
import {
  eui64,
  formatCidr6,
  formatIp6,
  inSubnet6,
  isLinkLocal,
  multicastMac,
  parseCidr6,
  parseIp6,
  solicitedNode,
} from './addr6.ts';

describe('IPv6 addresses', () => {
  it.each([
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::', '::'],
    ['::1', '::1'],
    ['fe80::', 'fe80::'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
  ])('%s prints as %s', (text, shown) => {
    const ip = parseIp6(text);
    expect(ip).not.toBeNull();
    expect(formatIp6(ip ?? 0n)).toBe(shown);
  });

  it.each(['1::2::3', '12345::', '1:2:3:4:5:6:7:8:9', ':::', 'g::1', '1:2:3:4:5:6:7', ''])(
    'rejects %s',
    (text) => expect(parseIp6(text)).toBeNull(),
  );

  it('handles prefixes, link-local, EUI-64 and NDP multicast', () => {
    const net = parseCidr6('2001:db8:1::/64');
    expect(net && formatCidr6(net)).toBe('2001:db8:1::/64');
    expect(inSubnet6(parseIp6('2001:db8:1::abcd') ?? 0n, net ?? { ip: 0n, prefix: 128 })).toBe(
      true,
    );
    expect(inSubnet6(parseIp6('2001:db8:2::1') ?? 0n, net ?? { ip: 0n, prefix: 128 })).toBe(false);
    expect(parseCidr6('::/129')).toBeNull();
    expect(isLinkLocal(parseIp6('fe80::1') ?? 0n)).toBe(true);
    expect(isLinkLocal(parseIp6('2001:db8::1') ?? 0n)).toBe(false);
    expect(formatIp6((0xfe80n << 112n) | eui64('02:00:00:00:00:05'))).toBe('fe80::ff:fe00:5');
    const target = parseIp6('2001:db8::12:3456') ?? 0n;
    expect(formatIp6(solicitedNode(target))).toBe('ff02::1:ff12:3456');
    expect(multicastMac(solicitedNode(target))).toBe('33:33:ff:12:34:56');
  });
});
