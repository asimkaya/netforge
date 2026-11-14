/** Canvas items for teachers and big labs: layout-level data, not part of the network. */

export interface Note {
  /** `n1`, `n2`... */
  id: string;
  /** Top-left corner on the canvas. */
  x: number;
  y: number;
  /** Width in px; the height follows the text. */
  w: number;
  text: string;
}

export interface Zone {
  /** `z1`, `z2`... */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** Index into the four zone tints (`--nf-zone-1` to `--nf-zone-4`). */
  tint: number;
}

export const NOTE_ID = /^n[0-9]{1,9}$/;
export const ZONE_ID = /^z[0-9]{1,9}$/;

export const LIMITS = {
  noteWidth: { min: 100, max: 600, start: 200 },
  noteText: 2000,
  notes: 200,
  zoneWidth: { min: 120, max: 4000, start: 320 },
  zoneHeight: { min: 80, max: 4000, start: 200 },
  zoneTitle: 60,
  zones: 100,
  zoneTints: 4,
  /** Positions beyond this are rejected, so a damaged file cannot fling items out of reach. */
  coordinate: 100_000,
};

/** The next free `n1`, `z2`... id. */
export function freshId(prefix: 'n' | 'z', taken: readonly { id: string }[]): string {
  const used = new Set(taken.map((t) => t.id));
  let n = 0;
  while (used.has(`${prefix}${++n}`));
  return `${prefix}${n}`;
}

export const isAnnotationId = (id: string) => NOTE_ID.test(id) || ZONE_ID.test(id);
