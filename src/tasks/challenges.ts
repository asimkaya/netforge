import { inSubnet, parseIp, type Ip } from '../engine/addr.ts';
import type { Network } from '../engine/network.ts';
import type { Action } from './solutions.ts';
import type { Task } from './tasks.ts';

/** The working network a challenge starts from, before the fault is applied. */
export type ChallengeBase = 'office' | 'vlans' | 'two-sites';

/**
 * "Fix the network": a working network, one scripted fault, and the means to tell that the
 * symptom is gone. Everything is named as the app names it (pc3, sw1, r1).
 */
export interface Challenge {
  id: string;
  level: 'Easy' | 'Medium' | 'Hard';
  title: string;
  /** The complaint, as a user would put it. */
  symptom: string;
  base: ChallengeBase;
  /** Applied to the working network to break it. */
  breakIt: readonly Action[];
  /** The intended repair; the tests play it. */
  fix: readonly Action[];
  /** Where the failing command runs, and the command as the learner types it. */
  device: string;
  command: string;
  /** Matches the lines that count as running the command (flags and spacing may differ). */
  ran: RegExp;
  /** The fault is repaired, judged from the devices' configuration. */
  fixed(net: Network): boolean;
  /** Evidence on the device that the command now succeeded (a reply, an open connection). */
  proved(net: Network): boolean;
  /** Three hints, from the tool to use to the name of the fault. */
  hints: [string, string, string];
  /** What went wrong and the lesson, in two sentences. */
  done: string;
}

const ip = (text: string): Ip => parseIp(text) ?? 0;
const SITE = '198.18.0.10';
const SERVER = '192.168.10.10';
const WHY = 'Run the failing command in the terminal, then press "Why did this fail?" under it.';

const named = (net: Network, name: string) =>
  [...net.devices.values()].find((d) => d.name === name);

/** The device has had an echo reply from `address`. */
const answered = (net: Network, name: string, address: string) =>
  named(net, name)?.ip?.echoRepliesFrom.has(ip(address)) ?? false;

/** The device's address range contains an address of `other` (they share a network). */
const sharesLan = (net: Network, name: string, other: string) => {
  const mine = named(net, name)?.ip?.allAddrs() ?? [];
  const theirs = named(net, other)?.ip?.allAddrs() ?? [];
  return mine.some((m) => theirs.some((t) => inSubnet(t.ip, m)));
};

/** A forward-hook firewall rule that drops or rejects web traffic. */
const blocksWeb = (net: Network, name: string) =>
  (named(net, name)?.ip?.nf.tables ?? []).some((t) =>
    t.chains.some(
      (c) =>
        c.base?.hook === 'forward' &&
        c.rules.some(
          (r) =>
            (r.action.kind === 'drop' || r.action.kind === 'reject') &&
            r.matches.every((m) => m.kind !== 'port' || m.neg || m.ports.includes(80)),
        ),
    ),
  );

const sh = (sh: string, ...lines: string[]): Action => ({ sh, lines });

/** Easy to hard. */
export const CHALLENGES: readonly Challenge[] = [
  {
    id: 'fix-no-way-out',
    level: 'Easy',
    title: 'No way out for pc3',
    symptom: 'pc3 cannot reach the Internet. The other PCs in the office can.',
    base: 'office',
    breakIt: [sh('pc3', 'ip route del default', 'ip route add default via 192.168.10.254')],
    fix: [sh('pc3', 'ip route del default', 'ip route add default via 192.168.10.1')],
    device: 'pc3',
    command: `ping -c 1 ${SITE}`,
    ran: /^ping\b.*198\.18\.0\.10/,
    fixed: (net) => {
      const via = named(net, 'pc3')?.ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via;
      return via !== undefined && via !== null && (named(net, 'r1')?.ip?.ownsIp(via) ?? false);
    },
    proved: (net) => answered(net, 'pc3', SITE),
    hints: [
      WHY,
      'The explanation says pc3 asked for the MAC address of its gateway and nobody answered. Compare the gateway pc3 uses (`ip route`) with the router address (`ip addr` on r1).',
      'pc3 has a default gateway that no device owns. Point it at the router’s own address in the office network.',
    ],
    done: 'pc3 sent everything for the Internet to a gateway address that nobody owns, so ARP never got an answer and its packets never left the LAN. A default gateway must be a router’s address inside the host’s own network: when one host cannot get out, compare its gateway with a working host’s.',
  },
  {
    id: 'fix-wrong-prefix',
    level: 'Easy',
    title: 'The server pc2 cannot find',
    symptom: 'pc2 cannot reach the intranet server at 192.168.10.10. The other PCs can.',
    base: 'office',
    breakIt: [
      sh(
        'pc2',
        'ip addr flush dev eth0',
        'ip route del default',
        'ip addr add 192.168.10.101/30 dev eth0',
      ),
    ],
    fix: [sh('pc2', 'ip addr flush dev eth0', 'ip addr add 192.168.10.101/24 dev eth0')],
    device: 'pc2',
    command: `ping -c 1 ${SERVER}`,
    ran: /^ping\b.*192\.168\.10\.10\b/,
    fixed: (net) => sharesLan(net, 'pc2', 'r1'),
    proved: (net) => answered(net, 'pc2', SERVER),
    hints: [
      WHY,
      'The explanation blames a missing default gateway, but a server in the PC’s own network needs none. Read pc2’s address with `ip addr` and compare it with a working PC: which addresses does its network contain?',
      'pc2’s address has the wrong prefix length, so the server and the router lie outside the network pc2 thinks it is in.',
    ],
    done: 'pc2 had the right address but a /30 prefix, so it believed only three other addresses were on its network and sent even the server’s traffic towards a gateway it could not reach. The prefix length is half of an address: a wrong one makes neighbours look like strangers.',
  },
  {
    id: 'fix-no-network',
    level: 'Easy',
    title: 'pc4 has no network',
    symptom: 'pc4 cannot reach anything, not even the intranet server next to it.',
    base: 'office',
    breakIt: [sh('pc4', 'ip link set eth0 down')],
    fix: [sh('pc4', 'ip link set eth0 up')],
    device: 'pc4',
    command: `ping -c 1 ${SERVER}`,
    ran: /^ping\b.*192\.168\.10\.10\b/,
    fixed: (net) => named(net, 'pc4')?.port('eth0')?.adminUp ?? false,
    proved: (net) => answered(net, 'pc4', SERVER),
    hints: [
      WHY,
      'The explanation says an interface is turned off. `ip link` on pc4 lists the state of every interface.',
      'pc4’s network interface was switched off (set down), so nothing can leave through it even though the cable is fine.',
    ],
    done: 'pc4’s eth0 had been set down, so the PC had a cable, an address and a route but no way to send a single frame. When nothing works on one machine, check the lowest layer first: is the interface up?',
  },
  {
    id: 'fix-wrong-vlan',
    level: 'Medium',
    title: 'Neighbours that cannot talk',
    symptom:
      'pc2 cannot reach pc1 (192.168.10.10), although both are plugged into the same switch.',
    base: 'vlans',
    breakIt: [
      sh('sw1', 'bridge vlan add dev eth1 vid 20 pvid untagged; bridge vlan del dev eth1 vid 10'),
    ],
    fix: [
      sh('sw1', 'bridge vlan add dev eth1 vid 10 pvid untagged; bridge vlan del dev eth1 vid 20'),
    ],
    device: 'pc2',
    command: 'ping -c 1 192.168.10.10',
    ran: /^ping\b.*192\.168\.10\.10\b/,
    fixed: (net) => {
      const sw = named(net, 'sw1');
      const pvid = (port: string) => {
        const p = sw?.port(port);
        return p ? sw?.bridge?.vlans.get(p)?.pvid : undefined;
      };
      return pvid('eth1') !== undefined && pvid('eth1') === pvid('eth0');
    },
    proved: (net) => answered(net, 'pc2', '192.168.10.10'),
    hints: [
      WHY,
      'The explanation says the answer never arrived and mentions the VLAN. On sw1, `bridge vlan show` lists the VLAN of every port: compare the ports of pc1 and pc2.',
      'pc2’s switch port is an access port in the wrong VLAN, so pc1 and pc2 are in separate networks at layer 2.',
    ],
    done: 'The port of pc2 had been moved to VLAN 20, so the switch kept its frames apart from pc1’s VLAN 10 even though the cables and addresses were right. A VLAN is a separate network: two hosts that should talk must be in the same one.',
  },
  {
    id: 'fix-names',
    level: 'Medium',
    title: 'The intranet that is not found',
    symptom: 'pc1 cannot open intranet.office, but pinging the server’s address works.',
    base: 'office',
    breakIt: [sh('pc1', 'resolvectl dns eth0 192.168.10.10')],
    fix: [sh('pc1', 'resolvectl dns eth0 192.168.10.1')],
    device: 'pc1',
    command: 'ping -c 1 intranet.office',
    ran: /^ping\b.*intranet\.office/,
    fixed: (net) => {
      const dns = named(net, 'pc1')?.ip?.dns[0];
      return dns !== undefined && (named(net, 'r1')?.ip?.ownsIp(dns) ?? false);
    },
    proved: (net) => answered(net, 'pc1', SERVER),
    hints: [
      WHY,
      'The explanation says a device received the DNS query but nothing listens on UDP port 53. `resolvectl` on pc1 shows which DNS server it asks; on r1, `ip addr` shows where the DNS service runs.',
      'pc1 asks a device that is not a DNS server. Only the router runs a DNS service (dnsmasq), so pc1 must ask the router.',
    ],
    done: 'pc1 asked the intranet server for names, but that machine only serves web pages and has no DNS service, so every name failed while addresses kept working. If names fail and addresses work, the problem is the resolver: which server is being asked, and is it running DNS?',
  },
  {
    id: 'fix-forwarding',
    level: 'Medium',
    title: 'Two offices, no traffic',
    symptom: 'pc1 in the head office cannot reach pc2 in the branch. Both routers have routes.',
    base: 'two-sites',
    breakIt: [sh('r1', 'sysctl -w net.ipv4.ip_forward=0')],
    fix: [sh('r1', 'sysctl -w net.ipv4.ip_forward=1')],
    device: 'pc1',
    command: 'ping -c 1 192.168.2.10',
    ran: /^ping\b.*192\.168\.2\.10\b/,
    fixed: (net) => named(net, 'r1')?.ip?.forwarding ?? false,
    proved: (net) => answered(net, 'pc1', '192.168.2.10'),
    hints: [
      WHY,
      'The explanation names the device that threw the packet away. Compare that router with the other one: `sysctl net.ipv4.ip_forward` shows the setting.',
      'r1 has IP forwarding turned off, so it acts like an ordinary host and refuses to pass packets from one network to another.',
    ],
    done: 'r1 had IPv4 forwarding switched off, so it received packets meant for other networks and discarded them instead of routing them. What makes a router a router is that setting: routes alone are not enough.',
  },
  {
    id: 'fix-web-blocked',
    level: 'Hard',
    title: 'The website that never loads',
    symptom: `pc1 cannot open the website at ${SITE}, although ping to it works.`,
    base: 'office',
    breakIt: [
      sh(
        'r1',
        'nft add table ip filter',
        'nft add chain ip filter forward { type filter hook forward priority 0 ; policy accept ; }',
        'nft add rule ip filter forward tcp dport 80 drop',
      ),
    ],
    fix: [sh('r1', 'nft delete rule ip filter forward handle 2')],
    device: 'pc1',
    command: `curl -I http://${SITE}/`,
    ran: /^curl\b.*198\.18\.0\.10/,
    fixed: (net) => !blocksWeb(net, 'r1'),
    proved: (net) => named(net, 'pc1')?.ip?.tcp.connectedTo.has(ip(SITE)) ?? false,
    hints: [
      `${WHY} Then try \`ping ${SITE}\`: it works.`,
      'The explanation names a device whose firewall dropped the request. On that device `nft list ruleset` shows the rules: look at which traffic they match.',
      'A firewall rule on r1 drops web traffic (TCP port 80) while everything else, ping included, is allowed. Remove that rule.',
    ],
    done: 'A rule in r1’s forward chain dropped TCP port 80, so pings still worked while every web request timed out. When one service fails and others work, look for a firewall rule that matches that port, on a router along the path.',
  },
  {
    id: 'fix-missing-route',
    level: 'Hard',
    title: 'Pings that never come back',
    symptom:
      'pc1 gets no answer from pc2 in the branch. pc2 is on, and r1 has a route to its network.',
    base: 'two-sites',
    breakIt: [sh('r2', 'ip route del 192.168.1.0/24')],
    fix: [sh('r2', 'ip route add 192.168.1.0/24 via 10.0.0.1')],
    device: 'pc1',
    command: 'ping -c 1 192.168.2.10',
    ran: /^ping\b.*192\.168\.2\.10\b/,
    fixed: (net) =>
      (named(net, 'r2')?.ip?.routes() ?? []).some((r) => inSubnet(ip('192.168.1.10'), r.dst)),
    proved: (net) => answered(net, 'pc1', '192.168.2.10'),
    hints: [
      WHY,
      'The explanation says the ping arrived but the reply was lost on the way back, and names the router where it died. `ip route` there shows which networks it can reach.',
      'That router has no route back to the head-office network 192.168.1.0/24. A path needs routes in both directions.',
    ],
    done: 'The ping reached pc2, but r2 had no route to 192.168.1.0/24, so the reply died at r2 and pc1 saw only silence. Routing is two-way: whenever a ping goes out and nothing returns, check that the far end knows the way back.',
  },
];

/** A challenge as a task, so the task panel plays it like any other. */
export function challengeTask(c: Challenge): Task {
  const on = (net: Network) => named(net, c.device);
  return {
    id: c.id,
    title: c.title,
    summary: c.symptom,
    symptom: c.symptom,
    hints: c.hints,
    steps: [
      {
        title: 'Reproduce the problem',
        detail: `On ${c.device} run \`${c.command}\`. It fails: that is the complaint.`,
        check: ({ net, commands }) =>
          commands.some((x) => x.device === on(net)?.id && c.ran.test(x.line)),
      },
      {
        title: 'Find the fault and fix it',
        detail:
          'Find out why it fails and repair the network. The explanation under the terminal and the hints can help.',
        check: ({ net }) => c.fixed(net),
      },
      {
        title: 'Prove it',
        detail: `Run \`${c.command}\` again on ${c.device}: it works now.`,
        check: ({ net }) => c.fixed(net) && c.proved(net),
      },
    ],
    done: c.done,
  };
}

export const CHALLENGE_TASKS: readonly Task[] = CHALLENGES.map(challengeTask);
