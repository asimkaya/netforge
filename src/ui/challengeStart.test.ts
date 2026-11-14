import { describe, expect, it } from 'vitest';
import { commandFailed, explainFailure, type Explanation } from '../engine/explain.ts';
import { run } from '../engine/shell.ts';
import { CHALLENGES, type Challenge } from '../tasks/challenges.ts';
import { advance, findTask } from '../tasks/tasks.ts';
import { buildChallenge } from './challengeStart.ts';
import { Lab } from './labBuilder.ts';

/** What the explainer says about each fault: the device it points at and a phrase of its text. */
const EXPECTED: Record<string, { device: string; text: RegExp }> = {
  'fix-no-way-out': { device: 'pc3', text: /could not find the MAC address of its gateway/ },
  'fix-wrong-prefix': { device: 'pc2', text: /has no default gateway/ },
  'fix-no-network': { device: 'pc4', text: /eth0 is turned off/ },
  'fix-wrong-vlan': { device: 'pc2', text: /same VLAN/ },
  'fix-names': { device: 'srv1', text: /nothing is listening on UDP port 53/ },
  'fix-forwarding': { device: 'r1', text: /IP forwarding is off/ },
  'fix-web-blocked': { device: 'r1', text: /r1's firewall dropped the connection request/ },
  'fix-missing-route': { device: 'r2', text: /reply was lost on the way back.*no route to/ },
};

/** Runs the challenge's command the way the terminal does and explains the result. */
function attempt(lab: Lab, c: Challenge) {
  const device = lab.named(c.device);
  const output: string[] = [];
  const after = lab.net.dropSeq;
  let done = false;
  const proc = run(lab.net, device, c.command, {
    out: (text) => output.push(text),
    exit: () => (done = true),
  });
  for (let t = 0; proc && !done && t < 60_000; t += 100) lab.wait(100);
  lab.commands.push({ device: device.id, line: c.command });
  const failed = commandFailed(c.command, output);
  const why: Explanation | null = explainFailure(lab.net, device, {
    line: c.command,
    output,
    after,
    until: lab.net.dropSeq,
  });
  return { failed, why, output };
}

describe('the challenges', () => {
  const steps = (lab: Lab, c: Challenge) => {
    const task = findTask(c.id);
    if (!task) throw new Error(`no task ${c.id}`);
    return advance(task, { net: lab.net, commands: lab.commands }, 0);
  };

  it('have unique ids, three hints each, and go from easy to hard', () => {
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(CHALLENGES.length);
    expect(CHALLENGES).toHaveLength(8);
    for (const c of CHALLENGES) {
      expect(c.hints.map((h) => h.trim().length > 0)).toEqual([true, true, true]);
      expect(findTask(c.id)?.hints).toEqual(c.hints);
    }
    const rank = CHALLENGES.map((c) => ['Easy', 'Medium', 'Hard'].indexOf(c.level));
    expect(rank).toEqual([...rank].sort());
    expect(new Set(rank).size).toBe(3);
  });

  for (const c of CHALLENGES) {
    it(`${c.id}: the broken network shows the symptom, the fix removes it`, () => {
      const lab = new Lab(buildChallenge(c));
      expect(steps(lab, c), 'no step is done at the start').toBe(0);
      expect(c.fixed(lab.net)).toBe(false);
      expect(c.proved(lab.net)).toBe(false);

      const first = attempt(lab, c);
      expect(first.failed).toBe(true);
      expect(first.why?.kind).toBe('dropped');
      const expected = EXPECTED[c.id];
      expect(first.why?.text).toMatch(expected?.text ?? /^$/);
      expect(lab.net.devices.get(first.why?.deviceId ?? '')?.name).toBe(expected?.device);
      expect(steps(lab, c), 'reproduced, not fixed').toBe(1);

      lab.apply(c.fix);
      expect(c.fixed(lab.net)).toBe(true);
      expect(steps(lab, c), 'fixed, but the command has not run again').toBe(2);

      const second = attempt(lab, c);
      expect(second.failed, second.output.join('\n')).toBe(false);
      expect(steps(lab, c)).toBe(3);
    });
  }

  it('a fault that is only partly repaired does not count', () => {
    const c = CHALLENGES.find((x) => x.id === 'fix-web-blocked');
    if (!c) throw new Error('no challenge');
    const lab = new Lab(buildChallenge(c));
    // Allowing web in a new rule after the drop changes nothing: the drop still comes first.
    lab.apply([{ sh: 'r1', lines: ['nft add rule ip filter forward tcp dport 80 accept'] }]);
    expect(c.fixed(lab.net)).toBe(false);
    expect(attempt(lab, c).failed).toBe(true);
  });
});
