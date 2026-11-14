import type { SpecId } from '../engine/specs.ts';
import type { Point } from './lab.ts';

/** Rough on-canvas size of each device's faceplate, with a margin, for placement. */
export const FOOTPRINT: Record<SpecId, { w: number; h: number }> = {
  pc: { w: 180, h: 120 },
  laptop: { w: 180, h: 120 },
  phone: { w: 120, h: 120 },
  server: { w: 180, h: 120 },
  ap: { w: 160, h: 110 },
  printer: { w: 180, h: 120 },
  camera: { w: 180, h: 120 },
  switch: { w: 340, h: 100 },
  switch24: { w: 470, h: 140 },
  l3switch: { w: 470, h: 140 },
  router: { w: 220, h: 100 },
  homerouter: { w: 200, h: 120 },
  internet: { w: 220, h: 100 },
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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rectangle that holds all the given rectangles, for fitting the view to them. */
export function boundsOfRects(rects: readonly Rect[]) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.w)) - x,
    height: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/** The rectangle that holds all the given devices, for fitting the view to them. */
export function boundsOf(placed: readonly Placed[]) {
  return boundsOfRects(placed.map((p) => ({ ...p.at, ...FOOTPRINT[p.spec] })));
}

/**
 * A free spot for a note or zone of this size near `center`: the closest grid position that
 * overlaps none of `taken`, preferring spots to the right of or below the existing content.
 */
export function freeRect(size: { w: number; h: number }, center: Point, taken: readonly Rect[]) {
  const gap = 20;
  const step = 40;
  let best: Point | null = null;
  let bestCost = Infinity;
  for (let dy = -1200; dy <= 1200; dy += step) {
    for (let dx = -1200; dx <= 1200; dx += step) {
      const cost = Math.abs(dx) * (dx < 0 ? 2 : 1) + Math.abs(dy) * (dy < 0 ? 2 : 1);
      if (cost >= bestCost) continue;
      const x = center.x - size.w / 2 + dx;
      const y = center.y - size.h / 2 + dy;
      const hit = taken.some(
        (r) =>
          x < r.x + r.w + gap &&
          r.x < x + size.w + gap &&
          y < r.y + r.h + gap &&
          r.y < y + size.h + gap,
      );
      if (!hit) {
        best = { x, y };
        bestCost = cost;
      }
    }
  }
  return best ?? { x: center.x, y: center.y + 1300 };
}

/**
 * A free spot for a new device near `center`: network gear on a row above the center, PCs
 * and servers on a row below, trying positions outward from the middle so devices never overlap.
 */
export function freeSpot(spec: SpecId, center: Point, placed: readonly Placed[]): Point {
  const size = FOOTPRINT[spec];
  const host =
    spec === 'pc' ||
    spec === 'server' ||
    spec === 'laptop' ||
    spec === 'phone' ||
    spec === 'printer' ||
    spec === 'camera';
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
