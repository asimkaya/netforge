import { describe, expect, it } from 'vitest';
import type { SpecId } from '../engine/specs.ts';
import { freeSpot } from './placement.ts';

describe('freeSpot', () => {
  it('puts gear above the center and PCs below, never overlapping', () => {
    const placed: { spec: SpecId; at: { x: number; y: number } }[] = [];
    const order: SpecId[] = ['router', 'switch', 'pc', 'server', 'pc', 'switch', 'pc', 'router'];
    for (const spec of order) placed.push({ spec, at: freeSpot(spec, { x: 0, y: 0 }, placed) });
    expect(placed[0]?.at.y).toBeLessThan(0);
    expect(placed[2]?.at.y).toBeGreaterThan(0);
    const size = {
      pc: [180, 120],
      server: [180, 120],
      switch: [340, 100],
      router: [220, 100],
      internet: [220, 100],
    } as const;
    for (const [i, a] of placed.entries()) {
      for (const b of placed.slice(i + 1)) {
        const [aw, ah] = size[a.spec];
        const [bw, bh] = size[b.spec];
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
