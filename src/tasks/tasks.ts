import { inSubnet, networkOf, type Cidr } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import type { Network } from '../engine/network.ts';
import { peerOf, type Port } from '../engine/port.ts';

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

const isPc = (d: Device) => d.spec.id === 'pc';
const isSwitch = (d: Device) => d.spec.id === 'switch';
const isRouter = (d: Device) => d.spec.id === 'router';

function routers(net: Network): Device[] {
  return [...net.devices.values()].filter(isRouter);
}

interface RouterLink {
  port: Port;
  pc: Device;
}

/** PCs cabled straight to a router port, with that port. */
function pcsOnRouter(router: Device): RouterLink[] {
  return router.ports.flatMap((port) => {
    const peer = peerOf(port);
    return peer && isPc(peer.device) ? [{ port, pc: peer.device }] : [];
  });
}

/** The PC's address is in the same network as the router port it is cabled to. */
function pcInPortNetwork(router: Device, link: RouterLink): boolean {
  const routerAddrs = router.ip?.addrsOn(link.port) ?? [];
  return addrsOf(link.pc).some((a) => routerAddrs.some((r) => sameSubnet(a, r)));
}

/** The PC's default route points at the router's address on their shared network. */
function gatewayIsRouter(router: Device, link: RouterLink): boolean {
  const via = link.pc.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
  if (via === undefined || via === null) return false;
  return (router.ip?.addrsOn(link.port) ?? []).some((a) => a.ip === via);
}

/** Two PCs on different router ports, in different networks, both passing `check`. */
function routedPair(net: Network, check: (router: Device, link: RouterLink) => boolean) {
  return routers(net).some((r) => {
    const links = pcsOnRouter(r).filter((l) => check(r, l));
    return links.some((a) => links.some((b) => a.port !== b.port && !shareSubnet(a.pc, b.pc)));
  });
}

/** The user ran a command matching `pattern` on a device that passes `on`. */
function ran(ctx: TaskContext, pattern: RegExp, on: (d: Device) => boolean): boolean {
  return ctx.commands.some((c) => {
    const device = ctx.net.devices.get(c.device);
    return device !== undefined && on(device) && pattern.test(c.line);
  });
}

/** Switches shared by a router and at least two PCs, with the router's port to it. */
function dhcpSegments(net: Network) {
  return switches(net).flatMap((sw) => {
    const pcs = hostsOn(sw);
    return neighborsOf(sw)
      .filter(isRouter)
      .flatMap((router) => {
        const port = router.ports.find((p) => peerOf(p)?.device === sw);
        return port && pcs.length >= 2 ? [{ sw, router, port, pcs }] : [];
      });
  });
}

function hosts(net: Network): Device[] {
  return [...net.devices.values()].filter(isPc);
}

function switches(net: Network): Device[] {
  return [...net.devices.values()].filter(isSwitch);
}

function addrsOf(d: Device): Cidr[] {
  return d.ip?.allAddrs() ?? [];
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

function shareSubnet(a: Device, b: Device): boolean {
  return addrsOf(a).some((x) => addrsOf(b).some((y) => sameSubnet(x, y)));
}

/** True if `from` received an echo reply from an address owned by another host in `among`. */
function pinged(from: Device, among: Device[]): boolean {
  const replies = from.ip?.echoRepliesFrom;
  return !!replies && among.some((o) => o !== from && addrsOf(o).some((a) => replies.has(a.ip)));
}

function cabledHostPairs(net: Network): [Device, Device][] {
  return hosts(net).flatMap((a) =>
    neighborsOf(a)
      .filter((d) => isPc(d) && d.id > a.id)
      .map((b): [Device, Device] => [a, b]),
  );
}

function hostsOn(sw: Device): Device[] {
  return neighborsOf(sw).filter(isPc);
}

/** Largest group of `group` that all share one subnet. */
function largestSubnetGroup(group: Device[]): number {
  const counts = new Map<string, Set<Device>>();
  for (const h of group) {
    for (const a of addrsOf(h)) {
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
          'Drag from the network port on the right side of one PC (the small socket) and drop it on the other PC. A line appears: that is your cable, and both port lights turn green.',
        check: ({ net }) => cabledHostPairs(net).length > 0,
      },
      {
        title: 'Give the first PC an IP address',
        detail:
          'Click a PC to open it, go to Desktop → Terminal and type `ip addr add 192.168.1.10/24 dev eth0`. Prefer forms? Desktop → IP Configuration does the same.',
        hint: '`eth0` is the name of the network port. `/24` says the first three numbers are the network part.',
        check: ({ net }) =>
          cabledHostPairs(net).some(([a, b]) => addrsOf(a).length > 0 || addrsOf(b).length > 0),
      },
      {
        title: 'Give the second PC an address in the same network',
        detail:
          'Open the other PC and give it `192.168.1.20/24`, in the Terminal (`ip addr add 192.168.1.20/24 dev eth0`) or in IP Configuration.',
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
        detail:
          'Add three PCs and cable each one to the switch. Drop a cable on a switch port to choose it, or on the switch itself to pick from a list.',
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
        detail: 'Click the switch, open its CLI tab and run `bridge fdb show`.',
        hint: 'Each line is a MAC address and the port it was seen on. That is how the switch knows where to send frames.',
        check: ({ net, commands }) =>
          commands.some(
            (c) =>
              /^bridge\s+fdb(\s+show)?$/.test(c.line) &&
              net.devices.get(c.device)?.spec.id === 'switch',
          ),
      },
    ],
    done: 'Well done! A switch learns which MAC address lives behind which port by reading the source of every frame. Unknown destinations and broadcasts (like ARP requests) go out of every other port.',
  },
  {
    id: 'two-networks',
    title: 'Two networks, one router',
    summary: 'Connect two separate networks with a router and trace the path between them.',
    steps: [
      {
        title: 'Add a router and two PCs',
        detail: 'Drag a Router and two PCs onto the canvas.',
        check: ({ net }) => routers(net).length > 0 && hosts(net).length >= 2,
      },
      {
        title: 'Cable each PC to its own router port',
        detail:
          'Connect one PC to the router’s eth0 and the other to eth1. Each router port is a separate network.',
        check: ({ net }) => routers(net).some((r) => pcsOnRouter(r).length >= 2),
      },
      {
        title: 'Give the router an address in each network',
        detail:
          'Open the router, Config tab: give eth0 `192.168.1.1/24` and eth1 `192.168.2.1/24`. Or in its CLI: `ip addr add 192.168.1.1/24 dev eth0`.',
        hint: 'Two different networks: the third number differs (1 and 2).',
        check: ({ net }) =>
          routers(net).some((r) => {
            const nets = new Set(
              pcsOnRouter(r).flatMap(({ port }) =>
                (r.ip?.addrsOn(port) ?? []).map((a) => `${networkOf(a)}/${a.prefix}`),
              ),
            );
            return nets.size >= 2;
          }),
      },
      {
        title: 'Give each PC an address in its router port’s network',
        detail:
          'For example `192.168.1.10/24` for the PC on eth0 and `192.168.2.10/24` for the PC on eth1.',
        check: ({ net }) => routedPair(net, pcInPortNetwork),
      },
      {
        title: 'Tell each PC where the router is',
        detail:
          'A PC reaches other networks only through its default gateway. In IP Configuration set it to the router’s address on the PC’s side, or run `ip route add default via 192.168.1.1`.',
        hint: 'Try a ping before this step: you get “Network is unreachable”. The gateway fixes that.',
        check: ({ net }) =>
          routedPair(net, (r, l) => pcInPortNetwork(r, l) && gatewayIsRouter(r, l)),
      },
      {
        title: 'Ping across the router',
        detail:
          'From one PC, ping the other one, e.g. `ping 192.168.2.10`. Notice `ttl=63`: the router took one off.',
        check: ({ net }) =>
          routers(net).some((r) => {
            const pcs = pcsOnRouter(r).map((l) => l.pc);
            return pcs.some((pc) =>
              pinged(
                pc,
                pcs.filter((o) => !shareSubnet(o, pc)),
              ),
            );
          }),
      },
      {
        title: 'See the path with traceroute',
        detail: 'Run `traceroute 192.168.2.10` on a PC. The first hop is the router.',
        check: (ctx) => ran(ctx, /^traceroute\s/, isPc),
      },
    ],
    done: 'You routed between two networks! The PC saw that the destination was not in its own network, so it sent the packet to its gateway. The router looked up its routing table, lowered the TTL and passed it on.',
  },
  {
    id: 'dhcp',
    title: 'Automatic addresses with DHCP',
    summary: 'Let a DHCP server hand out addresses, then reach a PC by its name.',
    steps: [
      {
        title: 'Build a small office network',
        detail: 'Add a router, a switch and two PCs. Cable the router and both PCs to the switch.',
        check: ({ net }) => dhcpSegments(net).length > 0,
      },
      {
        title: 'Give the router an address',
        detail:
          'On the router port that goes to the switch, set `192.168.1.1/24` (Config tab or `ip addr add`).',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => (s.router.ip?.addrsOn(s.port).length ?? 0) > 0),
      },
      {
        title: 'Start a DHCP server on the router',
        detail:
          'Router → Config → DHCP and DNS server → Start server. Or in its CLI: `dnsmasq --dhcp-range=192.168.1.100,192.168.1.199`.',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => {
            const subnets = s.router.ip?.addrsOn(s.port) ?? [];
            const ranges = s.router.dnsmasq?.config.ranges ?? [];
            return ranges.some((r) => subnets.some((a) => inSubnet(r.start, a)));
          }),
      },
      {
        title: 'Let both PCs ask for an address',
        detail:
          'On each PC: IP Configuration → Get an address automatically, or `dhclient eth0` in the Terminal.',
        hint: 'Switch to Simulation mode first to watch the four DHCP messages: Discover, Offer, Request, Ack.',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => (s.router.dnsmasq?.activeLeases().length ?? 0) >= 2),
      },
      {
        title: 'Reach a PC by its name',
        detail:
          'The DHCP server also answers DNS for its clients. On one PC run `ping pc2` (use the other PC’s name).',
        check: (ctx) =>
          ran(ctx, /^ping\s+(-\S+\s+\S+\s+)*[a-zA-Z][\w.-]*$/, isPc) &&
          dhcpSegments(ctx.net).some((s) => s.pcs.some((pc) => pinged(pc, s.pcs))),
      },
    ],
    done: 'No typing addresses by hand! The PCs broadcast a DHCP Discover, the server offered an address with a gateway and DNS server, and the PCs took it. The server remembered their names, so DNS could answer for them.',
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
