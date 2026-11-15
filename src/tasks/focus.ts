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

/**
 * Works out what a step is about from its words: "Add two PCs" points at the PC in the
 * palette, "Open the router" at the routers on the canvas, "ping from pc1" at pc1.
 * shortcut: reads the text, so custom tasks get highlights for free; give TaskStep an
 * explicit target if a step ever needs one its words do not name.
 */
export function focusOf(step: Pick<TaskStep, 'title' | 'detail' | 'parts'>, net: Network): Focus {
  let text = `${step.title} ${step.detail} ${(step.parts ?? []).map((p) => `${p.text} ${p.on ?? ''}`).join(' ')}`;
  const mentioned: SpecId[] = [];
  // Longest label first, so "Home Router" is not also read as "Router".
  const specs = Object.values(SPECS).sort((a, b) => b.label.length - a.label.length);
  for (const spec of specs) {
    const pattern = new RegExp(`\\b${spec.label}s?\\b`, 'gi');
    if (!pattern.test(text)) continue;
    mentioned.push(spec.id);
    text = text.replace(pattern, ' ');
  }
  const devices = [...net.devices.values()];
  const adding = /^(add|drag|place|put)\b/i.test(step.title);
  const named = devices.filter((d) => new RegExp(`\\b${d.name}\\b`).test(text));
  return {
    palette: mentioned.filter((id) => adding || !devices.some((d) => d.spec.id === id)),
    devices: [
      ...new Set([
        ...named.map((d) => d.id),
        ...(adding ? [] : devices.filter((d) => mentioned.includes(d.spec.id)).map((d) => d.id)),
      ]),
    ],
  };
}
