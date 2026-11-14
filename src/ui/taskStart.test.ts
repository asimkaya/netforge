import { describe, expect, it } from 'vitest';
import { runNft } from '../engine/nft.ts';
import { SOLUTIONS, type Action } from '../tasks/solutions.ts';
import { TASKS, advance, clearEvidence, findTask } from '../tasks/tasks.ts';
import { Lab } from './labBuilder.ts';
import { FOOTPRINT } from './placement.ts';
import type { Project } from './project.ts';
import { startOf } from './taskStart.ts';

function overlapping(project: Project): string[] {
  const placed = [...project.net.devices.values()].map((d) => {
    const at = project.layout[d.id] ?? { x: NaN, y: NaN };
    return { name: d.name, ...at, ...FOOTPRINT[d.spec.id] };
  });
  return placed.flatMap((a, i) =>
    placed
      .slice(i + 1)
      .filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
      .map((b) => `${a.name} / ${b.name}`),
  );
}

describe('the tasks are chapters of one growing network', () => {
  it('every task has a scripted solution', () => {
    expect(Object.keys(SOLUTIONS)).toEqual(TASKS.map((t) => t.id));
  });

  it('the first task starts from an empty canvas', () => {
    const first = TASKS[0];
    expect(first && startOf(first.id).net.devices.size).toBe(0);
  });

  for (const task of TASKS) {
    it(`${task.id}: its prepared start has no step done, its solution finishes them all`, () => {
      const start = startOf(task.id);
      expect(overlapping(start)).toEqual([]);
      const lab = new Lab(start);
      expect(advance(task, { net: lab.net, commands: lab.commands }, 0)).toBe(0);
      lab.apply(SOLUTIONS[task.id] ?? []);
      expect(advance(task, { net: lab.net, commands: lab.commands }, 0)).toBe(task.steps.length);
      expect(overlapping({ net: lab.net, layout: lab.layout, tasks: start.tasks })).toEqual([]);
    });
  }

  it('on the learner’s own network, a task starts with nothing done and ends with everything done', () => {
    const lab = new Lab();
    for (const task of TASKS) {
      clearEvidence(lab.net);
      lab.commands.length = 0;
      const ctx = { net: lab.net, commands: lab.commands };
      expect(advance(task, ctx, 0), `${task.id} at its start`).toBe(0);
      lab.apply(SOLUTIONS[task.id] ?? []);
      expect(advance(task, ctx, 0), `${task.id} after its solution`).toBe(task.steps.length);
    }
  });
});

describe('what a step accepts', () => {
  /** Starts the task, plays `actions` and says how many steps are done. */
  function progress(id: string, ...actions: Action[][]): { done: number; lab: Lab } {
    const lab = new Lab(startOf(id));
    const task = findTask(id);
    if (!task) throw new Error(`no task ${id}`);
    const done: number[] = [];
    for (const a of actions) {
      lab.apply(a);
      done.push(advance(task, { net: lab.net, commands: lab.commands }, 0));
    }
    return { done: done.at(-1) ?? 0, lab };
  }
  const sh = (device: string, ...lines: string[]): Action => ({ sh: device, lines });
  const build = (id: string, from: number, to: number) => (SOLUTIONS[id] ?? []).slice(from, to);

  it('a gateway that is not the router does not count', () => {
    const { done } = progress(
      'two-networks',
      build('two-networks', 0, 5),
      [sh('pc4', 'ip addr add 192.168.2.10/24 dev eth0', 'ip route add default via 192.168.2.99')],
      ['pc1', 'pc2', 'pc3'].map((pc) => sh(pc, 'ip route add default via 192.168.1.1')),
    );
    expect(done).toBe(4);
  });

  it('a DHCP range outside the router’s network serves nobody', () => {
    expect(progress('dhcp', [sh('r1', 'dnsmasq --dhcp-range=10.9.9.100,10.9.9.200')]).done).toBe(0);
    expect(progress('dhcp', build('dhcp', 0, 1)).done).toBe(1);
  });

  it('pinging the other VLAN is not “inside” the VLAN', () => {
    const { done } = progress('vlans', build('vlans', 0, 2), [
      { sh: 'pc1', lines: ['ping -c 1 192.168.1.102'], failing: true },
    ]);
    expect(done).toBe(2);
  });

  it('one tagged VLAN is not a trunk for two', () => {
    const solution = SOLUTIONS['inter-vlan'] ?? [];
    const { done } = progress('inter-vlan', solution.slice(0, 3), [
      sh('sw1', 'bridge vlan add dev eth7 vid 10'),
    ]);
    expect(done).toBe(1);
  });

  it('NAT on the wrong side does not count, and the firewall hint is valid nft', () => {
    const { done, lab } = progress('nat', build('nat', 0, 2), [
      sh(
        'r1',
        'dhclient eth3',
        'nft add table ip nat',
        'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
        'nft add rule ip nat postrouting oifname "eth1" masquerade',
      ),
    ]);
    expect(done).toBe(2);
    const hint = findTask('nat')?.steps[4]?.hint ?? '';
    const r1 = lab.named('r1');
    expect(r1.ip && runNft(r1.ip.nf, hint, () => {})).toBeNull();
  });
});
