import { describe, expect, it } from 'vitest';
import { Scheduler } from './scheduler.ts';

describe('Scheduler', () => {
  it('runs events in time order and advances the clock', () => {
    const s = new Scheduler();
    const log: string[] = [];
    s.schedule(30, () => log.push(`c@${s.now}`));
    s.schedule(10, () => log.push(`a@${s.now}`));
    s.schedule(20, () => log.push(`b@${s.now}`));
    while (s.step());
    expect(log).toEqual(['a@10', 'b@20', 'c@30']);
  });

  it('keeps FIFO order for events at the same time', () => {
    const s = new Scheduler();
    const log: number[] = [];
    for (let i = 0; i < 50; i++) s.schedule(5, () => log.push(i));
    while (s.step());
    expect(log).toEqual([...Array(50).keys()]);
  });

  it('schedules relative to the current time from inside an event', () => {
    const s = new Scheduler();
    const times: number[] = [];
    s.schedule(10, () => s.schedule(5, () => times.push(s.now)));
    while (s.step());
    expect(times).toEqual([15]);
  });

  it('runUntil stops at the boundary and moves the clock', () => {
    const s = new Scheduler();
    const log: number[] = [];
    [5, 10, 15].forEach((t) => s.schedule(t, () => log.push(t)));
    s.runUntil(10);
    expect(log).toEqual([5, 10]);
    expect(s.now).toBe(10);
    expect(s.pending).toBe(1);
  });

  it('orders a large random workload correctly', () => {
    const s = new Scheduler();
    const out: number[] = [];
    const delays = Array.from({ length: 500 }, (_, i) => (i * 7919) % 101);
    delays.forEach((d) => s.schedule(d, () => out.push(s.now)));
    while (s.step());
    expect(out).toEqual([...delays].sort((a, b) => a - b));
  });

  it('skips cancelled events and does not count them as pending', () => {
    const s = new Scheduler();
    const log: string[] = [];
    const a = s.schedule(5, () => log.push('a'));
    s.schedule(10, () => log.push('b'));
    const c = s.schedule(15, () => log.push('c'));
    s.cancel(a);
    s.cancel(c);
    s.cancel(999);
    expect(s.pending).toBe(1);
    s.runUntil(12);
    expect(log).toEqual(['b']);
    expect(s.pending).toBe(0);
    expect(s.step()).toBe(false);
    expect(s.now).toBe(12);
  });

  it('rejects negative or non-finite delays', () => {
    const s = new Scheduler();
    expect(() => s.schedule(-1, () => {})).toThrow(RangeError);
    expect(() => s.schedule(Number.NaN, () => {})).toThrow(RangeError);
  });
});
