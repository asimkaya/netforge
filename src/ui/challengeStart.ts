import type { useReactFlow } from '@xyflow/react';
import type { Challenge, ChallengeBase } from '../tasks/challenges.ts';
import { Lab } from './labBuilder.ts';
import { getLab, loadLab } from './lab.ts';
import type { Project } from './project.ts';
import { SCENARIOS } from './scenarios.ts';
import { showAll, startOf } from './taskStart.ts';

type Flow = ReturnType<typeof useReactFlow>;

/** Two routers with a static route each way, and a PC behind each. */
function twoSites(): Project {
  const lab = new Lab();
  const r1 = lab.add('router', 100, 100);
  const r2 = lab.add('router', 500, 100);
  const head = lab.add('pc', 100, 300);
  const branch = lab.add('pc', 500, 300);
  lab.cable(head, 'eth0', r1, 'eth0');
  lab.cable(r1, 'eth1', r2, 'eth1');
  lab.cable(branch, 'eth0', r2, 'eth0');
  lab.sh(
    r1,
    'ip addr add 192.168.1.1/24 dev eth0',
    'ip addr add 10.0.0.1/30 dev eth1',
    'ip route add 192.168.2.0/24 via 10.0.0.2',
  );
  lab.sh(
    r2,
    'ip addr add 192.168.2.1/24 dev eth0',
    'ip addr add 10.0.0.2/30 dev eth1',
    'ip route add 192.168.1.0/24 via 10.0.0.1',
  );
  lab.sh(head, 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1');
  lab.sh(branch, 'ip addr add 192.168.2.10/24 dev eth0', 'ip route add default via 192.168.2.1');
  return lab.done();
}

const BASES: Record<ChallengeBase, () => Project> = {
  office: () => SCENARIOS.find((s) => s.id === 'office')?.build() ?? new Lab().done(),
  // The network the guided tasks have built once "Route between VLANs" is finished.
  vlans: () => startOf('ospf'),
  'two-sites': twoSites,
};

/** The working network of the challenge with its fault applied: generated, not hand-written. */
export function buildChallenge(challenge: Challenge): Project {
  const lab = new Lab(BASES[challenge.base]());
  lab.apply(challenge.breakIt);
  return lab.done();
}

/** Replaces the lab with the challenge's broken network and starts it. */
export function loadChallenge(challenge: Challenge, flow: Flow): void {
  const project = buildChallenge(challenge);
  const steps = { ...getLab().tasks.steps, [challenge.id]: 0 };
  loadLab({ ...project, tasks: { active: challenge.id, steps } });
  showAll(flow, project);
}
