import { formatIp, inSubnet, networkOf, type Cidr } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import type { Network } from '../engine/network.ts';
import { compile, type CustomTask } from './custom.ts';
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

/** PCs on a router port, with that port: cabled to it, or to a switch that is cabled to it. */
function pcsOnRouter(router: Device): RouterLink[] {
  return router.ports.flatMap((port) => {
    const peer = peerOf(port)?.device;
    const pcs = peer && isPc(peer) ? [peer] : peer && isSwitch(peer) ? hostsOn(peer) : [];
    return pcs.map((pc) => ({ port, pc }));
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

/** PCs on a switch grouped by the access VLAN (PVID) of their port, with VLAN filtering on. */
function vlanGroups(sw: Device): Device[][] {
  const bridge = sw.bridge;
  if (!bridge?.vlanFiltering) return [];
  const groups = new Map<number, Device[]>();
  for (const port of sw.ports) {
    const peer = peerOf(port);
    const pvid = bridge.vlans.get(port)?.pvid;
    if (!peer || !isPc(peer.device) || pvid === null || pvid === undefined) continue;
    groups.set(pvid, [...(groups.get(pvid) ?? []), peer.device]);
  }
  return [...groups.values()];
}

/** The example website inside the Internet cloud, 198.18.0.10. */
const SITE_IP = 0xc612000a;

/** Routers cabled to the Internet cloud and to a PC, with the port that goes to the cloud. */
function natRouters(net: Network): { router: Device; wan: Port }[] {
  return routers(net).flatMap((router) => {
    const wan = router.ports.find((p) => peerOf(p)?.device.spec.id === 'internet');
    return wan && pcsOnRouter(router).length > 0 ? [{ router, wan }] : [];
  });
}

/** A nat postrouting rule masquerades traffic leaving through `port`. */
function masqueradesOn(router: Device, port: string): boolean {
  return (router.ip?.nf.tables ?? []).some((t) =>
    t.chains.some(
      (c) =>
        c.base?.hook === 'postrouting' &&
        c.rules.some(
          (r) =>
            r.action.kind === 'masquerade' &&
            r.matches.every((m) => m.kind !== 'oifname' || (m.name === port && !m.neg)),
        ),
    ),
  );
}

/** Routers cabled to a switch port that carries two or more tagged VLANs (a trunk). */
function trunkRouters(net: Network): { router: Device; sw: Device }[] {
  return switches(net).flatMap((sw) => {
    const bridge = sw.bridge;
    if (!bridge?.vlanFiltering) return [];
    return sw.ports.flatMap((port) => {
      const peer = peerOf(port);
      const v = bridge.vlans.get(port);
      const tagged = [...(v?.vids ?? [])].filter((vid) => !v?.untagged.has(vid));
      return peer && isRouter(peer.device) && tagged.length >= 2
        ? [{ router: peer.device, sw }]
        : [];
    });
  });
}

/** Pairs of routers cabled to each other, each with a PC of its own. */
function ospfPairs(net: Network): [Device, Device][] {
  return routers(net).flatMap((a) =>
    neighborsOf(a)
      .filter(
        (b) => isRouter(b) && b.id > a.id && pcsOnRouter(a).length > 0 && pcsOnRouter(b).length > 0,
      )
      .map((b): [Device, Device] => [a, b]),
  );
}

/** The two routers have addresses in one network on the cable between them. */
function linkAddressed(a: Device, b: Device): boolean {
  return a.ports.some((p) => {
    const peer = peerOf(p);
    return (
      peer?.device === b &&
      (a.ip?.addrsOn(p) ?? []).some((x) =>
        (b.ip?.addrsOn(peer) ?? []).some((y) => sameSubnet(x, y)),
      )
    );
  });
}

/** Every VLAN's PCs share one network, and no two VLANs share a network. */
function vlansOwnNetworks(sw: Device): boolean {
  const groups = vlanGroups(sw);
  return (
    groups.length >= 2 &&
    groups.every(
      (g, i) =>
        largestSubnetGroup(g) === g.length &&
        groups.every((o, j) => i === j || !o.some((y) => g.some((x) => shareSubnet(x, y)))),
    )
  );
}

/** The WireGuard tunnel of a router, once it has a key. */
function tunnelOf(router: Device) {
  const wg = router.vlanPorts.map((p) => router.wireguard(p)).find((t) => t?.privateKey);
  return wg ?? null;
}

/**
 * The nine tasks are chapters of one network that keeps growing: each task's steps ask only
 * for what is new compared with the finished network of the one before (see solutions.ts,
 * which scripts every chapter). A step must not be true on that finished network, or the
 * chapter would complete the moment it starts.
 */
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
    done: 'Congratulations! You have two computers that can talk to each other. Before the first ping, the PC used ARP to find the other PC’s MAC address. Switch to Simulation mode and ping again to watch it happen. Next task: a third computer means you need a switch, and your network keeps growing.',
  },
  {
    id: 'meet-the-switch',
    title: 'Meet the switch',
    summary:
      'Replace the cable with a switch, add a third computer and see what the switch learns.',
    steps: [
      {
        title: 'Add a switch',
        detail:
          'Drag a Switch from the left panel onto the canvas. Two computers can share a cable, but a third one needs a switch.',
        check: ({ net }) => switches(net).length > 0,
      },
      {
        title: 'Plug both PCs into the switch',
        detail:
          'First remove the direct cable between pc1 and pc2: click it and press Delete. Then cable pc1 and pc2 to sw1. Drop a cable on a switch port to choose it, or on the switch itself to pick from a list.',
        check: ({ net }) =>
          cabledHostPairs(net).length === 0 && switches(net).some((sw) => hostsOn(sw).length >= 2),
      },
      {
        title: 'Add a third PC',
        detail: 'Drag one more PC onto the canvas and cable it to sw1 as well.',
        check: ({ net }) => switches(net).some((sw) => hostsOn(sw).length >= 3),
      },
      {
        title: 'Give the new PC an address in the same network',
        detail:
          'Open pc3 and give it `192.168.1.30/24` with `ip addr add 192.168.1.30/24 dev eth0`, or in IP Configuration.',
        hint: 'It must start with the same three numbers as pc1 and pc2 (192.168.1) and end with a number nobody uses yet.',
        check: ({ net }) => switches(net).some((sw) => largestSubnetGroup(hostsOn(sw)) >= 3),
      },
      {
        title: 'Ping the other two PCs from pc3',
        detail:
          'In pc3’s terminal run `ping 192.168.1.10`, then `ping 192.168.1.20`. The packets now travel through the switch.',
        check: ({ net }) =>
          switches(net).some((sw) => {
            const group = hostsOn(sw);
            return group.some((h) => group.every((o) => o === h || pinged(h, [o])));
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
    done: 'Well done! A switch learns which MAC address lives behind which port by reading the source of every frame. Unknown destinations and broadcasts (like ARP requests) go out of every other port. Next task: a second network, joined to this one by a router.',
  },
  {
    id: 'two-networks',
    title: 'Two networks, one router',
    summary: 'Join your switch network to a second network with a router and trace the path.',
    steps: [
      {
        title: 'Add a router and a fourth PC',
        detail:
          'Drag a Router and one more PC onto the canvas. The new PC will live in a second network.',
        check: ({ net }) => routers(net).length > 0 && hosts(net).length >= 4,
      },
      {
        title: 'Cable sw1 and the new PC to the router',
        detail:
          'Connect r1’s `eth0` to sw1 (any switch port) and pc4 to r1’s `eth1`. Each router port is a separate network: sw1 with its three PCs on one, pc4 on the other.',
        check: ({ net }) =>
          routers(net).some((r) => new Set(pcsOnRouter(r).map((l) => l.port)).size >= 2),
      },
      {
        title: 'Give the router an address in each network',
        detail:
          'Open r1, Config tab: give `eth0` `192.168.1.1/24` (the network the three PCs already use) and `eth1` `192.168.2.1/24`. Or in its CLI: `ip addr add 192.168.1.1/24 dev eth0`.',
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
        title: 'Give pc4 an address in its router port’s network',
        detail: 'pc4 is cabled to `eth1`, so give it `192.168.2.10/24`.',
        check: ({ net }) => routedPair(net, pcInPortNetwork),
      },
      {
        title: 'Tell every PC where the router is',
        detail:
          'A PC reaches other networks only through its default gateway. On pc1, pc2 and pc3 run `ip route add default via 192.168.1.1`; on pc4 run `ip route add default via 192.168.2.1`. IP Configuration has a gateway field too.',
        hint: 'Try a ping before this step: you get “Network is unreachable”. The gateway fixes that.',
        check: ({ net }) =>
          routedPair(net, (r, l) => pcInPortNetwork(r, l) && gatewayIsRouter(r, l)),
      },
      {
        title: 'Ping across the router',
        detail:
          'From pc4, ping a PC in the other network, e.g. `ping 192.168.1.10`. Notice `ttl=63`: the router took one off.',
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
        detail: 'Run `traceroute 192.168.1.10` on pc4. The first hop is the router.',
        check: (ctx) => ran(ctx, /^traceroute\s/, isPc),
      },
    ],
    done: 'You routed between two networks! The PC saw that the destination was not in its own network, so it sent the packet to its gateway. The router looked up its routing table, lowered the TTL and passed it on. Next task: stop typing addresses by hand.',
  },
  {
    id: 'dhcp',
    title: 'Automatic addresses with DHCP',
    summary: 'Let the router hand out addresses, then reach a PC by its name.',
    steps: [
      {
        title: 'Start a DHCP server on the router',
        detail:
          'r1 already has `192.168.1.1/24` on the port to sw1. Open r1 → Config → DHCP and DNS server → Start server. Or in its CLI: `dnsmasq --dhcp-range=192.168.1.100,192.168.1.199`.',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => {
            const subnets = s.router.ip?.addrsOn(s.port) ?? [];
            const ranges = s.router.dnsmasq?.config.ranges ?? [];
            return ranges.some((r) => subnets.some((a) => inSubnet(r.start, a)));
          }),
      },
      {
        title: 'Let pc1, pc2 and pc3 ask for an address',
        detail:
          'On each of them: IP Configuration → Get an address automatically. Or in the Terminal run `ip addr flush dev eth0` (forget the address you typed) and then `dhclient eth0`.',
        hint: 'Switch to Simulation mode first to watch the four DHCP messages: Discover, Offer, Request, Ack.',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => (s.router.dnsmasq?.activeLeases().length ?? 0) >= 2),
      },
      {
        title: 'Reach a PC by its name',
        detail:
          'The DHCP server also answers DNS for its clients. On pc1 run `ping pc2` (use the other PC’s name).',
        check: (ctx) =>
          ran(ctx, /^ping\s+(-\S+\s+\S+\s+)*[a-zA-Z][\w.-]*$/, isPc) &&
          dhcpSegments(ctx.net).some((s) => s.pcs.some((pc) => pinged(pc, s.pcs))),
      },
    ],
    done: 'No typing addresses by hand! The PCs broadcast a DHCP Discover, the server offered an address with a gateway and DNS server, and the PCs took it. The server remembered their names, so DNS could answer for them. Next task: split sw1 into separate networks.',
  },
  {
    id: 'vlans',
    title: 'Split a switch with VLANs',
    summary: 'Turn one switch into two separate networks without new hardware.',
    steps: [
      {
        title: 'Turn on VLAN filtering',
        detail:
          'Open sw1 → Config → VLANs → tick VLAN filtering. In its CLI: `ip link set br0 type bridge vlan_filtering 1`.',
        hint: 'Until filtering is on, a Linux bridge ignores VLAN settings: every port is in one network.',
        check: ({ net }) => switches(net).some((sw) => sw.bridge?.vlanFiltering),
      },
      {
        title: 'Put two PCs in VLAN 10 and one in VLAN 20',
        detail:
          'Make the PC ports access ports: pc1 and pc2 in VLAN 10, pc3 in VLAN 20. In the CLI of sw1: `bridge vlan add dev eth0 vid 10 pvid untagged` then `bridge vlan del dev eth0 vid 1` (the PCs are usually on `eth0`, `eth1` and `eth2`). The port to r1 stays in VLAN 1, so r1 is cut off for now.',
        hint: '`pvid` puts untagged frames from the PC into that VLAN; `untagged` sends that VLAN’s frames to the PC without a tag.',
        check: ({ net }) =>
          switches(net).some((sw) => {
            const groups = vlanGroups(sw);
            return groups.length >= 2 && groups.some((g) => g.length >= 2);
          }),
      },
      {
        title: 'Ping inside a VLAN',
        detail:
          'From pc1 ping pc2 by its address (`ip addr` shows it). Names do not work now: the DNS server on r1 is out of reach.',
        check: ({ net }) =>
          switches(net).some((sw) => vlanGroups(sw).some((g) => g.some((pc) => pinged(pc, g)))),
      },
      {
        title: 'Try to reach the other VLAN',
        detail: 'Now ping pc3 from pc1. Same network addresses, same switch: does it answer?',
        check: (ctx) =>
          switches(ctx.net).some((sw) => {
            const groups = vlanGroups(sw);
            return ctx.commands.some((c) => {
              const from = groups.find((g) => g.some((pc) => pc.id === c.device));
              const target = /^ping\s.*?(\d+\.\d+\.\d+\.\d+)\s*$/.exec(c.line)?.[1];
              const owns = (pc: Device) => addrsOf(pc).some((a) => formatIp(a.ip) === target);
              return from !== undefined && groups.some((g) => g !== from && g.some(owns));
            });
          }),
      },
    ],
    done: 'No reply: the switch now keeps VLAN 10 and VLAN 20 apart, as if they were two switches. Even ARP broadcasts stay inside their VLAN. To connect VLANs you need a router: give it VLAN interfaces (Router → Config → VLAN interfaces) on a trunk port. That is the next task.',
  },
  {
    id: 'inter-vlan',
    title: 'Route between VLANs',
    summary: 'Connect the two VLANs through one router cable, a “router on a stick”.',
    steps: [
      {
        title: 'Give each VLAN its own network',
        detail:
          'On pc1 and pc2 (VLAN 10) run `ip addr flush dev eth0` and `ip route del default` (forget the old address and gateway), then give them `192.168.10.10/24` and `192.168.10.20/24`. Do the same on pc3 (VLAN 20) with `192.168.20.10/24`.',
        check: ({ net }) => switches(net).some(vlansOwnNetworks),
      },
      {
        title: 'Turn the switch port to r1 into a trunk',
        detail:
          'r1 is already cabled to sw1 (port `eth7`). Make that switch port a trunk carrying VLANs 10 and 20: Config → VLANs → Trunk `10,20`. In the CLI: `bridge vlan add dev eth7 vid 10` and `bridge vlan add dev eth7 vid 20`.',
        hint: 'A trunk sends frames with an 802.1Q tag, so one cable can carry many VLANs.',
        check: ({ net }) => trunkRouters(net).length > 0,
      },
      {
        title: 'Give r1 a VLAN interface per VLAN',
        detail:
          'r1 → Config → VLAN interfaces: add VLAN 10 and VLAN 20 on `eth0`, then give `eth0.10` the address `192.168.10.1/24` and `eth0.20` `192.168.20.1/24`.',
        check: ({ net }) =>
          trunkRouters(net).some(
            ({ router }) =>
              router.vlanPorts.filter((p) => p.adminUp && (router.ip?.addrsOn(p).length ?? 0) > 0)
                .length >= 2,
          ),
      },
      {
        title: 'Point the PCs at their gateways',
        detail:
          'Each PC’s default gateway is r1’s address in its VLAN: `ip route add default via 192.168.10.1` on pc1 and pc2, `ip route add default via 192.168.20.1` on pc3.',
        check: ({ net }) =>
          trunkRouters(net).some(({ router, sw }) => {
            const gateways = new Set(
              router.vlanPorts.flatMap((p) => router.ip?.addrsOn(p).map((a) => a.ip) ?? []),
            );
            const pcs = vlanGroups(sw).flat();
            const ok = pcs.filter((pc) => {
              const via = pc.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
              return via !== undefined && via !== null && gateways.has(via);
            });
            return ok.length >= 2;
          }),
      },
      {
        title: 'Ping across VLANs',
        detail:
          'Ping pc3 from pc1 (`ping 192.168.20.10`). Watch it in Simulation mode: the frames to the router carry a VLAN tag.',
        check: ({ net }) =>
          switches(net).some((sw) => {
            const groups = vlanGroups(sw);
            return groups.some((g) => g.some((pc) => groups.some((o) => o !== g && pinged(pc, o))));
          }),
      },
    ],
    done: 'The router received each packet tagged with VLAN 10 on eth0.10, routed it, and sent it back down the same cable tagged with VLAN 20. One physical port, two logical networks. Next task: a branch office with a second router.',
  },
  {
    id: 'ospf',
    title: 'Let routers find the way (OSPF)',
    summary:
      'Add a branch office behind a second router and let the routers learn each other’s networks.',
    steps: [
      {
        title: 'Add a second router',
        detail: 'Drag another Router onto the canvas. It will be the branch office’s router.',
        check: ({ net }) => routers(net).length >= 2,
      },
      {
        title: 'Add a PC and cable the branch',
        detail: 'Add one more PC (pc5). Cable r1’s `eth2` to r2’s `eth1`, and pc5 to r2’s `eth0`.',
        check: ({ net }) => ospfPairs(net).length > 0,
      },
      {
        title: 'Address the new link and LAN',
        detail:
          'Router link: `10.0.0.1/30` on r1’s `eth2` and `10.0.0.2/30` on r2’s `eth1`. Branch LAN: r2’s `eth0` gets `192.168.3.1/24`, pc5 gets `192.168.3.10/24` and uses `192.168.3.1` as its gateway.',
        check: ({ net }) =>
          ospfPairs(net).some(
            ([a, b]) =>
              linkAddressed(a, b) &&
              [a, b].every((r) =>
                pcsOnRouter(r).some((l) => pcInPortNetwork(r, l) && gatewayIsRouter(r, l)),
              ),
          ),
      },
      {
        title: 'Start OSPF on both routers',
        detail:
          'In each router’s CLI run `bird` (or Config → Dynamic routing → Start OSPF). Then `birdc show ospf neighbors`.',
        hint: 'Routers ship /etc/bird.conf with OSPF on every Ethernet port.',
        check: ({ net }) =>
          ospfPairs(net).some(([a, b]) =>
            [a, b].every((r) => r.bird?.neighbors.some((n) => n.full)),
          ),
      },
      {
        title: 'See the learned route',
        detail:
          'On r1 run `ip route`: the branch network `192.168.3.0/24` appears with `proto bird`.',
        check: (ctx) =>
          ran(ctx, /^(ip\s+r(o(u(te?)?)?)?|birdc\s+show\s+route)/, isRouter) &&
          ospfPairs(ctx.net).some(([a]) => (a.bird?.routes.length ?? 0) > 0),
      },
      {
        title: 'Ping the branch from headquarters',
        detail: 'Ping pc4 from pc5 (`ping 192.168.2.10`). Nobody typed a route.',
        check: ({ net }) =>
          ospfPairs(net).some(([a, b]) => {
            const left = pcsOnRouter(a).map((l) => l.pc);
            const right = pcsOnRouter(b).map((l) => l.pc);
            return left.some((pc) => pinged(pc, right)) || right.some((pc) => pinged(pc, left));
          }),
      },
    ],
    done: 'Nobody typed a route: the routers said hello, swapped link-state advertisements, and each ran Dijkstra’s shortest path algorithm. Add a third router and a backup link, unplug a cable and watch them reroute. Next task: connect headquarters to the Internet.',
  },
  {
    id: 'nat',
    title: 'Reach the Internet through NAT',
    summary: 'Share one public address with the whole office, then add a firewall.',
    steps: [
      {
        title: 'Add the Internet and connect r1 to it',
        detail: 'Drag the Internet cloud onto the canvas and cable r1’s `eth3` to it.',
        check: ({ net }) => natRouters(net).length > 0,
      },
      {
        title: 'Get a public address from the provider',
        detail: 'In r1’s CLI: `dhclient eth3`. The cloud hands out an address and a default route.',
        check: ({ net }) =>
          natRouters(net).some(({ router, wan }) => (router.ip?.addrsOn(wan).length ?? 0) > 0),
      },
      {
        title: 'Turn on NAT',
        detail:
          'r1 → Config → Firewall and NAT → Share this connection (NAT), with `eth3` as the Internet side. It runs `nft add rule ip nat postrouting oifname "eth3" masquerade`.',
        hint: 'Without NAT the PCs’ packets reach the Internet, but nobody there knows the way back to 192.168.2.0/24.',
        check: ({ net }) =>
          natRouters(net).some(({ router, wan }) => masqueradesOn(router, wan.name)),
      },
      {
        title: 'Ping the Internet from a PC',
        detail: 'On pc4: `ping 198.18.0.10` (the example website). Then try `conntrack -L` on r1.',
        check: ({ net }) =>
          natRouters(net).some(({ router }) =>
            pcsOnRouter(router).some((l) => l.pc.ip?.echoRepliesFrom.has(SITE_IP)),
          ),
      },
      {
        title: 'Only let replies in',
        detail:
          'Add a firewall on r1: a forward chain with policy drop that accepts `ct state established,related` and anything that does not come from `eth3`. Paste the hint into the ruleset editor (Config tab), then ping again.',
        hint: 'table ip filter { chain forward { type filter hook forward priority 0; policy drop; ct state established,related accept; iifname != "eth3" accept } }',
        check: ({ net }) =>
          natRouters(net).some(({ router }) => {
            const nf = router.ip?.nf;
            const guarded = nf?.tables.some((t) =>
              t.chains.some(
                (c) =>
                  c.base?.hook === 'forward' &&
                  c.base.policy === 'drop' &&
                  c.rules.some((r) =>
                    r.matches.some((m) => m.kind === 'ct' && m.states.includes('established')),
                  ),
              ),
            );
            return !!guarded && (nf?.connections().some((c) => c.replied) ?? false);
          }),
      },
    ],
    done: 'Your PCs used the router’s public address: NAT rewrote each packet on the way out and remembered the connection (conntrack) to rewrite the replies. The firewall now drops anything that starts outside, while replies to your own connections still come back. Next task: a second office, joined to this one through the Internet.',
  },
  {
    id: 'vpn',
    title: 'Join two offices with a VPN',
    summary: 'Connect headquarters to a remote office across the Internet with WireGuard.',
    steps: [
      {
        title: 'Add a router and a PC for a remote office',
        detail:
          'Drag a Router and a PC onto the canvas (r3 and pc6). Cable pc6 to r3’s `eth0` and r3’s `eth1` to internet1’s `eth1`.',
        check: ({ net }) => natRouters(net).length >= 2,
      },
      {
        title: 'Get a public address for r3',
        detail: 'In r3’s CLI: `dhclient eth1`.',
        check: ({ net }) =>
          natRouters(net).filter(({ router, wan }) => (router.ip?.addrsOn(wan).length ?? 0) > 0)
            .length >= 2,
      },
      {
        title: 'Give the remote office its own network',
        detail:
          'r3’s `eth0` gets `192.168.4.1/24`; pc6 gets `192.168.4.10/24` and uses `192.168.4.1` as its gateway.',
        check: ({ net }) =>
          natRouters(net).filter(({ router }) =>
            pcsOnRouter(router).some(
              (l) => pcInPortNetwork(router, l) && gatewayIsRouter(router, l),
            ),
          ).length >= 2,
      },
      {
        title: 'Create a WireGuard interface on r1 and r3',
        detail:
          'Router → Config → WireGuard VPN → Create wg0, with `10.8.0.1/24` on r1 and `10.8.0.2/24` on r3.',
        hint: 'In the CLI: `wg genkey | tee key | wg pubkey`, then write /etc/wireguard/wg0.conf and run `wg-quick up wg0`.',
        check: ({ net }) => natRouters(net).filter(({ router }) => tunnelOf(router)).length >= 2,
      },
      {
        title: 'Make them peers',
        detail:
          'On each router add the other as a peer: its public key, its public address with port 51820 as endpoint (`ip addr` on the Internet port shows it), and its tunnel address and LAN as allowed IPs. On r1 that is `10.8.0.2/32, 192.168.4.0/24`; on r3 `10.8.0.1/32, 192.168.2.0/24`.',
        hint: 'The Config tab also adds the route into the tunnel. In the CLI add it yourself: `ip route add 192.168.4.0/24 dev wg0` on r1 and `ip route add 192.168.2.0/24 dev wg0` on r3.',
        check: ({ net }) => {
          const tunnels = natRouters(net).flatMap(({ router }) => {
            const wg = tunnelOf(router);
            return wg ? [wg] : [];
          });
          return tunnels.some((a) =>
            tunnels.some(
              (b) =>
                a !== b &&
                a.peers.some((p) => p.publicKey === b.publicKey) &&
                b.peers.some((p) => p.publicKey === a.publicKey),
            ),
          );
        },
      },
      {
        title: 'Ping across the tunnel',
        detail:
          'Ping pc6 from pc4 (`ping 192.168.4.10`). Then open the Internet cloud’s capture: only WireGuard packets cross it.',
        check: ({ net }) => {
          const offices = natRouters(net).flatMap(({ router }) =>
            tunnelOf(router) ? [pcsOnRouter(router).map((l) => l.pc)] : [],
          );
          return offices.some((a, i) =>
            offices.some((b, j) => i !== j && a.some((pc) => pinged(pc, b))),
          );
        },
      },
    ],
    done: 'Your ping travelled inside an encrypted UDP packet from one router’s public address to the other. The Internet only saw WireGuard traffic; each router accepted the inner packet only because it came from the other office’s allowed IPs. You built a whole company network, one chapter at a time.',
  },
];

/** Forgets answered pings, so a task only counts replies that arrive after it starts. */
export function clearEvidence(net: Network): void {
  for (const d of net.devices.values()) {
    d.ip?.echoRepliesFrom.clear();
    d.ip?.v6.echoRepliesFrom.clear();
  }
}

/** A built-in task, or one of the lab's own tasks (from the task editor). */
export function findTask(id: string | null, custom: readonly CustomTask[] = []): Task | undefined {
  const own = custom.find((t) => t.id === id);
  return own ? compile(own) : TASKS.find((t) => t.id === id);
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
