import { useEffect } from 'react';
import type { Network } from '../engine/network.ts';
import type { Mode } from './lab.ts';

/** Longest wall-clock gap (ms) simulated in one frame, e.g. after a background tab. */
const MAX_FRAME_MS = 100;

/**
 * In realtime mode, advances virtual time in step with the wall clock.
 * shortcut: the engine runs on the main thread; move it to a Web Worker when large labs make the UI stutter.
 */
export function useRealtimeClock(net: Network, mode: Mode): void {
  useEffect(() => {
    if (mode !== 'realtime') return;
    let last = performance.now();
    let frame = requestAnimationFrame(function loop(now) {
      const dt = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      net.scheduler.runUntil(net.scheduler.now + dt);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [net, mode]);
}

/**
 * Runs events until the next frame is delivered on a cable (or nothing is left).
 * Returns false when the simulation has no pending events.
 */
export function stepToNextFrame(net: Network): boolean {
  const before = net.trace.at(-1)?.seq ?? 0;
  for (let i = 0; i < 10_000; i++) {
    if (!net.scheduler.step()) return false;
    if ((net.trace.at(-1)?.seq ?? 0) !== before) return true;
  }
  return true;
}
