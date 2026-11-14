import { describe, expect, it } from 'vitest';
import type { SpecId } from '../engine/specs.ts';
import { FOOTPRINT, freeRect, freeSpot } from './placement.ts';

describe('freeRect', () => {
  const devices = [
    { x: -110, y: -60, w: 220, h: 100 },
    { x: -235, y: 90, w: 470, h: 140 },
    { x: -300, y: -200, w: 180, h: 120 },
  ];

  it('keeps a note and a zone clear of devices in the middle', () => {
    for (const size of [
      { w: 200, h: 80 },
      { w: 320, h: 200 },
    ]) {
      const at = freeRect(size, { x: 0, y: 0 }, devices);
      const hit = devices.some(
        (r) => at.x < r.x + r.w && r.x < at.x + size.w && at.y < r.y + r.h && r.y < at.y + size.h,
      );
      expect(hit).toBe(false);
    }
  });

  it('uses the center when the canvas is empty', () => {
    expect(freeRect({ w: 320, h: 200 }, { x: 500, y: 300 }, [])).toEqual({ x: 340, y: 200 });
  });
});

describe('freeSpot', () => {
  it('puts gear above the center and PCs below, never overlapping', () => {
    const placed: { spec: SpecId; at: { x: number; y: number } }[] = [];
    const order: SpecId[] = ['router', 'switch', 'pc', 'server', 'ap', 'laptop', 'phone', 'router'];
    for (const spec of order) placed.push({ spec, at: freeSpot(spec, { x: 0, y: 0 }, placed) });
    expect(placed[0]?.at.y).toBeLessThan(0);
    expect(placed[2]?.at.y).toBeGreaterThan(0);
    for (const [i, a] of placed.entries()) {
      for (const b of placed.slice(i + 1)) {
        const { w: aw, h: ah } = FOOTPRINT[a.spec];
        const { w: bw, h: bh } = FOOTPRINT[b.spec];
        const apart =
          a.at.x + aw <= b.at.x ||
          b.at.x + bw <= a.at.x ||
          a.at.y + ah <= b.at.y ||
          b.at.y + bh <= a.at.y;
        expect(apart).toBe(true);
      }
    }
  });
});
