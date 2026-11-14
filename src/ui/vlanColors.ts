import type { Bridge } from '../engine/bridge.ts';
import type { Port } from '../engine/port.ts';

/** The one place colour is spent: VLAN membership. Fixed so labs look the same everywhere. */
export const VLAN_PALETTE = ['#2F6FDE', '#C2377A', '#0E8F7E', '#D9731A', '#7A4FD3', '#7C8B1F'];

/** VLAN 1 is the default everywhere, so it gets no colour. */
export function vlanColor(vid: number): string | null {
  return vid <= 1 ? null : (VLAN_PALETTE[vid % VLAN_PALETTE.length] ?? null);
}

type BridgeVlans = Pick<Bridge, 'vlanFiltering' | 'vlans'>;

export type PortRole = { kind: 'access'; vid: number } | { kind: 'trunk'; vids: number[] } | null;

/** Access: untagged member of exactly one VLAN other than 1. Trunk: any other VLAN membership. */
export function portRole(bridge: BridgeVlans | null | undefined, port: Port): PortRole {
  if (!bridge?.vlanFiltering) return null;
  const v = bridge.vlans.get(port);
  if (!v) return null;
  const vids = [...v.vids].filter((vid) => vid > 1).sort((a, b) => a - b);
  const only = vids[0];
  if (vids.length === 1 && only !== undefined && v.untagged.has(only)) {
    return { kind: 'access', vid: only };
  }
  return vids.length > 0 ? { kind: 'trunk', vids } : null;
}

/** Every VLAN (above 1) that a filtering switch has on at least one port, ascending. */
export function vlansInUse(bridges: Iterable<BridgeVlans | null>): number[] {
  const used = new Set<number>();
  for (const b of bridges) {
    if (!b?.vlanFiltering) continue;
    for (const v of b.vlans.values()) for (const vid of v.vids) if (vid > 1) used.add(vid);
  }
  return [...used].sort((a, b) => a - b);
}
