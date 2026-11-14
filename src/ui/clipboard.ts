import { macFromIndex } from '../engine/addr.ts';
import { Network, type NetworkSnapshot } from '../engine/network.ts';
import { SPECS } from '../engine/specs.ts';
import { replaceLab } from './history.ts';
import { getLab, notify, setSelection, type Point } from './lab.ts';
import type { Project } from './project.ts';

/** Copied devices, the cables between them, and where they sit. */
export interface Clip {
  devices: NetworkSnapshot['devices'];
  links: NetworkSnapshot['links'];
  layout: Record<string, Point>;
}

/** Pasted copies move this far from the originals (per paste, so copies never hide each other). */
export const PASTE_OFFSET = 40;

/**
 * Takes the selected devices from the network's own snapshot, so everything the save format
 * stores for a device is copied. Cables to devices outside the selection are left out.
 */
export function copyOf(net: Network, layout: Record<string, Point>, ids: readonly string[]): Clip {
  const snapshot = structuredClone(net.toJSON());
  const chosen = new Set(ids);
  return {
    devices: snapshot.devices.filter((d) => chosen.has(d.id)),
    links: snapshot.links.filter((l) => chosen.has(l.a.device) && chosen.has(l.b.device)),
    layout: Object.fromEntries(Object.entries(layout).filter(([id]) => chosen.has(id))),
  };
}

/**
 * The lab with a copy of `clip` added: fresh ids, the next free names, fresh MAC addresses
 * and the copied cables between the copies. Everything else is kept as copied: addresses,
 * routes, VLANs, services and files, including text that mentions the old name or MAC.
 * Returns the new lab and the ids of the new devices.
 */
export function paste(
  current: Project,
  clip: Clip,
  offset: number,
): { project: Project; ids: string[] } {
  const snapshot = current.net.toJSON();
  const { counters } = snapshot;
  const ids = new Set([...snapshot.devices.map((d) => d.id), ...snapshot.links.map((l) => l.id)]);
  const names = new Set(snapshot.devices.map((d) => d.name));
  const fresh = (prefix: 'd' | 'l') => {
    const key = prefix === 'd' ? 'device' : 'link';
    let id: string;
    do id = `${prefix}${++counters[key]}`;
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const renamed = new Map<string, string>();
  const devices = structuredClone(clip.devices).map((d) => {
    const id = fresh('d');
    renamed.set(d.id, id);
    const prefix = SPECS[d.spec].namePrefix;
    let name: string;
    do name = `${prefix}${(counters.names[prefix] = (counters.names[prefix] ?? 0) + 1)}`;
    while (names.has(name));
    names.add(name);
    return {
      ...d,
      id,
      name,
      ports: d.ports.map((p) => ({ ...p, mac: macFromIndex(++counters.mac) })),
    };
  });
  const links = clip.links.map((l) => ({
    id: fresh('l'),
    a: { ...l.a, device: renamed.get(l.a.device) ?? l.a.device },
    b: { ...l.b, device: renamed.get(l.b.device) ?? l.b.device },
  }));
  const net = Network.fromJSON({
    devices: [...snapshot.devices, ...devices],
    links: [...snapshot.links, ...links],
    counters,
  });
  const layout = { ...current.layout };
  for (const [old, id] of renamed) {
    const at = clip.layout[old] ?? { x: 0, y: 0 };
    layout[id] = { x: at.x + offset, y: at.y + offset };
  }
  return { project: { ...current, net, layout }, ids: [...renamed.values()] };
}

let clipboard: Clip | null = null;
let pastes = 0;

/** Copies the selected devices (the clipboard lives in memory, not in the system clipboard). */
export function copySelection(ids = getLab().selection): boolean {
  const { net, layout } = getLab();
  const chosen = ids.filter((id) => net.devices.has(id));
  if (chosen.length === 0) return false;
  clipboard = copyOf(net, layout, chosen);
  pastes = 0;
  return true;
}

/** Pastes the clipboard as one undo step and selects the copies. */
export function pasteClipboard(): boolean {
  if (!clipboard) return false;
  const { net, layout, tasks } = getLab();
  try {
    const result = paste({ net, layout, tasks }, clipboard, PASTE_OFFSET * ++pastes);
    replaceLab(result.project);
    setSelection(result.ids);
    return true;
  } catch (error) {
    notify(`Could not paste: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Copy and paste in one go: the selection if `id` is part of it, else just that device. */
export function duplicate(id: string): void {
  const { selection } = getLab();
  if (copySelection(selection.includes(id) ? selection : [id])) pasteClipboard();
}
