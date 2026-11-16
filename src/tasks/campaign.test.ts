import { describe, expect, it } from 'vitest';
import { ACTS, chapterState, rankOf, RANKS } from './campaign.ts';
import { TASKS } from './tasks.ts';

describe('campaign', () => {
  it('lists every chapter once, in order', () => {
    expect(ACTS.flatMap((a) => a.taskIds)).toEqual(TASKS.map((t) => t.id));
  });

  it('opens the first chapter and locks the rest until the one before is done', () => {
    const [first, second, third] = TASKS;
    if (!first || !second || !third) throw new Error('need three tasks');
    expect(chapterState(first.id, {})).toBe('available');
    expect(chapterState(second.id, {})).toBe('locked');
    const steps = { [first.id]: first.steps.length - 1 };
    expect(chapterState(second.id, steps)).toBe('locked');
    steps[first.id] = first.steps.length;
    expect(chapterState(first.id, steps)).toBe('done');
    expect(chapterState(second.id, steps)).toBe('available');
    expect(chapterState(third.id, steps)).toBe('locked');
  });

  it('promotes at the end of Act 1, in the middle of Act 2, at its end and at the last chapter', () => {
    const [act1, act2] = ACTS.map((a) => a.taskIds.length);
    expect(RANKS.map((r) => r.at)).toEqual([
      0,
      act1,
      (act1 ?? 0) + Math.ceil((act2 ?? 0) / 2),
      (act1 ?? 0) + (act2 ?? 0),
      TASKS.length,
    ]);
    expect(RANKS.map((r) => r.at)).toEqual([0, 2, 6, 10, 15]);
    expect(rankOf(0)).toMatchObject({ rank: { title: 'Intern' }, needed: 2 });
    expect(rankOf(1).rank.title).toBe('Intern');
    expect(rankOf(2)).toMatchObject({ rank: { title: 'Junior Admin' }, needed: 4 });
    expect(rankOf(5).rank.title).toBe('Junior Admin');
    expect(rankOf(6).rank.title).toBe('Network Technician');
    expect(rankOf(9).rank.title).toBe('Network Technician');
    expect(rankOf(10).rank.title).toBe('Network Engineer');
    expect(rankOf(14).next?.title).toBe('Network Architect');
    expect(rankOf(15)).toMatchObject({
      rank: { title: 'Network Architect' },
      next: null,
      needed: 0,
    });
  });
});
