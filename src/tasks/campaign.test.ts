import { describe, expect, it } from 'vitest';
import { ACTS, chapterState } from './campaign.ts';
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
});
