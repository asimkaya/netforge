import { formatIp, inSubnet, networkOf, parseCidr, parseIp, type Cidr } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import type { Network } from '../engine/network.ts';
import { CHALLENGE_TASKS } from './challenges.ts';
import { compile, type CustomTask } from './custom.ts';
import type { Rule } from '../engine/netfilter.ts';
import { peerOf, type Port } from '../engine/port.ts';
import { isSwitchSpec, SPECS } from '../engine/specs.ts';
import { associatedAp } from '../engine/wifi.ts';

export interface TaskContext {
  net: Network;
  /** Commands the user ran, oldest first. */
  commands: { device: string; line: string }[];
}

/** One small action of a step, with a live tick on the checklist. */
export interface TaskPart {
  /** One small action, in plain words. Backticks = short inline names only (eth0, sw1). */
  text: string;
  /** A command to type, shown as a code block with a Copy button. One command per part. */
  code?: string;
  /** Device name whose terminal the command runs on, shown as "In pc1's terminal". */
  on?: string;
  /** Live state for the checklist (not sticky). */
  done(ctx: TaskContext): boolean;
}

export interface TaskStep {
  title: string;
  /** Why the step matters, in a sentence or two. Commands go in `parts`, not here. */
  detail: string;
  hint?: string;
  /** The small actions of the step. Without `check`, the step is done when all are. */
  parts?: TaskPart[];
  /** When set, decides alone whether the step is done (even if some parts are not). */
  check?(ctx: TaskContext): boolean;
}

export interface Task {
  id: string;
  title: string;
  summary: string;
  /** A short in-game message from a colleague who asks for the work. */
  brief?: { from: string; text: string };
  steps: TaskStep[];
  /** Shown when every step is done. */
  done: string;
  /** Troubleshooting challenges: the complaint, and hints revealed one at a time. */
  symptom?: string;
  hints?: readonly string[];
}

const isPc = (d: Device) => d.spec.id === 'pc';
const isSwitch = (d: Device) => isSwitchSpec(d.spec.id);
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

/** Printers (or IP cameras) cabled to a switch. */
function appliancesOn(net: Network, kind: 'printer' | 'camera'): Device[] {
  return [...net.devices.values()].filter((d) => d[kind] && neighborsOf(d).some(isSwitch));
}

/** Router ports on the switches a device is cabled to, or that its Wi-Fi access point is. */
function routerPorts(d: Device): { router: Device; port: Port }[] {
  const upstream = [d, ...neighborsOf(d).filter((n) => n.spec.id === 'ap')];
  return upstream
    .flatMap(neighborsOf)
    .filter(isSwitch)
    .flatMap((sw) =>
      neighborsOf(sw)
        .filter(isRouter)
        .flatMap((router) =>
          router.ports.filter((p) => peerOf(p)?.device === sw).map((port) => ({ router, port })),
        ),
    );
}

/** The device has an address in the network of a router port on its switch. */
function addressedByRouter(d: Device): boolean {
  return routerPorts(d).some(({ router, port }) =>
    (router.ip?.addrsOn(port) ?? []).some((a) => addrsOf(d).some((b) => sameSubnet(a, b))),
  );
}

/** An address in the router's network, outside its DHCP ranges, and the router as gateway. */
function fixedAddress(d: Device): boolean {
  const via = d.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
  return routerPorts(d).some(({ router, port }) => {
    const lan = router.ip?.addrsOn(port) ?? [];
    const ranges = router.dnsmasq?.config.ranges ?? [];
    return (
      lan.some((a) => a.ip === via) &&
      addrsOf(d).some(
        (b) =>
          lan.some((a) => sameSubnet(a, b)) &&
          !ranges.some((r) => b.ip >= r.start && b.ip <= r.end),
      )
    );
  });
}

const SERVER_PAGE = '/var/www/html/index.html';

const ofSpec = (net: Network, spec: string) =>
  [...net.devices.values()].filter((d) => d.spec.id === spec);

/** The access point's factory settings (see its spec). */
const FACTORY_SSID = 'NetForge';
const FACTORY_PASSWORD = 'netforge123';

/** Access points cabled to a switch that broadcast their own name with their own password. */
function officeAps(net: Network): Device[] {
  return ofSpec(net, 'ap').filter((ap) => {
    const h = ap.hostapd;
    return (
      neighborsOf(ap).some(isSwitch) &&
      !!h &&
      h.ssid !== FACTORY_SSID &&
      h.passphrase !== null &&
      h.passphrase !== FACTORY_PASSWORD
    );
  });
}

const clientsOf = (net: Network, ap: Device, spec: 'laptop' | 'phone') =>
  ofSpec(net, spec).filter((c) => associatedAp(c) === ap);

/** One of `from` has opened a TCP connection to the device. */
function reachedBy(from: Device[], target: Device): boolean {
  return from.some((c) => addrsOf(target).some((a) => c.ip?.tcp.connectedTo.has(a.ip)));
}

/** A PC has opened a TCP connection to the device. */
function reachedByPc(net: Network, target: Device): boolean {
  return reachedBy(hosts(net), target);
}

/** A home router's addresses on its Internet port (eth0) and on its LAN and Wi-Fi side (br0). */
const wanOf = (h: Device): Cidr[] => {
  const port = h.port('eth0');
  return port ? (h.ip?.addrsOn(port) ?? []) : [];
};
const lanOf = (h: Device): Cidr[] => (h.bridgePort ? (h.ip?.addrsOn(h.bridgePort) ?? []) : []);

const overlap = (a: Cidr, b: Cidr) => inSubnet(a.ip, b) || inSubnet(b.ip, a);

/** Home routers whose Internet port is cabled to a switch and has an address from a router's network. */
function guestBoxes(net: Network): Device[] {
  return ofSpec(net, 'homerouter').filter((h) => {
    const wan = h.port('eth0');
    const peer = wan && peerOf(wan)?.device;
    return (
      !!peer &&
      isSwitch(peer) &&
      wanOf(h).some((w) => routers(net).some((r) => addrsOf(r).some((a) => sameSubnet(a, w))))
    );
  });
}

/** The home router's LAN has a network of its own, and its DHCP server serves that network. */
function ownGuestNetwork(net: Network, h: Device): boolean {
  const lan = lanOf(h);
  const others = [...routers(net), ...ofSpec(net, 'homerouter').filter((d) => d !== h)].flatMap(
    addrsOf,
  );
  return (
    lan.length > 0 &&
    lan.every((l) => [...others, ...wanOf(h)].every((o) => !overlap(l, o))) &&
    (h.dnsmasq?.config.ranges.some((r) =>
      lan.some((l) => inSubnet(r.start, l) && inSubnet(r.end, l)),
    ) ??
      false)
  );
}

/** Phones on the home router's Wi-Fi. */
const guestsOf = (net: Network, h: Device) =>
  ofSpec(net, 'phone').filter((c) => associatedAp(c) === h);

/**
 * A guest's packet was dropped by a rule of the home router on its way to the office network.
 * The rule must name the guests (not drop the replies Internet traffic needs) and must not
 * match the example website, so a rule that cuts the Internet off too does not count.
 */
function guestKeptOut(net: Network, h: Device): boolean {
  const lan = lanOf(h);
  const office = wanOf(h);
  const rules = (h.ip?.nf.tables ?? []).flatMap((t) => t.chains.flatMap((c) => c.rules));
  return net.drops.some((d) => {
    if (d.device !== h.id || d.reason !== 'netfilter' || d.rule === null || !d.packet) return false;
    const src = parseIp(d.packet.src);
    const dst = parseIp(d.packet.dst);
    const rule = rules.find((r) => r.handle === d.rule);
    return (
      src !== null &&
      dst !== null &&
      lan.some((l) => inSubnet(src, l)) &&
      office.some((o) => inSubnet(dst, o)) &&
      !!rule &&
      rule.matches.some(
        (m) => (m.kind === 'iifname' || m.kind === 'oifname' || m.kind === 'saddr') && !m.neg,
      ) &&
      rule.matches.some((m) => m.kind === 'daddr' && m.neg === inSubnet(SITE_IP, m.cidr))
    );
  });
}

const named = (net: Network, name: string): Device | undefined =>
  [...net.devices.values()].find((d) => d.name === name);

/** The user ran a command matching `pattern` on the device called `name`. */
const typed = (ctx: TaskContext, name: string, pattern: RegExp): boolean =>
  ran(ctx, pattern, (d) => d.name === name);

const hasAddress = ({ net }: TaskContext, name: string): boolean => {
  const d = named(net, name);
  return !!d && addrsOf(d).length > 0;
};

/** Both devices exist and have addresses in one network. */
const sharesNetwork = ({ net }: TaskContext, a: string, b: string): boolean => {
  const x = named(net, a);
  const y = named(net, b);
  return !!x && !!y && shareSubnet(x, y);
};

/** `from` has received an echo reply from `to`. */
const gotReply = ({ net }: TaskContext, from: string, to: string): boolean => {
  const x = named(net, from);
  const y = named(net, to);
  return !!x && !!y && pinged(x, [y]);
};

/** `from` has opened a TCP connection to `to`. */
const connected = ({ net }: TaskContext, from: string, to: string): boolean => {
  const x = named(net, from);
  const y = named(net, to);
  return !!x && !!y && reachedBy([x], y);
};

const wiredToSwitch = ({ net }: TaskContext, name: string): boolean => {
  const d = named(net, name);
  return !!d && neighborsOf(d).some(isSwitch);
};

/** The router the PC called `name` reaches (directly or through a switch), with the link. */
function routedLink(net: Network, name: string) {
  for (const router of routers(net)) {
    const link = pcsOnRouter(router).find((l) => l.pc.name === name);
    if (link) return { router, link };
  }
  return null;
}

/** One checklist item: the PC's default route points at the router in its own network. */
const gatewayPart = (pc: string, gateway: string): TaskPart => ({
  text: `Give ${pc} its gateway`,
  code: `ip route add default via ${gateway}`,
  on: pc,
  done: ({ net }) => {
    const hit = routedLink(net, pc);
    return !!hit && pcInPortNetwork(hit.router, hit.link) && gatewayIsRouter(hit.router, hit.link);
  },
});

/** Has an active DHCP lease from r1. */
const hasLease = ({ net }: TaskContext, name: string): boolean => {
  const d = named(net, name);
  const leases = named(net, 'r1')?.dnsmasq?.activeLeases() ?? [];
  return !!d && leases.some((l) => addrsOf(d).some((a) => a.ip === l.ip));
};

/** `ping pc2`: a name instead of an address. */
const PING_BY_NAME = /^ping\s+(-\S+\s+\S+\s+)*[a-zA-Z][\w.-]*$/;

/** Port `a` ("r1/eth2") is cabled to port `b` ("r2/eth1"), or to any port of device `b` ("sw2"). */
const cabled = ({ net }: TaskContext, a: string, b: string): boolean => {
  const [device, port] = a.split('/');
  const p = device && port ? named(net, device)?.port(port) : undefined;
  const peer = p && peerOf(p);
  if (!peer) return false;
  const [other, otherPort] = b.split('/');
  return peer.device.name === other && (otherPort === undefined || peer.name === otherPort);
};

/** The port `port` of device `name` has the address `cidr` ("10.0.0.1/30"). */
const hasAddr = ({ net }: TaskContext, name: string, port: string, cidr: string): boolean => {
  const d = named(net, name);
  const p = d?.port(port);
  const want = parseCidr(cidr);
  return (
    !!d &&
    !!p &&
    !!want &&
    (d.ip?.addrsOn(p) ?? []).some((a) => a.ip === want.ip && a.prefix === want.prefix)
  );
};

/** The device has the address `ip` ("192.168.3.10") on any port. */
const hasIp = ({ net }: TaskContext, name: string, ip: string): boolean => {
  const d = named(net, name);
  return !!d && addrsOf(d).some((a) => a.ip === parseIp(ip));
};

/** The device's default route points at `gateway`. */
const defaultVia = ({ net }: TaskContext, name: string, gateway: string): boolean => {
  const via = named(net, name)?.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
  return via !== undefined && via !== null && via === parseIp(gateway);
};

/** A route to `cidr` through the interface `dev` of the device. */
const routeDev = ({ net }: TaskContext, name: string, dev: string, cidr: string): boolean => {
  const want = parseCidr(cidr);
  return (
    !!want &&
    (named(net, name)?.ip?.staticRoutes ?? []).some(
      (r) => r.dev.name === dev && r.dst.ip === want.ip && r.dst.prefix === want.prefix,
    )
  );
};

/** The user pinged an address of `to` from `from` (answered or not). */
const pingedAddress = (ctx: TaskContext, from: string, to: string): boolean => {
  const target = named(ctx.net, to);
  const src = named(ctx.net, from);
  return (
    !!target &&
    !!src &&
    ctx.commands.some((c) => {
      const ip =
        c.device === src.id ? /^ping\s.*?(\d+\.\d+\.\d+\.\d+)\s*$/.exec(c.line)?.[1] : null;
      return !!ip && addrsOf(target).some((a) => formatIp(a.ip) === ip);
    })
  );
};

/** The device's address is in a router's network on its switch, outside the DHCP ranges. */
function outsideDhcp(d: Device): boolean {
  return routerPorts(d).some(({ router, port }) => {
    const ranges = router.dnsmasq?.config.ranges ?? [];
    return (router.ip?.addrsOn(port) ?? []).some((a) =>
      addrsOf(d).some(
        (b) => sameSubnet(a, b) && !ranges.some((r) => b.ip >= r.start && b.ip <= r.end),
      ),
    );
  });
}

/** The device's default gateway is a router's address on its switch. */
function lanGateway(d: Device): boolean {
  const via = d.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
  return routerPorts(d).some(({ router, port }) =>
    (router.ip?.addrsOn(port) ?? []).some((a) => a.ip === via),
  );
}

/** The server serves a page other than the sample one. */
function ownPage(s: Device): boolean {
  const page = s.fs?.read(SERVER_PAGE);
  return page !== undefined && page.trim() !== '' && page !== SPECS.server.files?.[SERVER_PAGE];
}

/** The switch port a PC is cabled to is an access port of VLAN `vid`. */
const accessVlan = ({ net }: TaskContext, name: string, vid: number): boolean => {
  const port = named(net, name)?.port('eth0');
  const peer = port && peerOf(port);
  const v = peer?.device.bridge?.vlans.get(peer);
  return !!v && v.pvid === vid && v.vids.has(vid);
};

/** The switch port `port` carries VLAN `vid` tagged. */
const trunks = ({ net }: TaskContext, sw: string, port: string, vid: number): boolean => {
  const d = named(net, sw);
  const p = d?.port(port);
  const v = p && d?.bridge?.vlans.get(p);
  return !!v && v.vids.has(vid) && !v.untagged.has(vid);
};

/** A VLAN interface (or any port) is up and has the address. */
const upWith = (ctx: TaskContext, name: string, port: string, cidr: string): boolean =>
  !!named(ctx.net, name)?.port(port)?.adminUp && hasAddr(ctx, name, port, cidr);

const forwardGuard = (d: Device | undefined) =>
  (d?.ip?.nf.tables ?? [])
    .flatMap((t) => t.chains)
    .find((c) => c.base?.hook === 'forward' && c.base.policy === 'drop');

const hasTable = (d: Device | undefined, name: string): boolean =>
  (d?.ip?.nf.tables ?? []).some((t) => t.name === name);

/** A rule of the router's forward chains (any table) passes `test`. */
const forwardRule = (d: Device | undefined, test: (r: Rule) => boolean): boolean =>
  (d?.ip?.nf.tables ?? []).some((t) =>
    t.chains.some((c) => c.base?.hook === 'forward' && c.rules.some(test)),
  );

/** The WireGuard interface of a router, whatever it is called. */
const wgPort = (d: Device | undefined): Port | undefined =>
  d?.vlanPorts.find((p) => d.wireguard(p));

/** Tunnel `a` lists the public key of tunnel `b` as a peer. */
const peeredWith = ({ net }: TaskContext, a: string, b: string): boolean => {
  const x = named(net, a);
  const y = named(net, b);
  const key = y && tunnelOf(y)?.publicKey;
  return !!x && !!key && !!tunnelOf(x)?.peers.some((p) => p.publicKey === key);
};

/** The checklist that creates a WireGuard tunnel interface on a router. */
const wgParts = (router: string, tunnelIp: string): TaskPart[] => [
  {
    text: `Create the wg0 interface on ${router}`,
    code: 'ip link add wg0 type wireguard',
    on: router,
    done: ({ net }) => !!wgPort(named(net, router)),
  },
  {
    text: `Generate ${router}’s private key`,
    code: 'wg genkey > /etc/wireguard/key',
    on: router,
    done: ({ net }) => (named(net, router)?.fs?.read('/etc/wireguard/key') ?? '').trim() !== '',
  },
  {
    text: `Give wg0 the key and a listening port on ${router}`,
    code: 'wg set wg0 private-key /etc/wireguard/key listen-port 51820',
    on: router,
    done: ({ net }) => {
      const d = named(net, router);
      return !!d && tunnelOf(d) !== null;
    },
  },
  {
    text: `Give wg0 its tunnel address and bring it up on ${router}`,
    code: `ip addr add ${tunnelIp}/24 dev wg0 && ip link set wg0 up`,
    on: router,
    done: (ctx) => upWith(ctx, router, 'wg0', `${tunnelIp}/24`),
  },
];

/** The checklist that shows a router’s public key, makes the other router its peer and routes to it. */
const peerParts = (
  router: string,
  other: string,
  endpoint: string,
  allowed: string,
  lan: string,
): TaskPart[] => [
  {
    text: `Print ${other}’s public key`,
    code: 'wg show',
    on: other,
    done: (ctx) => typed(ctx, other, /^wg(\s+show(\s+wg0)?)?\s*$/),
  },
  {
    text: `Add ${other} as a peer on ${router}: paste its key in place of the placeholder`,
    code: `wg set wg0 peer <public key of ${other}> endpoint ${endpoint}:51820 allowed-ips ${allowed}`,
    on: router,
    done: (ctx) => peeredWith(ctx, router, other),
  },
  {
    text: `Send ${other}’s network into the tunnel on ${router}`,
    code: `ip route add ${lan} dev wg0`,
    on: router,
    done: (ctx) => routeDev(ctx, router, 'wg0', lan),
  },
];

/**
 * The fourteen tasks are chapters of one network that keeps growing: each task's steps ask only
 * for what is new compared with the finished network of the one before (see solutions.ts,
 * which scripts every chapter). A step must not be true on that finished network, or the
 * chapter would complete the moment it starts.
 */
export const TASKS: Task[] = [
  {
    id: 'first-ping',
    title: 'Day one: connect two desks',
    summary:
      'Build the smallest possible network, two computers and one cable, and send your first ping.',
    brief: {
      from: 'Maya, office manager',
      text: 'Welcome aboard! Two of us just got new desks and we want to share files between them. Could you get the two computers talking to each other?',
    },
    steps: [
      {
        title: 'Add two PCs',
        detail: 'Drag a PC from the left panel onto the canvas, twice. You can also click it.',
        parts: [
          { text: 'Add the first PC', done: ({ net }) => hosts(net).length >= 1 },
          { text: 'Add the second PC', done: ({ net }) => hosts(net).length >= 2 },
        ],
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
          'Computers find each other by IP address, so each one needs its own. Click a PC to open it, then Desktop → Terminal. Prefer forms? Desktop → IP Configuration does the same.',
        hint: '`eth0` is the name of the network port. `/24` says the first three numbers are the network part.',
        check: ({ net }) =>
          cabledHostPairs(net).some(([a, b]) => addrsOf(a).length > 0 || addrsOf(b).length > 0),
        parts: [
          {
            text: 'Give pc1 an address',
            code: 'ip addr add 192.168.1.10/24 dev eth0',
            on: 'pc1',
            done: (ctx) => hasAddress(ctx, 'pc1'),
          },
        ],
      },
      {
        title: 'Give the second PC an address in the same network',
        detail:
          'Two computers talk directly only when their addresses are in the same network. Open the other PC, in the Terminal or in IP Configuration.',
        hint: 'With /24, both addresses must start with the same three numbers (192.168.1) and end differently.',
        check: ({ net }) => cabledHostPairs(net).some(([a, b]) => shareSubnet(a, b)),
        parts: [
          {
            text: 'Give pc2 an address in pc1’s network',
            code: 'ip addr add 192.168.1.20/24 dev eth0',
            on: 'pc2',
            done: (ctx) => sharesNetwork(ctx, 'pc2', 'pc1'),
          },
        ],
      },
      {
        title: 'Ping one PC from the other',
        detail:
          'A ping sends a small message and waits for the answer: the quickest way to see that two machines can reach each other.',
        hint: 'No reply? Check both addresses with `ip addr`. Each PC must have its own address in the same network.',
        parts: [
          {
            text: 'Ping pc1 from pc2',
            code: 'ping -c 1 192.168.1.10',
            on: 'pc2',
            done: (ctx) => gotReply(ctx, 'pc2', 'pc1'),
          },
        ],
        // Either PC may ping the other.
        check: ({ net }) => cabledHostPairs(net).some(([a, b]) => pinged(a, [b]) || pinged(b, [a])),
      },
    ],
    done: 'Maya: “Thanks, our two desks are talking!” Congratulations! You have two computers that can talk to each other. Before the first ping, the PC used ARP to find the other PC’s MAC address. Switch to Simulation mode and ping again to watch it happen. Next task: a third computer means you need a switch, and your network keeps growing.',
  },
  {
    id: 'meet-the-switch',
    title: 'Room for a third desk',
    summary:
      'Replace the cable with a switch, add a third computer and see what the switch learns.',
    brief: {
      from: 'Maya, office manager',
      text: 'Someone new joins on Monday, and one cable between two computers will not stretch to three. Can you set up a way for everybody to plug in?',
    },
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
          'A PC has one port, so moving it to the switch also removes the old PC-to-PC cable. Grab the end of a cable in its port and drag it to a free port on sw1 (or onto the switch itself to pick from a list); the other end stays where it is. Or click the cable and press Delete, then cable the PC to sw1 again.',
        check: ({ net }) =>
          cabledHostPairs(net).length === 0 && switches(net).some((sw) => hostsOn(sw).length >= 2),
        parts: [
          { text: 'Plug pc1 into sw1', done: (ctx) => wiredToSwitch(ctx, 'pc1') },
          { text: 'Plug pc2 into sw1', done: (ctx) => wiredToSwitch(ctx, 'pc2') },
        ],
      },
      {
        title: 'Add a third PC',
        detail: 'The new desk needs its own computer, plugged into the same switch.',
        check: ({ net }) => switches(net).some((sw) => hostsOn(sw).length >= 3),
        parts: [
          { text: 'Add a third PC', done: ({ net }) => hosts(net).length >= 3 },
          { text: 'Cable pc3 to sw1', done: (ctx) => wiredToSwitch(ctx, 'pc3') },
        ],
      },
      {
        title: 'Give the new PC an address in the same network',
        detail:
          'It must be in the same network as pc1 and pc2, or the switch cannot help it. IP Configuration works too.',
        hint: 'It must start with the same three numbers as pc1 and pc2 (192.168.1) and end with a number nobody uses yet.',
        check: ({ net }) => switches(net).some((sw) => largestSubnetGroup(hostsOn(sw)) >= 3),
        parts: [
          {
            text: 'Give pc3 an address',
            code: 'ip addr add 192.168.1.30/24 dev eth0',
            on: 'pc3',
            done: (ctx) => sharesNetwork(ctx, 'pc3', 'pc1') && sharesNetwork(ctx, 'pc3', 'pc2'),
          },
        ],
      },
      {
        title: 'Ping the other two PCs from pc3',
        detail: 'The packets now travel through the switch.',
        check: ({ net }) =>
          switches(net).some((sw) => {
            const group = hostsOn(sw);
            return group.some((h) => group.every((o) => o === h || pinged(h, [o])));
          }),
        parts: [
          {
            text: 'Ping pc1 from pc3',
            code: 'ping -c 1 192.168.1.10',
            on: 'pc3',
            done: (ctx) => gotReply(ctx, 'pc3', 'pc1'),
          },
          {
            text: 'Ping pc2 from pc3',
            code: 'ping -c 1 192.168.1.20',
            on: 'pc3',
            done: (ctx) => gotReply(ctx, 'pc3', 'pc2'),
          },
        ],
      },
      {
        title: 'Look at what the switch learned',
        detail: 'Click the switch and open its CLI tab.',
        hint: 'Each line is a MAC address and the port it was seen on. That is how the switch knows where to send frames.',
        check: (ctx) => ran(ctx, /^bridge\s+fdb(\s+show)?$/, isSwitch),
        parts: [
          {
            text: 'Show the switch’s MAC address table',
            code: 'bridge fdb show',
            on: 'sw1',
            done: (ctx) => typed(ctx, 'sw1', /^bridge\s+fdb(\s+show)?$/),
          },
        ],
      },
    ],
    done: 'Maya: “Monday is saved, thank you!” Well done! A switch learns which MAC address lives behind which port by reading the source of every frame. Unknown destinations and broadcasts (like ARP requests) go out of every other port. Next task: a second network, joined to this one by a router.',
  },
  {
    id: 'two-networks',
    title: 'Open the back office',
    summary: 'Join your switch network to a second network with a router and trace the path.',
    brief: {
      from: 'Sam, founder',
      text: 'We rented the room next door for the back office. It needs its own network, but people there still have to reach our computers. Can you link the two?',
    },
    steps: [
      {
        title: 'Add a router and a fourth PC',
        detail:
          'A router joins separate networks. The new PC will live in a second network, on the other side of it.',
        parts: [
          { text: 'Add a router', done: ({ net }) => routers(net).length > 0 },
          { text: 'Add a fourth PC', done: ({ net }) => hosts(net).length >= 4 },
        ],
      },
      {
        title: 'Cable sw1 and the new PC to the router',
        detail:
          'Each router port is a separate network: sw1 with its three PCs on one, pc4 on the other. Cable to any free switch port.',
        check: ({ net }) =>
          routers(net).some((r) => new Set(pcsOnRouter(r).map((l) => l.port)).size >= 2),
        parts: [
          {
            text: 'Cable r1’s `eth0` to sw1',
            done: ({ net }) => {
              const port = named(net, 'r1')?.port('eth0');
              const peer = port && peerOf(port)?.device;
              return !!peer && isSwitch(peer);
            },
          },
          {
            text: 'Cable pc4 to r1’s `eth1`',
            done: ({ net }) => {
              const port = named(net, 'pc4')?.port('eth0');
              const peer = port && peerOf(port);
              return peer?.device.name === 'r1' && peer.name === 'eth1';
            },
          },
        ],
      },
      {
        title: 'Give the router an address in each network',
        detail:
          'The router needs a foot in both networks: one address on each port. Use Config in r1’s window if you prefer forms.',
        hint: 'Two different networks: the third number differs (1 and 2). `eth0` joins the network the three PCs already use.',
        check: ({ net }) =>
          routers(net).some((r) => {
            const nets = new Set(
              pcsOnRouter(r).flatMap(({ port }) =>
                (r.ip?.addrsOn(port) ?? []).map((a) => `${networkOf(a)}/${a.prefix}`),
              ),
            );
            return nets.size >= 2;
          }),
        parts: [
          {
            text: 'Give r1’s `eth0` an address in the PCs’ network',
            code: 'ip addr add 192.168.1.1/24 dev eth0',
            on: 'r1',
            done: ({ net }) => {
              const router = named(net, 'r1');
              const port = router?.port('eth0');
              const pc = named(net, 'pc1');
              return (
                !!router &&
                !!port &&
                !!pc &&
                (router.ip?.addrsOn(port) ?? []).some((a) =>
                  addrsOf(pc).some((b) => sameSubnet(a, b)),
                )
              );
            },
          },
          {
            text: 'Give r1’s `eth1` an address for the new network',
            code: 'ip addr add 192.168.2.1/24 dev eth1',
            on: 'r1',
            done: ({ net }) => {
              const router = named(net, 'r1');
              const port = router?.port('eth1');
              return !!router && !!port && (router.ip?.addrsOn(port) ?? []).length > 0;
            },
          },
        ],
      },
      {
        title: 'Give pc4 an address in its router port’s network',
        detail: 'pc4 is cabled to `eth1`, so its address must be in the network `eth1` serves.',
        check: ({ net }) => routedPair(net, pcInPortNetwork),
        parts: [
          {
            text: 'Give pc4 an address',
            code: 'ip addr add 192.168.2.10/24 dev eth0',
            on: 'pc4',
            done: ({ net }) => {
              const hit = routedLink(net, 'pc4');
              return !!hit && pcInPortNetwork(hit.router, hit.link);
            },
          },
        ],
      },
      {
        title: 'Tell every PC where the router is',
        detail:
          'A PC reaches other networks only through its default gateway: the router’s address in its own network. IP Configuration has a gateway field too.',
        hint: 'Try a ping before this step: you get “Network is unreachable”. The gateway fixes that.',
        check: ({ net }) =>
          routedPair(net, (r, l) => pcInPortNetwork(r, l) && gatewayIsRouter(r, l)) &&
          // Every PC that is already addressed in its router's network needs the gateway too.
          routers(net).every((r) =>
            pcsOnRouter(r).every((l) => !pcInPortNetwork(r, l) || gatewayIsRouter(r, l)),
          ),
        parts: [
          gatewayPart('pc1', '192.168.1.1'),
          gatewayPart('pc2', '192.168.1.1'),
          gatewayPart('pc3', '192.168.1.1'),
          gatewayPart('pc4', '192.168.2.1'),
        ],
      },
      {
        title: 'Ping across the router',
        detail:
          'Notice `ttl=63` in the reply: the router took one off, proof the packet crossed it.',
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
        parts: [
          {
            text: 'Ping a PC in the other network',
            code: 'ping -c 1 192.168.1.10',
            on: 'pc4',
            done: (ctx) => gotReply(ctx, 'pc4', 'pc1'),
          },
        ],
      },
      {
        title: 'See the path with traceroute',
        detail: 'The first hop it lists is the router.',
        check: (ctx) => ran(ctx, /^traceroute\s/, isPc),
        parts: [
          {
            text: 'Trace the path to pc1',
            code: 'traceroute 192.168.1.10',
            on: 'pc4',
            done: (ctx) => typed(ctx, 'pc4', /^traceroute\s/),
          },
        ],
      },
    ],
    done: 'Sam: “The back office is connected, great work!” You routed between two networks! The PC saw that the destination was not in its own network, so it sent the packet to its gateway. The router looked up its routing table, lowered the TTL and passed it on. Next task: stop typing addresses by hand.',
  },
  {
    id: 'dhcp',
    title: 'No more sticky notes',
    summary: 'Let the router hand out addresses with DHCP, then reach a PC by its name.',
    brief: {
      from: 'Maya, office manager',
      text: 'Everyone keeps typing addresses from sticky notes and getting them wrong. Can the network give out addresses by itself, and let us use names instead of numbers?',
    },
    steps: [
      {
        title: 'Start a DHCP server on the router',
        detail:
          'A DHCP server hands out addresses to anyone who asks. r1 already has `192.168.1.1/24` on the port to sw1, so it can serve that network. In r1’s window: Config → DHCP and DNS server → Start server.',
        check: ({ net }) =>
          dhcpSegments(net).some((s) => {
            const subnets = s.router.ip?.addrsOn(s.port) ?? [];
            const ranges = s.router.dnsmasq?.config.ranges ?? [];
            return ranges.some((r) => subnets.some((a) => inSubnet(r.start, a)));
          }),
        parts: [
          {
            text: 'Start the DHCP server on r1',
            code: 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199',
            on: 'r1',
            done: ({ net }) =>
              dhcpSegments(net).some((s) => {
                const ranges = s.router.dnsmasq?.config.ranges ?? [];
                return (
                  s.router.name === 'r1' &&
                  ranges.some((r) =>
                    (s.router.ip?.addrsOn(s.port) ?? []).some((a) => inSubnet(r.start, a)),
                  )
                );
              }),
          },
        ],
      },
      {
        title: 'Let pc1, pc2 and pc3 ask for an address',
        detail:
          'Each PC first forgets the address you typed, then asks the DHCP server for one. The IP Configuration window has the same thing: Get an address automatically.',
        hint: 'Switch to Simulation mode first to watch the four DHCP messages: Discover, Offer, Request, Ack.',
        check: ({ net }) =>
          dhcpSegments(net).some(
            (s) => (s.router.dnsmasq?.activeLeases().length ?? 0) >= s.pcs.length,
          ),
        parts: ['pc1', 'pc2', 'pc3'].map((pc) => ({
          text: `Let ${pc} get its address from r1`,
          code: 'ip addr flush dev eth0 && dhclient eth0',
          on: pc,
          done: (ctx: TaskContext) => hasLease(ctx, pc),
        })),
      },
      {
        title: 'Reach a PC by its name',
        detail:
          'The DHCP server also answers DNS for its clients, so names work as well as numbers.',
        check: (ctx) =>
          ran(ctx, PING_BY_NAME, isPc) &&
          dhcpSegments(ctx.net).some((s) => s.pcs.some((pc) => pinged(pc, s.pcs))),
        parts: [
          {
            text: 'Ping pc2 by name from pc1',
            code: 'ping -c 1 pc2',
            on: 'pc1',
            done: (ctx) => typed(ctx, 'pc1', PING_BY_NAME) && gotReply(ctx, 'pc1', 'pc2'),
          },
        ],
      },
    ],
    done: 'Maya: “No more sticky notes, thank you!” No typing addresses by hand! The PCs broadcast a DHCP Discover, the server offered an address with a gateway and DNS server, and the PCs took it. The server remembered their names, so DNS could answer for them. Next task: the office gets its first shared devices.',
  },
  {
    id: 'first-print',
    title: 'Print your first page',
    summary:
      'Plug a network printer into the office LAN, let DHCP configure it and send it a page.',
    brief: {
      from: 'Maya, office manager',
      text: 'We keep walking papers to the one old printer upstairs. Could you put a network printer on the office network so all of us can print from our desks?',
    },
    steps: [
      {
        title: 'Plug a printer into sw1',
        detail:
          'Add a Printer from the left panel and drag a cable from its port to a free port of sw1, for example `eth3`.',
        check: ({ net }) => appliancesOn(net, 'printer').length > 0,
      },
      {
        title: 'Let the printer get an address',
        detail:
          'A printer asks for an address with DHCP as soon as it is cabled. Open it and look at its Config tab: the address must be in the office network (`192.168.1.x`). Wait a moment if it is empty.',
        hint: 'No address? Check that r1 still runs its DHCP server and that the printer is cabled to sw1, not to a PC.',
        check: ({ net }) => appliancesOn(net, 'printer').some(addressedByRouter),
      },
      {
        title: 'Open the printer’s status page',
        detail:
          'Every network printer shows a small web page. The name works because the DHCP server registered it; the printer’s address works too, and so does the Browser app.',
        check: ({ net }) => appliancesOn(net, 'printer').some((p) => reachedByPc(net, p)),
        parts: [
          {
            text: 'Fetch the printer’s status page',
            code: 'curl http://printer1/',
            on: 'pc1',
            done: (ctx) => connected(ctx, 'pc1', 'printer1'),
          },
        ],
      },
      {
        title: 'Print a page',
        detail:
          'Port 9100 is the raw print port most network printers listen on: whatever you send there is printed. The status page counts the pages.',
        hint: 'The `<` hands the file to the command, like pasting it in.',
        check: ({ net }) => appliancesOn(net, 'printer').some((p) => (p.printer?.pages ?? 0) >= 1),
        parts: [
          {
            text: 'Write a small text file',
            code: 'echo Hello > letter.txt',
            on: 'pc1',
            done: (ctx) => typed(ctx, 'pc1', /^echo\s.*>\s*letter\.txt\s*$/),
          },
          {
            text: 'Send the file to the printer',
            code: 'nc printer1 9100 < letter.txt',
            on: 'pc1',
            done: ({ net }) => (named(net, 'printer1')?.printer?.pages ?? 0) >= 1,
          },
        ],
      },
    ],
    done: 'Maya: “It printed! Everyone can print from their desk now.” A printer is a small computer with a network card: it got its address with DHCP, shows a web page on port 80 and takes print jobs on TCP port 9100. Next task: the front door needs a camera.',
  },
  {
    id: 'lobby-camera',
    title: 'Watch the front door',
    summary: 'Add an IP camera to the office LAN and watch its live stream from a PC.',
    brief: {
      from: 'Sam, founder',
      text: 'Security wants a camera at the entrance, and I want to check the door from my desk. Can you connect an IP camera and show me its stream?',
    },
    steps: [
      {
        title: 'Plug an IP camera into sw1',
        detail:
          'Add an IP Camera from the left panel and cable it to a free port of sw1, for example `eth4`.',
        check: ({ net }) => appliancesOn(net, 'camera').length > 0,
      },
      {
        title: 'Let the camera get an address',
        detail:
          'Like the printer, the camera asks for an address with DHCP. Open it and look at its Config tab: the address must be in the office network (`192.168.1.x`).',
        check: ({ net }) => appliancesOn(net, 'camera').some(addressedByRouter),
      },
      {
        title: 'Watch the stream from a PC',
        detail:
          'The camera connects the viewer and sends one frame per second: `frame 1`, `frame 2`... Stop it with Ctrl+C once you have seen a few.',
        hint: 'The connection uses TCP port 554 (the RTSP port); the pictures travel as UDP packets, so a firewall that drops them leaves you with a blank screen.',
        check: (ctx) =>
          appliancesOn(ctx.net, 'camera').some((cam) =>
            hosts(ctx.net).some(
              (pc) =>
                ran(ctx, /^nc\s+(?!-z\b)\S+\s+554\s*$/, (d) => d === pc) &&
                addrsOf(cam).some((a) => pc.ip?.tcp.connectedTo.has(a.ip)),
            ),
          ),
        parts: [
          {
            text: 'Connect to the camera’s stream',
            code: 'nc cam1 554',
            on: 'pc1',
            done: (ctx) =>
              typed(ctx, 'pc1', /^nc\s+(?!-z\b)\S+\s+554\s*$/) && connected(ctx, 'pc1', 'cam1'),
          },
        ],
      },
    ],
    done: 'Sam: “I can see the lobby from my desk, thank you!” The viewer opened a TCP connection to the camera and the camera answered with a stream of UDP packets, one per second, until you pressed Ctrl+C. Next task: Wi-Fi for the meeting room.',
  },
  {
    id: 'meeting-room-wifi',
    title: 'Wi-Fi for the meeting room',
    summary:
      'Put an access point on the office LAN, give it the company’s own Wi-Fi name and password and join a laptop and a phone.',
    brief: {
      from: 'Maya, office manager',
      text: 'People bring laptops and phones to meetings and there are no cables in the meeting room. Can you set up Wi-Fi there, with our own name and password, not the one from the box?',
    },
    steps: [
      {
        title: 'Plug an access point into sw1',
        detail:
          'Add an Access Point from the left panel and cable it to a free port of sw1, for example `eth5`. It bridges the Wi-Fi clients onto the wired network.',
        check: ({ net }) => ofSpec(net, 'ap').some((ap) => neighborsOf(ap).some(isSwitch)),
      },
      {
        title: 'Give the Wi-Fi the office’s own name and password',
        detail:
          'A new access point broadcasts `NetForge` with a password everybody knows. Open it → Config → Wireless (hostapd), then Save and restart.',
        hint: 'Both must change: the default name and the default password are public, so anyone could join a network that still uses them. In its CLI: edit `/etc/hostapd/hostapd.conf`, run `killall hostapd` and `hostapd -B /etc/hostapd/hostapd.conf`.',
        check: ({ net }) => officeAps(net).length > 0,
        parts: [
          {
            text: 'Choose a network name, such as `Office`',
            done: ({ net }) => {
              const ssid = named(net, 'ap1')?.hostapd?.ssid;
              return ssid !== undefined && ssid !== FACTORY_SSID;
            },
          },
          {
            text: 'Choose a new WPA2 password of at least 8 characters',
            done: ({ net }) => {
              const pass = named(net, 'ap1')?.hostapd?.passphrase;
              return pass !== undefined && pass !== null && pass !== FACTORY_PASSWORD;
            },
          },
        ],
      },
      {
        title: 'Bring a laptop and a phone into the meeting room',
        detail:
          'Add a Laptop and a Phone and drag both inside the access point’s dashed range circle. Or on each: Desktop → Wi-Fi → Connect.',
        hint: 'Out of range, the list of networks is empty. Move the device closer to the access point. Use your own network name and password in the command.',
        check: ({ net }) =>
          officeAps(net).some(
            (ap) =>
              clientsOf(net, ap, 'laptop').length > 0 && clientsOf(net, ap, 'phone').length > 0,
          ),
        parts: ['laptop1', 'phone1'].map((client) => ({
          text: `Connect ${client} to your Wi-Fi`,
          code: 'nmcli dev wifi connect Office password <your password>',
          on: client,
          done: ({ net }: TaskContext) => {
            const c = named(net, client);
            return !!c && officeAps(net).some((ap) => associatedAp(c) === ap);
          },
        })),
      },
      {
        title: 'Let both get an address from the office DHCP server',
        detail:
          'Joining Wi-Fi is like plugging in a cable: you still need an address. It must be in the office network (`192.168.1.x`). IP Configuration → Get an address automatically does the same.',
        check: ({ net }) =>
          officeAps(net).some(
            (ap) =>
              clientsOf(net, ap, 'laptop').some(addressedByRouter) &&
              clientsOf(net, ap, 'phone').some(addressedByRouter),
          ),
        parts: ['laptop1', 'phone1'].map((client) => ({
          text: `Let ${client} ask for an address`,
          code: 'dhclient wlan0',
          on: client,
          done: ({ net }: TaskContext) => {
            const c = named(net, client);
            return !!c && addressedByRouter(c);
          },
        })),
      },
      {
        title: 'Open the printer’s page from the phone',
        detail: 'The Wi-Fi client is now an ordinary member of the office LAN.',
        check: ({ net }) =>
          appliancesOn(net, 'printer').some((p) => reachedBy(ofSpec(net, 'phone'), p)),
        parts: [
          {
            text: 'Fetch the printer’s status page',
            code: 'curl http://printer1/',
            on: 'phone1',
            done: (ctx) => connected(ctx, 'phone1', 'printer1'),
          },
        ],
      },
    ],
    done: 'Maya: “The meeting room has Wi-Fi now, thanks!” An access point is a bridge between radio and cable: the phone and laptop joined by network name and WPA2 password, then asked the same DHCP server as the wired PCs and landed in the same network. Changing the factory name and password matters, because those are known to everybody. Next task: a home page for the team.',
  },
  {
    id: 'intranet',
    title: 'Our own intranet',
    summary:
      'Add a server with a fixed address, start its web server, write the home page and open it over Wi-Fi.',
    brief: {
      from: 'Sam, founder',
      text: 'The team wants one home page with the news and the links everybody needs. Can you host it on our own network, so we can open it from our laptops and phones?',
    },
    steps: [
      {
        title: 'Plug a server into sw1 and give it a fixed address',
        detail:
          'Add a Server and cable it to a free port of sw1, for example `eth6`. A server must not change address, or everybody’s bookmarks break, so it does not use DHCP: it gets an address outside the DHCP range (`192.168.1.100`–`.199`) and the router as gateway.',
        hint: 'An address inside the DHCP range could be handed to another device later: two machines would then fight over it.',
        parts: [
          { text: 'Plug srv1 into sw1', done: (ctx) => wiredToSwitch(ctx, 'srv1') },
          {
            text: 'Give srv1 an address outside the DHCP range',
            code: 'ip addr add 192.168.1.5/24 dev eth0',
            on: 'srv1',
            done: ({ net }) => {
              const d = named(net, 'srv1');
              return !!d && outsideDhcp(d);
            },
          },
          {
            text: 'Give srv1 the router as its gateway',
            code: 'ip route add default via 192.168.1.1',
            on: 'srv1',
            done: ({ net }) => {
              const d = named(net, 'srv1');
              return !!d && lanGateway(d);
            },
          },
        ],
        check: ({ net }) =>
          ofSpec(net, 'server').some((s) => neighborsOf(s).some(isSwitch) && fixedAddress(s)),
      },
      {
        title: 'Start the web server',
        detail:
          'A web server is a program that answers on TCP port 80 with the files of one folder, `/var/www/html`. Open the server → Config → Start web server, or use its Terminal.',
        parts: [
          {
            text: 'Start the web server on srv1',
            code: 'httpd',
            on: 'srv1',
            done: ({ net }) => !!named(net, 'srv1')?.httpd,
          },
        ],
        check: ({ net }) => ofSpec(net, 'server').some((s) => s.httpd !== null),
      },
      {
        title: 'Write your own home page',
        detail:
          'The server starts with a sample page. Replace it with your own: Desktop → Text Editor → `/var/www/html/index.html` does the same as the command.',
        parts: [
          {
            text: 'Replace the sample page on srv1',
            code: 'echo "<h1>Our intranet</h1>" > /var/www/html/index.html',
            on: 'srv1',
            done: ({ net }) => {
              const d = named(net, 'srv1');
              return !!d && ownPage(d);
            },
          },
        ],
        check: ({ net }) =>
          ofSpec(net, 'server').some((s) => {
            const page = s.fs?.read(SERVER_PAGE);
            return (
              page !== undefined && page.trim() !== '' && page !== SPECS.server.files?.[SERVER_PAGE]
            );
          }),
      },
      {
        title: 'Open the home page over Wi-Fi',
        detail:
          'A phone on the Wi-Fi is an ordinary member of the office LAN. The Web Browser app opens the page too; use your server’s address if you chose another one.',
        parts: [
          {
            text: 'Fetch the home page from phone1',
            code: 'curl http://192.168.1.5/',
            on: 'phone1',
            done: ({ net }) => {
              const c = named(net, 'phone1');
              const s = named(net, 'srv1');
              return !!c && !!s && associatedAp(c) !== null && reachedBy([c], s);
            },
          },
        ],
        check: ({ net }) =>
          ofSpec(net, 'server').some((s) =>
            [...ofSpec(net, 'laptop'), ...ofSpec(net, 'phone')].some(
              (c) => associatedAp(c) !== null && reachedBy([c], s),
            ),
          ),
      },
    ],
    done: 'Sam: “Now everybody starts the day on our own page, thank you!” A web server is a program that answers on TCP port 80 with the files of one folder. It has a fixed address because clients look for it there, so that address lies outside the DHCP range. Your phone reached it over Wi-Fi, through the access point and the switch, like any wired PC. Next task: split sw1 into separate networks.',
  },
  {
    id: 'vlans',
    title: 'Keep accounting private',
    summary: 'Turn one switch into two separate networks with VLANs, without new hardware.',
    brief: {
      from: 'Sam, founder',
      text: 'Accounting works on the same switch as everyone else, and I want their computers kept apart from the rest for privacy. I would rather not buy a second switch.',
    },
    steps: [
      {
        title: 'Turn on VLAN filtering',
        detail:
          'VLAN filtering is what makes a switch honour VLANs. Open sw1 → Config → VLANs → tick VLAN filtering.',
        hint: 'Until filtering is on, a Linux bridge ignores VLAN settings: every port is in one network.',
        parts: [
          {
            text: 'Turn on VLAN filtering on sw1',
            code: 'ip link set br0 type bridge vlan_filtering 1',
            on: 'sw1',
            done: ({ net }) => !!named(net, 'sw1')?.bridge?.vlanFiltering,
          },
        ],
        check: ({ net }) => switches(net).some((sw) => sw.bridge?.vlanFiltering),
      },
      {
        title: 'Put two PCs in VLAN 10 and one in VLAN 20',
        detail:
          'An access port belongs to one VLAN: whatever the PC sends goes into it, and only that VLAN’s frames come out. Make the PC ports access ports: pc1 and pc2 in VLAN 10, pc3 in VLAN 20. The port to r1 stays in VLAN 1, so r1 is cut off for now. Config → VLANs does the same.',
        hint: '`pvid` puts untagged frames from the PC into that VLAN; `untagged` sends that VLAN’s frames to the PC without a tag. The PCs are usually on `eth0`, `eth1` and `eth2`.',
        parts: [
          {
            text: 'Move pc1’s switch port (`eth0`) to VLAN 10',
            code: 'bridge vlan add dev eth0 vid 10 pvid untagged && bridge vlan del dev eth0 vid 1',
            on: 'sw1',
            done: (ctx) => accessVlan(ctx, 'pc1', 10),
          },
          {
            text: 'Move pc2’s switch port (`eth1`) to VLAN 10',
            code: 'bridge vlan add dev eth1 vid 10 pvid untagged && bridge vlan del dev eth1 vid 1',
            on: 'sw1',
            done: (ctx) => accessVlan(ctx, 'pc2', 10),
          },
          {
            text: 'Move pc3’s switch port (`eth2`) to VLAN 20',
            code: 'bridge vlan add dev eth2 vid 20 pvid untagged && bridge vlan del dev eth2 vid 1',
            on: 'sw1',
            done: (ctx) => accessVlan(ctx, 'pc3', 20),
          },
        ],
        check: ({ net }) =>
          switches(net).some((sw) => {
            const groups = vlanGroups(sw);
            return groups.length >= 2 && groups.some((g) => g.length >= 2);
          }),
      },
      {
        title: 'Ping inside a VLAN',
        detail:
          'Two PCs in the same VLAN still reach each other. Use the address, not the name: the DNS server on r1 is out of reach now.',
        parts: [
          {
            text: 'Ping pc2 from pc1 (`ip addr` on pc2 shows its address)',
            code: 'ping -c 1 <address of pc2>',
            on: 'pc1',
            done: (ctx) => gotReply(ctx, 'pc1', 'pc2'),
          },
        ],
        check: ({ net }) =>
          switches(net).some((sw) => vlanGroups(sw).some((g) => g.some((pc) => pinged(pc, g)))),
      },
      {
        title: 'Try to reach the other VLAN',
        detail:
          'Same network addresses, same switch, but different VLANs: does pc3 answer? A ping that gets no reply still counts as a try.',
        parts: [
          {
            text: 'Ping pc3 from pc1 (`ip addr` on pc3 shows its address)',
            code: 'ping -c 1 -W 1 <address of pc3>',
            on: 'pc1',
            done: (ctx) => pingedAddress(ctx, 'pc1', 'pc3'),
          },
        ],
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
    done: 'Sam: “Accounting is private now, perfect.” No reply: the switch now keeps VLAN 10 and VLAN 20 apart, as if they were two switches. Even ARP broadcasts stay inside their VLAN. To connect VLANs you need a router: give it VLAN interfaces (Router → Config → VLAN interfaces) on a trunk port. That is the next task.',
  },
  {
    id: 'inter-vlan',
    title: 'Let the teams talk again',
    summary: 'Connect the two VLANs through one router cable, a “router on a stick”.',
    brief: {
      from: 'Maya, office manager',
      text: 'Now accounting cannot reach the shared files at all. Can you let the two teams talk again, but only through one controlled point?',
    },
    steps: [
      {
        title: 'Give each VLAN its own network',
        detail:
          'The router can only tell the VLANs apart when each has a network of its own: `192.168.10.x` for VLAN 10 and `192.168.20.x` for VLAN 20. Each PC first forgets its old address and gateway.',
        parts: [
          {
            text: 'Give pc1 an address in VLAN 10’s network',
            code: 'ip addr flush dev eth0 && ip route del default && ip addr add 192.168.10.10/24 dev eth0',
            on: 'pc1',
            done: (ctx) => hasIp(ctx, 'pc1', '192.168.10.10'),
          },
          {
            text: 'Give pc2 an address in VLAN 10’s network',
            code: 'ip addr flush dev eth0 && ip route del default && ip addr add 192.168.10.20/24 dev eth0',
            on: 'pc2',
            done: (ctx) => hasIp(ctx, 'pc2', '192.168.10.20'),
          },
          {
            text: 'Give pc3 an address in VLAN 20’s network',
            code: 'ip addr flush dev eth0 && ip route del default && ip addr add 192.168.20.10/24 dev eth0',
            on: 'pc3',
            done: (ctx) => hasIp(ctx, 'pc3', '192.168.20.10'),
          },
        ],
        check: ({ net }) => switches(net).some(vlansOwnNetworks),
      },
      {
        title: 'Turn the switch port to r1 into a trunk',
        detail:
          'A trunk carries many VLANs over one cable, each frame with an 802.1Q tag. r1 is already cabled to sw1 (port `eth7`). Make that switch port a trunk for VLANs 10 and 20: Config → VLANs → Trunk `10,20` does the same.',
        hint: 'A trunk sends frames with an 802.1Q tag, so one cable can carry many VLANs.',
        parts: [
          {
            text: 'Add VLAN 10 to the trunk port',
            code: 'bridge vlan add dev eth7 vid 10',
            on: 'sw1',
            done: (ctx) => trunks(ctx, 'sw1', 'eth7', 10),
          },
          {
            text: 'Add VLAN 20 to the trunk port',
            code: 'bridge vlan add dev eth7 vid 20',
            on: 'sw1',
            done: (ctx) => trunks(ctx, 'sw1', 'eth7', 20),
          },
        ],
        check: ({ net }) => trunkRouters(net).length > 0,
      },
      {
        title: 'Give r1 a VLAN interface per VLAN',
        detail:
          'r1 gets one virtual interface per VLAN on its port `eth0`, and each is r1’s foot in that VLAN’s network, with the first address of it. r1 → Config → VLAN interfaces does the same.',
        parts: [
          {
            text: 'Create the VLAN 10 interface on r1’s `eth0`',
            code: 'ip link add link eth0 name eth0.10 type vlan id 10 && ip link set eth0.10 up && ip addr add 192.168.10.1/24 dev eth0.10',
            on: 'r1',
            done: (ctx) => upWith(ctx, 'r1', 'eth0.10', '192.168.10.1/24'),
          },
          {
            text: 'Create the VLAN 20 interface on r1’s `eth0`',
            code: 'ip link add link eth0 name eth0.20 type vlan id 20 && ip link set eth0.20 up && ip addr add 192.168.20.1/24 dev eth0.20',
            on: 'r1',
            done: (ctx) => upWith(ctx, 'r1', 'eth0.20', '192.168.20.1/24'),
          },
        ],
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
          'Each PC’s default gateway is r1’s address in its own VLAN, because that is the only router it can reach directly.',
        parts: [
          {
            text: 'Give pc1 its gateway in VLAN 10',
            code: 'ip route add default via 192.168.10.1',
            on: 'pc1',
            done: (ctx) => defaultVia(ctx, 'pc1', '192.168.10.1'),
          },
          {
            text: 'Give pc2 its gateway in VLAN 10',
            code: 'ip route add default via 192.168.10.1',
            on: 'pc2',
            done: (ctx) => defaultVia(ctx, 'pc2', '192.168.10.1'),
          },
          {
            text: 'Give pc3 its gateway in VLAN 20',
            code: 'ip route add default via 192.168.20.1',
            on: 'pc3',
            done: (ctx) => defaultVia(ctx, 'pc3', '192.168.20.1'),
          },
        ],
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
            return ok.length >= 2 && ok.length === pcs.length;
          }),
      },
      {
        title: 'Ping across VLANs',
        detail: 'Watch the ping in Simulation mode: the frames to the router carry a VLAN tag.',
        parts: [
          {
            text: 'Ping pc3 from pc1',
            code: 'ping -c 1 192.168.20.10',
            on: 'pc1',
            done: (ctx) => gotReply(ctx, 'pc1', 'pc3'),
          },
        ],
        check: ({ net }) =>
          switches(net).some((sw) => {
            const groups = vlanGroups(sw);
            return groups.some((g) => g.some((pc) => groups.some((o) => o !== g && pinged(pc, o))));
          }),
      },
    ],
    done: 'Maya: “The teams can share files again, thanks!” The router received each packet tagged with VLAN 10 on eth0.10, routed it, and sent it back down the same cable tagged with VLAN 20. One physical port, two logical networks. Next task: a branch office with a second router.',
  },
  {
    id: 'ospf',
    title: 'Open the branch office',
    summary:
      'Add a branch office behind a second router and let the routers learn each other’s networks with OSPF.',
    brief: {
      from: 'Priya, branch manager',
      text: 'We are opening a branch across town and my team needs to reach the headquarters computers. Please connect our router to yours, and have them find each other’s networks on their own.',
    },
    steps: [
      {
        title: 'Add a second router',
        detail: 'Drag another Router onto the canvas. It will be the branch office’s router.',
        parts: [{ text: 'Add a second router', done: ({ net }) => routers(net).length >= 2 }],
        check: ({ net }) => routers(net).length >= 2,
      },
      {
        title: 'Add a PC and cable the branch',
        detail:
          'The branch gets its own PC (pc5) behind r2, and r1 and r2 are joined by one cable that becomes the link between the offices.',
        parts: [
          { text: 'Add a fifth PC', done: ({ net }) => hosts(net).length >= 5 },
          {
            text: 'Cable r1’s `eth2` to r2’s `eth1`',
            done: (ctx) => cabled(ctx, 'r1/eth2', 'r2/eth1'),
          },
          { text: 'Cable pc5 to r2’s `eth0`', done: (ctx) => cabled(ctx, 'pc5/eth0', 'r2/eth0') },
        ],
        check: ({ net }) => ospfPairs(net).length > 0,
      },
      {
        title: 'Address the new link and LAN',
        detail:
          'The cable between the routers is a tiny network of its own (a /30 has room for exactly two routers), and the branch LAN needs its own network, with r2 as the gateway of pc5.',
        parts: [
          {
            text: 'Give r1’s `eth2` its end of the link',
            code: 'ip addr add 10.0.0.1/30 dev eth2',
            on: 'r1',
            done: (ctx) => hasAddr(ctx, 'r1', 'eth2', '10.0.0.1/30'),
          },
          {
            text: 'Give r2’s `eth1` the other end of the link',
            code: 'ip addr add 10.0.0.2/30 dev eth1',
            on: 'r2',
            done: (ctx) => hasAddr(ctx, 'r2', 'eth1', '10.0.0.2/30'),
          },
          {
            text: 'Give r2’s `eth0` the branch network’s first address',
            code: 'ip addr add 192.168.3.1/24 dev eth0',
            on: 'r2',
            done: (ctx) => hasAddr(ctx, 'r2', 'eth0', '192.168.3.1/24'),
          },
          {
            text: 'Give pc5 an address in the branch network',
            code: 'ip addr add 192.168.3.10/24 dev eth0',
            on: 'pc5',
            done: (ctx) => hasIp(ctx, 'pc5', '192.168.3.10'),
          },
          {
            text: 'Give pc5 its gateway',
            code: 'ip route add default via 192.168.3.1',
            on: 'pc5',
            done: (ctx) => defaultVia(ctx, 'pc5', '192.168.3.1'),
          },
        ],
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
          'OSPF lets routers say hello to their neighbours, swap what networks they know and work out the routes themselves. Routers ship /etc/bird.conf with OSPF on every Ethernet port, so starting BIRD is enough. Config → Dynamic routing → Start OSPF does the same.',
        hint: 'It takes a little while before a neighbor is `Full`; run the last command again.',
        parts: [
          {
            text: 'Start BIRD on r1',
            code: 'bird',
            on: 'r1',
            done: ({ net }) => !!named(net, 'r1')?.bird,
          },
          {
            text: 'Start BIRD on r2',
            code: 'bird',
            on: 'r2',
            done: ({ net }) => !!named(net, 'r2')?.bird,
          },
          {
            text: 'Check that r1 sees a neighbor in state Full',
            code: 'birdc show ospf neighbors',
            on: 'r1',
            done: ({ net }) => !!named(net, 'r1')?.bird?.neighbors.some((n) => n.full),
          },
        ],
        check: ({ net }) =>
          ospfPairs(net).some(([a, b]) =>
            [a, b].every((r) => r.bird?.neighbors.some((n) => n.full)),
          ),
      },
      {
        title: 'See the learned route',
        detail:
          'The branch network `192.168.3.0/24` appears in r1’s routing table with `proto bird`: nobody typed it.',
        parts: [
          {
            text: 'Show r1’s routing table',
            code: 'ip route',
            on: 'r1',
            done: (ctx) =>
              typed(ctx, 'r1', /^(ip\s+r(o(u(te?)?)?)?|birdc\s+show\s+route)/) &&
              (named(ctx.net, 'r1')?.bird?.routes.length ?? 0) > 0,
          },
        ],
        check: (ctx) =>
          ran(ctx, /^(ip\s+r(o(u(te?)?)?)?|birdc\s+show\s+route)/, isRouter) &&
          ospfPairs(ctx.net).some(([a]) => (a.bird?.routes.length ?? 0) > 0),
      },
      {
        title: 'Ping the branch from headquarters',
        detail: 'The ping crosses both routers, over a route nobody typed.',
        parts: [
          {
            text: 'Ping pc4 from pc5',
            code: 'ping -c 1 192.168.2.10',
            on: 'pc5',
            done: (ctx) => gotReply(ctx, 'pc5', 'pc4'),
          },
        ],
        check: ({ net }) =>
          ospfPairs(net).some(([a, b]) => {
            const left = pcsOnRouter(a).map((l) => l.pc);
            const right = pcsOnRouter(b).map((l) => l.pc);
            return left.some((pc) => pinged(pc, right)) || right.some((pc) => pinged(pc, left));
          }),
      },
    ],
    done: 'Priya: “The branch is up and running, thank you!” Nobody typed a route: the routers said hello, swapped link-state advertisements, and each ran Dijkstra’s shortest path algorithm. Add a third router and a backup link, unplug a cable and watch them reroute. Next task: connect headquarters to the Internet.',
  },
  {
    id: 'nat',
    title: 'Get the office online',
    summary: 'Share one public address with the whole office using NAT, then add a firewall.',
    brief: {
      from: 'Sam, founder',
      text: 'Everybody needs the Internet, but we pay for only one public address, and I do not want strangers from outside walking in. Can you set that up?',
    },
    steps: [
      {
        title: 'Add the Internet and connect r1 to it',
        detail:
          'The Internet cloud stands for your provider and the rest of the world. r1’s `eth3` is the port that faces it.',
        parts: [
          { text: 'Add the Internet cloud', done: ({ net }) => ofSpec(net, 'internet').length > 0 },
          {
            text: 'Cable r1’s `eth3` to the cloud',
            done: (ctx) => cabled(ctx, 'r1/eth3', 'internet1'),
          },
        ],
        check: ({ net }) => natRouters(net).length > 0,
      },
      {
        title: 'Get a public address from the provider',
        detail: 'The cloud hands out a public address and a default route, like any DHCP server.',
        parts: [
          {
            text: 'Ask the provider for an address on r1’s `eth3`',
            code: 'dhclient eth3',
            on: 'r1',
            done: ({ net }) => {
              const r1 = named(net, 'r1');
              const port = r1?.port('eth3');
              return !!r1 && !!port && (r1.ip?.addrsOn(port).length ?? 0) > 0;
            },
          },
        ],
        check: ({ net }) =>
          natRouters(net).some(({ router, wan }) => (router.ip?.addrsOn(wan).length ?? 0) > 0),
      },
      {
        title: 'Turn on NAT',
        detail:
          'NAT rewrites the private source address of each outgoing packet to the router’s public one, and remembers the connection so it can rewrite the reply. In r1’s window: Config → Firewall and NAT → Share this connection (NAT), with `eth3` as the Internet side. The three commands below are what it runs.',
        hint: 'Without NAT the PCs’ packets reach the Internet, but nobody there knows the way back to 192.168.2.0/24.',
        parts: [
          {
            text: 'Create a table for NAT',
            code: 'nft add table ip nat',
            on: 'r1',
            done: ({ net }) => hasTable(named(net, 'r1'), 'nat'),
          },
          {
            text: 'Add a chain that runs after routing',
            code: 'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
            on: 'r1',
            done: ({ net }) =>
              (named(net, 'r1')?.ip?.nf.tables ?? []).some((t) =>
                t.chains.some((c) => c.base?.hook === 'postrouting'),
              ),
          },
          {
            text: 'Masquerade whatever leaves through `eth3`',
            code: 'nft add rule ip nat postrouting oifname "eth3" masquerade',
            on: 'r1',
            done: ({ net }) => {
              const r1 = named(net, 'r1');
              return !!r1 && masqueradesOn(r1, 'eth3');
            },
          },
        ],
        check: ({ net }) =>
          natRouters(net).some(({ router, wan }) => masqueradesOn(router, wan.name)),
      },
      {
        title: 'Ping the Internet from a PC',
        detail:
          'Ping the example website, `198.18.0.10`. Afterwards `conntrack -L` on r1 lists the connection NAT is remembering.',
        parts: [
          {
            text: 'Ping the example website from pc4',
            code: 'ping -c 1 198.18.0.10',
            on: 'pc4',
            done: ({ net }) => !!named(net, 'pc4')?.ip?.echoRepliesFrom.has(SITE_IP),
          },
        ],
        check: ({ net }) =>
          natRouters(net).some(({ router }) =>
            pcsOnRouter(router).some((l) => l.pc.ip?.echoRepliesFrom.has(SITE_IP)),
          ),
      },
      {
        title: 'Only let replies in',
        detail:
          'A firewall on r1 should let your PCs out and the answers back in, but drop anything that starts outside. That is a forward chain with policy drop and two accept rules. In the Config tab you can paste the hint into the ruleset editor instead of typing the commands.',
        hint: 'table ip filter { chain forward { type filter hook forward priority 0; policy drop; ct state established,related accept; iifname != "eth3" accept } }',
        parts: [
          {
            text: 'Create a table for filtering',
            code: 'nft add table ip filter',
            on: 'r1',
            done: ({ net }) => hasTable(named(net, 'r1'), 'filter'),
          },
          {
            text: 'Add a forward chain that drops by default',
            code: 'nft add chain ip filter forward { type filter hook forward priority 0 ; policy drop ; }',
            on: 'r1',
            done: ({ net }) => !!forwardGuard(named(net, 'r1')),
          },
          {
            text: 'Accept replies to connections that exist',
            code: 'nft add rule ip filter forward ct state established,related accept',
            on: 'r1',
            done: ({ net }) =>
              forwardRule(named(net, 'r1'), (r) =>
                r.matches.some((m) => m.kind === 'ct' && m.states.includes('established')),
              ),
          },
          {
            text: 'Accept traffic that does not come from `eth3`',
            code: 'nft add rule ip filter forward iifname != "eth3" accept',
            on: 'r1',
            done: ({ net }) =>
              forwardRule(
                named(net, 'r1'),
                (r) =>
                  r.action.kind === 'accept' &&
                  r.matches.some((m) => m.kind === 'iifname' && m.neg && m.name === 'eth3'),
              ),
          },
          {
            text: 'Ping again: replies still get through',
            code: 'ping -c 1 198.18.0.10',
            on: 'pc4',
            done: ({ net }) =>
              !!forwardGuard(named(net, 'r1')) &&
              (named(net, 'r1')
                ?.ip?.nf.connections()
                .some((c) => c.replied) ??
                false),
          },
        ],
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
    done: 'Sam: “We are online and safe, excellent!” Your PCs used the router’s public address: NAT rewrote each packet on the way out and remembered the connection (conntrack) to rewrite the replies. The firewall now drops anything that starts outside, while replies to your own connections still come back. Next task: Wi-Fi for visitors.',
  },
  {
    id: 'guest-wifi',
    title: 'Wi-Fi for visitors',
    summary:
      'Give visitors their own Wi-Fi network with a home router: a separate subnet and a firewall rule that keeps them out of the office.',
    brief: {
      from: 'Sam, founder',
      text: 'Visitors keep asking me for the office Wi-Fi password, and I do not want to hand it out. Give them a network of their own: Internet yes, but they must never see our computers, the printer or the intranet.',
    },
    steps: [
      {
        title: 'Plug a home router into the office network',
        detail:
          'A home router is a router, DHCP server, Wi-Fi access point, NAT and firewall in one box. sw1 has no free port left, so a second switch hangs off its first fiber port, and the home router’s Internet port goes into that switch. It asks the office DHCP server for an address, like any device.',
        hint: 'The Internet port is `eth0`. The four LAN ports and the Wi-Fi are on the other side of the router.',
        parts: [
          { text: 'Add a second switch', done: ({ net }) => switches(net).length >= 2 },
          {
            text: 'Cable sw1’s `eth8` (the first fiber port) to sw2’s `eth8`',
            done: (ctx) => cabled(ctx, 'sw1/eth8', 'sw2/eth8'),
          },
          { text: 'Add a home router', done: ({ net }) => ofSpec(net, 'homerouter').length > 0 },
          {
            text: 'Cable home1’s `eth0` (its Internet port) to sw2',
            done: (ctx) => cabled(ctx, 'home1/eth0', 'sw2'),
          },
          {
            text: 'Let home1 get an office address (it asks by itself; run this if `ip addr show eth0` stays empty)',
            code: 'dhclient eth0',
            on: 'home1',
            done: ({ net }) => {
              const h = named(net, 'home1');
              return !!h && wanOf(h).length > 0;
            },
          },
        ],
        check: ({ net }) => guestBoxes(net).length > 0,
      },
      {
        title: 'Give the guest network its own subnet',
        detail:
          'The box comes with `192.168.1.0/24` on its LAN side, which is also the office LAN, so it cannot tell which side `192.168.1.5` is on. Give the guests a free network such as `192.168.50.0/24` and let the DHCP server serve that one.',
        hint: 'A DHCP server only answers on a network its range belongs to, so the old range `192.168.1.100`–`.199` serves nobody once `br0` moved.',
        parts: [
          {
            text: 'Move home1’s LAN side (`br0`) to the guest network',
            code: 'ip addr flush dev br0 && ip addr add 192.168.50.1/24 dev br0',
            on: 'home1',
            done: (ctx) => hasAddr(ctx, 'home1', 'br0', '192.168.50.1/24'),
          },
          {
            text: 'Restart the DHCP server for the guest network',
            code: 'killall dnsmasq; dnsmasq --dhcp-range=192.168.50.100,192.168.50.199',
            on: 'home1',
            done: ({ net }) =>
              (named(net, 'home1')?.dnsmasq?.config.ranges ?? []).some((r) =>
                inSubnet(r.start, { ip: parseIp('192.168.50.0') ?? 0, prefix: 24 }),
              ),
          },
        ],
        check: ({ net }) => guestBoxes(net).some((h) => ownGuestNetwork(net, h)),
      },
      {
        title: 'Join the guest Wi-Fi with a visitor’s phone',
        detail:
          'Add a Phone and drag it inside the home router’s dashed range circle, away from the office access point. Desktop → Wi-Fi does the same as the commands. The address must be a guest address (`192.168.50.x`), not an office one.',
        hint: 'Out of range, the list of networks is empty. Move the phone closer to the home router.',
        parts: [
          { text: 'Add a visitor’s phone', done: ({ net }) => ofSpec(net, 'phone').length >= 2 },
          {
            text: 'Join `HomeWiFi` with phone2',
            code: 'nmcli dev wifi connect HomeWiFi password netforge123',
            on: 'phone2',
            done: ({ net }) => {
              const c = named(net, 'phone2');
              const h = named(net, 'home1');
              return !!c && !!h && associatedAp(c) === h;
            },
          },
          {
            text: 'Let phone2 get a guest address',
            code: 'dhclient wlan0',
            on: 'phone2',
            done: ({ net }) => {
              const c = named(net, 'phone2');
              const h = named(net, 'home1');
              return !!c && !!h && addrsOf(c).some((a) => lanOf(h).some((l) => sameSubnet(a, l)));
            },
          },
        ],
        check: ({ net }) =>
          guestBoxes(net).some(
            (h) =>
              ownGuestNetwork(net, h) &&
              guestsOf(net, h).some((c) =>
                addrsOf(c).some((a) => lanOf(h).some((l) => sameSubnet(a, l))),
              ),
          ),
      },
      {
        title: 'Check that visitors reach the Internet',
        detail:
          'The home router rewrites the guest address (NAT) and r1 does it again on the way out. `curl http://198.18.0.10/` works as well as a ping.',
        parts: [
          {
            text: 'Ping the example website from phone2',
            code: 'ping -c 1 198.18.0.10',
            on: 'phone2',
            done: ({ net }) => {
              const ip = named(net, 'phone2')?.ip;
              return !!ip && (ip.echoRepliesFrom.has(SITE_IP) || ip.tcp.connectedTo.has(SITE_IP));
            },
          },
        ],
        check: ({ net }) =>
          guestBoxes(net).some((h) =>
            guestsOf(net, h).some(
              (c) =>
                !!c.ip && (c.ip.echoRepliesFrom.has(SITE_IP) || c.ip.tcp.connectedTo.has(SITE_IP)),
            ),
          ),
      },
      {
        title: 'Keep visitors out of the office',
        detail:
          'Right now the visitor phone can ping the server `192.168.1.5`: the home router forwards everything from the guest network and NAT hides the guest address. Rules are read from the top, so a rule that drops guest traffic to the office networks (`192.168.0.0/16`) must go before the rule that accepts the guests: use `insert`, not `add`.',
        hint: 'nft insert rule ip filter forward iifname "br0" ip daddr 192.168.0.0/16 drop',
        parts: [
          {
            text: 'Drop guest traffic to the office networks, above the accept rule',
            code: 'nft insert rule ip filter forward iifname "br0" ip daddr 192.168.0.0/16 drop',
            on: 'home1',
            done: ({ net }) =>
              forwardRule(
                named(net, 'home1'),
                (r) =>
                  r.action.kind === 'drop' &&
                  r.matches.some((m) => m.kind === 'iifname' && !m.neg && m.name === 'br0') &&
                  r.matches.some(
                    (m) => m.kind === 'daddr' && !m.neg && m.cidr.ip === parseIp('192.168.0.0'),
                  ),
              ),
          },
          {
            text: 'Ping the office server from phone2: there must be no answer',
            code: 'ping -c 1 192.168.1.5',
            on: 'phone2',
            done: ({ net }) => {
              const h = named(net, 'home1');
              return !!h && guestKeptOut(net, h);
            },
          },
        ],
        check: ({ net }) => guestBoxes(net).some((h) => guestKeptOut(net, h)),
      },
    ],
    done: 'Sam: “Visitors have their own Wi-Fi and I keep my password, thank you!” The home router gave the guests a network of their own, so the office subnet and the guest subnet are never confused. NAT lets their traffic out to the Internet, and the firewall rule, placed above the accept rule, drops anything from the guest network to private office addresses, while replies from the Internet still come back. Next task: a second office, joined to this one through the Internet.',
  },
  {
    id: 'vpn',
    title: 'Join the offices with a private tunnel',
    summary: 'Connect headquarters to a remote office across the Internet with a WireGuard VPN.',
    brief: {
      from: 'Priya, branch manager',
      text: 'My team sends customer files to headquarters over the open Internet and that worries me. Can you build a private, encrypted link between our two offices?',
    },
    steps: [
      {
        title: 'Add a router and a PC for a remote office',
        detail:
          'The remote office is a router (r3) with a PC (pc6) behind it, reaching the Internet through its own port `eth1`.',
        parts: [
          { text: 'Add a third router', done: ({ net }) => !!named(net, 'r3') },
          { text: 'Add a sixth PC', done: ({ net }) => !!named(net, 'pc6') },
          { text: 'Cable pc6 to r3’s `eth0`', done: (ctx) => cabled(ctx, 'pc6/eth0', 'r3/eth0') },
          {
            text: 'Cable r3’s `eth1` to the Internet cloud’s `eth1`',
            done: (ctx) => cabled(ctx, 'r3/eth1', 'internet1/eth1'),
          },
        ],
        check: ({ net }) => natRouters(net).length >= 2,
      },
      {
        title: 'Get a public address for r3',
        detail: 'Like r1, r3 needs a public address from the provider to be reachable.',
        parts: [
          {
            text: 'Ask the provider for an address on r3’s `eth1`',
            code: 'dhclient eth1',
            on: 'r3',
            done: ({ net }) => {
              const r3 = named(net, 'r3');
              const port = r3?.port('eth1');
              return !!r3 && !!port && (r3.ip?.addrsOn(port).length ?? 0) > 0;
            },
          },
        ],
        check: ({ net }) =>
          natRouters(net).filter(({ router, wan }) => (router.ip?.addrsOn(wan).length ?? 0) > 0)
            .length >= 2,
      },
      {
        title: 'Give the remote office its own network',
        detail:
          'The remote office needs a network that does not overlap the headquarters’: `192.168.4.0/24`, with r3 as the gateway of pc6.',
        parts: [
          {
            text: 'Give r3’s `eth0` the remote network’s first address',
            code: 'ip addr add 192.168.4.1/24 dev eth0',
            on: 'r3',
            done: (ctx) => hasAddr(ctx, 'r3', 'eth0', '192.168.4.1/24'),
          },
          {
            text: 'Give pc6 an address in the remote network',
            code: 'ip addr add 192.168.4.10/24 dev eth0',
            on: 'pc6',
            done: (ctx) => hasIp(ctx, 'pc6', '192.168.4.10'),
          },
          {
            text: 'Give pc6 its gateway',
            code: 'ip route add default via 192.168.4.1',
            on: 'pc6',
            done: (ctx) => defaultVia(ctx, 'pc6', '192.168.4.1'),
          },
        ],
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
          'WireGuard makes an encrypted tunnel look like a network cable: an interface `wg0` with an address, a private key and a listening port. Router → Config → WireGuard VPN → Create wg0 does it in one form.',
        hint: 'In the CLI you can also write /etc/wireguard/wg0.conf and run `wg-quick up wg0`.',
        parts: [...wgParts('r1', '10.8.0.1'), ...wgParts('r3', '10.8.0.2')],
        check: ({ net }) => natRouters(net).filter(({ router }) => tunnelOf(router)).length >= 2,
      },
      {
        title: 'Make them peers',
        detail:
          'Peers trust each other by public key. Each router needs the other’s public key, its public address with port 51820 as endpoint (`ip addr` on its Internet port shows it), and the addresses it may send through the tunnel (allowed IPs: the tunnel address and the remote LAN). Keys differ every time, so print each one with `wg show` and paste it in place of the placeholder.',
        hint: 'The Config tab also adds the route into the tunnel. In the CLI you add it yourself, as the last command of each router.',
        parts: [
          ...peerParts(
            'r1',
            'r3',
            '198.51.100.100',
            '10.8.0.2/32,192.168.4.0/24',
            '192.168.4.0/24',
          ),
          ...peerParts('r3', 'r1', '192.0.2.100', '10.8.0.1/32,192.168.2.0/24', '192.168.2.0/24'),
        ],
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
        detail: 'Then open the Internet cloud’s capture: only WireGuard packets cross it.',
        parts: [
          {
            text: 'Ping pc6 from pc4',
            code: 'ping -c 1 192.168.4.10',
            on: 'pc4',
            done: (ctx) => gotReply(ctx, 'pc4', 'pc6'),
          },
        ],
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
    done: 'Priya: “Our files travel safely now, thank you!” Your ping travelled inside an encrypted UDP packet from one router’s public address to the other. The Internet only saw WireGuard traffic; each router accepted the inner packet only because it came from the other office’s allowed IPs. You built a whole company network, one chapter at a time.',
  },
];

/** Forgets answered pings, so a task only counts replies that arrive after it starts. */
export function clearEvidence(net: Network): void {
  for (const d of net.devices.values()) {
    d.ip?.echoRepliesFrom.clear();
    d.ip?.v6.echoRepliesFrom.clear();
    d.ip?.tcp.connectedTo.clear();
  }
}

/** A built-in task or challenge, or one of the lab's own tasks (from the task editor). */
export function findTask(id: string | null, custom: readonly CustomTask[] = []): Task | undefined {
  const own = custom.find((t) => t.id === id);
  return own ? compile(own) : [...TASKS, ...CHALLENGE_TASKS].find((t) => t.id === id);
}

/** A step is done when its `check` passes, or else when every one of its parts is done. */
export function stepDone(step: TaskStep | undefined, ctx: TaskContext): boolean {
  if (!step) return false;
  if (step.check) return step.check(ctx);
  return !!step.parts?.length && step.parts.every((p) => p.done(ctx));
}

/**
 * Returns how many steps are complete. Steps complete in order and stay complete,
 * so undoing earlier work does not take progress away.
 */
export function advance(task: Task, ctx: TaskContext, completed: number): number {
  let n = Math.min(completed, task.steps.length);
  while (n < task.steps.length && stepDone(task.steps[n], ctx)) n++;
  return n;
}
