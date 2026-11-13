import type { SpecId } from '../engine/specs.ts';
import type { Point } from './lab.ts';

/** Rough on-canvas size of each device's faceplate, with a margin, for placement. */
const FOOTPRINT: Record<SpecId, { w: number; h: number }> = {
  pc: { w: 180, h: 120 },
  server: { w: 180, h: 120 },
  switch: { w: 340, h: 100 },
  router: { w: 220, h: 100 },
};

interface Placed {
  spec: SpecId;
  at: Point;
}

function overlaps(a: Point, aSpec: SpecId, b: Placed): boolean {
  const sa = FOOTPRINT[aSpec];
  const sb = FOOTPRINT[b.spec];
  return a.x < b.at.x + sb.w && b.at.x < a.x + sa.w && a.y < b.at.y + sb.h && b.at.y < a.y + sa.h;
}

/**
 * A free spot for a new device near `center`: network gear on a row above the center, PCs
 * and servers on a row below, trying positions outward from the middle so devices never overlap.
 */
export function freeSpot(spec: SpecId, center: Point, placed: readonly Placed[]): Point {
  const size = FOOTPRINT[spec];
  const host = spec === 'pc' || spec === 'server';
  const baseY = host ? center.y + 30 : center.y - 190;
  const rowStep = host ? 140 : -120;
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 9; i++) {
      // 0, +1, -1, +2, -2, ... columns from the middle
      const col = i % 2 === 1 ? (i + 1) / 2 : -i / 2;
      const at = { x: center.x - size.w / 2 + col * (size.w + 10), y: baseY + row * rowStep };
      if (!placed.some((p) => overlaps(at, spec, p))) return at;
    }
  }
  return { x: center.x + placed.length * 20, y: center.y + placed.length * 20 };
}
