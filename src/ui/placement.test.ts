import { describe, expect, it } from 'vitest';
import type { SpecId } from '../engine/specs.ts';
import { FOOTPRINT, freeSpot } from './placement.ts';

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
