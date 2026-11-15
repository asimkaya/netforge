import type { Network } from '../engine/network.ts';
import { SPECS, type SpecId } from '../engine/specs.ts';
import type { TaskStep } from './tasks.ts';

/** What the UI should point at for a task step. */
export interface Focus {
  /** Device kinds to highlight in the palette (the step asks to add them). */
  palette: SpecId[];
  /** Ids of devices on the canvas to highlight (the step asks to open or cable them). */
  devices: string[];
}

/** Device kinds named in `text` (longest label first, so "Home Router" is not also "Router"). */
function kindsIn(text: string): { kinds: SpecId[]; rest: string } {
  const found: SpecId[] = [];
  for (const spec of Object.values(SPECS).sort((a, b) => b.label.length - a.label.length)) {
    const pattern = new RegExp(`\\b${spec.label}s?\\b`, 'gi');
    if (!pattern.test(text)) continue;
    found.push(spec.id);
    text = text.replace(pattern, ' ');
  }
  return { kinds: found, rest: text };
}

/**
 * Works out what a step is about from its words: "Add two PCs" points at the PC in the
 * palette, "Open the router" at the routers on the canvas, "ping from pc1" at pc1.
 * Only steps that add devices (a title starting with add, drag, place, plug or bring)
 * touch the palette, and only for the kinds their title names, so "Config → DHCP and DNS
 * server" in a later step never makes the Server item blink.
 * shortcut: reads the text, so custom tasks get highlights for free; give TaskStep an
 * explicit target if a step ever needs one its words do not name.
 */
export function focusOf(step: Pick<TaskStep, 'title' | 'detail' | 'parts'>, net: Network): Focus {
  const text = `${step.title} ${step.detail} ${(step.parts ?? []).map((p) => `${p.text} ${p.on ?? ''}`).join(' ')}`;
  const { kinds: mentioned, rest } = kindsIn(text);
  const devices = [...net.devices.values()];
  const adding = /^(add|drag|place|plug|bring)\b/i.test(step.title);
  const named = devices.filter((d) => new RegExp(`\\b${d.name}\\b`).test(rest));
  return {
    palette: adding ? kindsIn(step.title).kinds : [],
    devices: [
      ...new Set([
        ...named.map((d) => d.id),
        ...(adding ? [] : devices.filter((d) => mentioned.includes(d.spec.id)).map((d) => d.id)),
      ]),
    ],
  };
}
