import { inSubnet, networkOf, type Cidr } from '../engine/addr.ts';
import { peerOf, type Device } from '../engine/device.ts';
import { Host } from '../engine/host.ts';
import type { Network } from '../engine/network.ts';
import { Switch } from '../engine/switch.ts';

export interface TaskContext {
  net: Network;
  /** Commands the user ran, oldest first. */
  commands: { device: string; line: string }[];
}

export interface TaskStep {
  title: string;
  /** What to do, shown for the current step. Text in backticks renders as code. */
  detail: string;
  hint?: string;
  check(ctx: TaskContext): boolean;
}

export interface Task {
  id: string;
  title: string;
  summary: string;
  steps: TaskStep[];
  /** Shown when every step is done. */
  done: string;
}

function hosts(net: Network): Host[] {
  return [...net.devices.values()].filter((d): d is Host => d instanceof Host);
}

function switches(net: Network): Switch[] {
  return [...net.devices.values()].filter((d): d is Switch => d instanceof Switch);
}

function neighborsOf(device: Device): Device[] {
  return device.ports.flatMap((p) => {
    const peer = peerOf(p);
    return peer ? [peer.device] : [];
  });
}

/** Two addresses are in the same network when each falls in the other's subnet. */
function sameSubnet(a: Cidr, b: Cidr): boolean {
  return a.ip !== b.ip && inSubnet(b.ip, a) && inSubnet(a.ip, b);
}

function shareSubnet(a: Host, b: Host): boolean {
  return a.allAddrs().some((x) => b.allAddrs().some((y) => sameSubnet(x, y)));
}

/** True if `from` received an echo reply from an address owned by another host in `among`. */
function pinged(from: Host, among: Host[]): boolean {
  return among.some(
    (other) => other !== from && other.allAddrs().some((a) => from.echoRepliesFrom.has(a.ip)),
  );
}

function cabledHostPairs(net: Network): [Host, Host][] {
  return hosts(net).flatMap((a) =>
    neighborsOf(a)
      .filter((d): d is Host => d instanceof Host && d.id > a.id)
      .map((b): [Host, Host] => [a, b]),
  );
}

function hostsOn(sw: Switch): Host[] {
  return neighborsOf(sw).filter((d): d is Host => d instanceof Host);
}

/** Largest group of `group` that all share one subnet. */
function largestSubnetGroup(group: Host[]): number {
  const counts = new Map<string, Set<Host>>();
  for (const h of group) {
    for (const a of h.allAddrs()) {
      const key = `${networkOf(a)}/${a.prefix}`;
      counts.set(key, (counts.get(key) ?? new Set()).add(h));
    }
  }
  return Math.max(0, ...[...counts.values()].map((s) => s.size));
}

export const TASKS: Task[] = [
  {
    id: 'first-ping',
    title: 'Two computers, one cable',
    summary: 'Build the smallest possible network and send your first ping.',
    steps: [
      {
        title: 'Add two PCs',
        detail: 'Drag a PC from the left panel onto the canvas, twice. You can also click it.',
        check: ({ net }) => hosts(net).length >= 2,
      },
      {
        title: 'Connect them with a cable',
        detail:
          'Drag from the small dot on the right of one PC and drop it on the other PC. A line appears: that is your cable.',
        check: ({ net }) => cabledHostPairs(net).length > 0,
      },
      {
        title: 'Give the first PC an IP address',
        detail:
          'Double-click a PC to open its terminal, then type `ip addr add 192.168.1.10/24 dev eth0` and press Enter.',
        hint: '`eth0` is the name of the network port. `/24` says the first three numbers are the network part.',
        check: ({ net }) =>
          cabledHostPairs(net).some(([a, b]) => a.allAddrs().length > 0 || b.allAddrs().length > 0),
      },
      {
        title: 'Give the second PC an address in the same network',
        detail: 'Open the other PC’s terminal and type `ip addr add 192.168.1.20/24 dev eth0`.',
        hint: 'With /24, both addresses must start with the same three numbers (192.168.1) and end differently.',
        check: ({ net }) => cabledHostPairs(net).some(([a, b]) => shareSubnet(a, b)),
      },
      {
        title: 'Ping one PC from the other',
        detail: 'In a terminal, type `ping 192.168.1.20` (use the other PC’s address).',
        hint: 'Check both addresses with `ip addr`. Each PC must have its own address in the same network.',
        check: ({ net }) => cabledHostPairs(net).some(([a, b]) => pinged(a, [b]) || pinged(b, [a])),
      },
    ],
    done: 'Congratulations! You have two computers that can talk to each other. Before the first ping, the PC used ARP to find the other PC’s MAC address. Switch to Simulation mode and ping again to watch it happen.',
  },
  {
    id: 'meet-the-switch',
    title: 'Meet the switch',
    summary: 'Connect several computers through a switch and see what it learns.',
    steps: [
      {
        title: 'Add a switch',
        detail: 'Drag a Switch from the left panel onto the canvas.',
        check: ({ net }) => switches(net).length > 0,
      },
      {
        title: 'Connect three PCs to the switch',
        detail: 'Add three PCs and cable each one to the switch.',
        check: ({ net }) => switches(net).some((sw) => hostsOn(sw).length >= 3),
      },
      {
        title: 'Put the three PCs in the same network',
        detail:
          'Give them addresses like `10.0.0.1/24`, `10.0.0.2/24` and `10.0.0.3/24` with `ip addr add … dev eth0`.',
        check: ({ net }) => switches(net).some((sw) => largestSubnetGroup(hostsOn(sw)) >= 3),
      },
      {
        title: 'Ping across the switch',
        detail: 'From one PC, ping another one, e.g. `ping 10.0.0.2`.',
        check: ({ net }) =>
          switches(net).some((sw) => {
            const group = hostsOn(sw);
            return group.some((h) => pinged(h, group));
          }),
      },
      {
        title: 'Look at what the switch learned',
        detail: 'Open the switch’s terminal and run `bridge fdb show`.',
        hint: 'Each line is a MAC address and the port it was seen on. That is how the switch knows where to send frames.',
        check: ({ net, commands }) =>
          commands.some(
            (c) =>
              /^bridge\s+fdb(\s+show)?$/.test(c.line) &&
              net.devices.get(c.device) instanceof Switch,
          ),
      },
    ],
    done: 'Well done! A switch learns which MAC address lives behind which port by reading the source of every frame. Unknown destinations and broadcasts (like ARP requests) go out of every other port.',
  },
];

export function findTask(id: string | null): Task | undefined {
  return TASKS.find((t) => t.id === id);
}

/**
 * Returns how many steps are complete. Steps complete in order and stay complete,
 * so undoing earlier work does not take progress away.
 */
export function advance(task: Task, ctx: TaskContext, completed: number): number {
  let n = Math.min(completed, task.steps.length);
  while (n < task.steps.length && task.steps[n]?.check(ctx)) n++;
  return n;
}
