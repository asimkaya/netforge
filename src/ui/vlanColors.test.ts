import { describe, expect, it } from 'vitest';
import type { PortVlans } from '../engine/bridge.ts';
import type { Port } from '../engine/port.ts';
import { portRole, vlanColor, vlansInUse, VLAN_PALETTE } from './vlanColors.ts';

const port = {} as Port;
const vl = (vids: number[], untagged: number[], pvid: number | null = null): PortVlans => ({
  vids: new Set(vids),
  untagged: new Set(untagged),
  pvid,
});
const bridge = (v: PortVlans, vlanFiltering = true) => ({
  vlanFiltering,
  vlans: new Map([[port, v]]),
});

describe('vlan colours', () => {
  it('maps a vid to palette[vid % 6] and gives VLAN 1 none', () => {
    expect(vlanColor(1)).toBeNull();
    expect(vlanColor(10)).toBe(VLAN_PALETTE[4]);
    expect(vlanColor(12)).toBe(VLAN_PALETTE[0]);
  });

  it('classifies access and trunk ports', () => {
    expect(portRole(bridge(vl([10], [10], 10)), port)).toEqual({ kind: 'access', vid: 10 });
    expect(portRole(bridge(vl([1, 10], [10], 10)), port)).toEqual({ kind: 'access', vid: 10 });
    expect(portRole(bridge(vl([1, 10, 20], [1])), port)).toEqual({ kind: 'trunk', vids: [10, 20] });
    expect(portRole(bridge(vl([10], [])), port)).toEqual({ kind: 'trunk', vids: [10] });
    expect(portRole(bridge(vl([1], [1], 1)), port)).toBeNull();
  });

  it('ignores switches with VLAN filtering off', () => {
    const off = bridge(vl([10], [10], 10), false);
    expect(portRole(off, port)).toBeNull();
    expect(vlansInUse([off])).toEqual([]);
  });

  it('lists the VLANs in use', () => {
    expect(vlansInUse([bridge(vl([1, 20, 10], [1])), null])).toEqual([10, 20]);
  });
});
