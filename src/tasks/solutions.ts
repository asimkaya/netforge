import type { SpecId } from '../engine/specs.ts';

/**
 * One scripted move of a learner. The tasks build one network that grows from task to task,
 * so "the start of task N" is an empty lab with the solutions of tasks 1 to N-1 applied.
 * Devices are named as the app names them (pc1, sw1, r1, internet1) and ports as `pc1/eth0`.
 */
export type Action =
  | { add: SpecId; at: [x: number, y: number] }
  | { cable: [port: string, port: string] }
  | { uncable: string }
  /** Shell commands on a device. `{pubkey:r3}` stands for the WireGuard public key of r3. */
  | { sh: string; lines: string[]; failing?: boolean; watch?: number }
  /** Simulated milliseconds pass (routing protocols settling). */
  | { wait: number };

const add = (spec: SpecId, x: number, y: number): Action => ({ add: spec, at: [x, y] });
const cable = (a: string, b: string): Action => ({ cable: [a, b] });
const sh = (device: string, ...lines: string[]): Action => ({ sh: device, lines });

const NAT = (wan: string) => [
  'nft add table ip nat',
  'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
  `nft add rule ip nat postrouting oifname "${wan}" masquerade`,
];

const FIREWALL = (wan: string) => [
  'nft add table ip filter',
  'nft add chain ip filter forward { type filter hook forward priority 0 ; policy drop ; }',
  'nft add rule ip filter forward ct state established,related accept',
  `nft add rule ip filter forward iifname != "${wan}" accept`,
];

/** Moves a PC to a VLAN of its own switch port: an access port. */
const access = (port: string, vid: number) =>
  `bridge vlan add dev ${port} vid ${vid} pvid untagged; bridge vlan del dev ${port} vid 1`;

const wireguard = (router: string, tunnelIp: string) =>
  sh(
    router,
    'ip link add wg0 type wireguard',
    'wg genkey > /etc/wireguard/key',
    'wg set wg0 private-key /etc/wireguard/key listen-port 51820',
    `ip addr add ${tunnelIp}/24 dev wg0`,
    'ip link set wg0 up',
  );

/**
 * What a learner types and drags to finish each task, in order. The final network:
 *
 *   internet1 ── r1 ── r2 ── pc5      r1 eth0: sw1 (pc1, pc2, pc3, VLANs 10 and 20)
 *       │        │                    r1 eth1: pc4
 *      r3 ── pc6 └─ pc4, sw1          r1 eth2: r2 · r1 eth3: internet1
 */
export const SOLUTIONS: Record<string, readonly Action[]> = {
  'first-ping': [
    add('pc', 40, 520),
    add('pc', 270, 520),
    cable('pc1/eth0', 'pc2/eth0'),
    sh('pc1', 'ip addr add 192.168.1.10/24 dev eth0'),
    sh('pc2', 'ip addr add 192.168.1.20/24 dev eth0', 'ping -c 1 192.168.1.10'),
  ],
  'meet-the-switch': [
    add('switch', 240, 340),
    { uncable: 'pc1/eth0' },
    cable('pc1/eth0', 'sw1/eth0'),
    cable('pc2/eth0', 'sw1/eth1'),
    add('pc', 500, 520),
    cable('pc3/eth0', 'sw1/eth2'),
    sh('pc3', 'ip addr add 192.168.1.30/24 dev eth0', 'ping -c 1 192.168.1.10'),
    sh('pc3', 'ping -c 1 192.168.1.20'),
    sh('sw1', 'bridge fdb show'),
  ],
  'two-networks': [
    add('router', 330, 170),
    add('pc', 620, 340),
    cable('r1/eth0', 'sw1/eth7'),
    cable('pc4/eth0', 'r1/eth1'),
    sh('r1', 'ip addr add 192.168.1.1/24 dev eth0', 'ip addr add 192.168.2.1/24 dev eth1'),
    sh('pc4', 'ip addr add 192.168.2.10/24 dev eth0', 'ip route add default via 192.168.2.1'),
    ...['pc1', 'pc2', 'pc3'].map((pc) => sh(pc, 'ip route add default via 192.168.1.1')),
    sh('pc4', 'ping -c 1 192.168.1.10', 'traceroute 192.168.1.10'),
  ],
  dhcp: [
    sh('r1', 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199'),
    ...['pc1', 'pc2', 'pc3'].map((pc) => sh(pc, 'ip addr flush dev eth0', 'dhclient eth0')),
    sh('pc1', 'ping -c 1 pc2'),
  ],
  'first-print': [
    add('printer', 270, 700),
    cable('printer1/eth0', 'sw1/eth3'),
    { wait: 10_000 },
    sh(
      'pc1',
      'curl -s http://printer1/',
      'echo Hello > letter.txt',
      'nc printer1 9100 < letter.txt',
    ),
  ],
  'lobby-camera': [
    add('camera', 500, 700),
    cable('cam1/eth0', 'sw1/eth4'),
    { wait: 10_000 },
    // The stream never ends by itself: watch five frames, then Ctrl+C.
    { sh: 'pc1', lines: ['nc cam1 554'], watch: 5_500 },
  ],
  vlans: [
    sh('sw1', 'ip link set br0 type bridge vlan_filtering 1'),
    sh('sw1', access('eth0', 10), access('eth1', 10), access('eth2', 20)),
    // pc2 got the second address of the DHCP range, pc3 the third.
    sh('pc1', 'ping -c 1 192.168.1.101'),
    { sh: 'pc1', lines: ['ping -c 1 -W 1 192.168.1.102'], failing: true },
  ],
  'inter-vlan': [
    ...[
      ['pc1', 10, 10],
      ['pc2', 10, 20],
      ['pc3', 20, 10],
    ].map(([pc, vlan, host]) =>
      sh(
        String(pc),
        'ip addr flush dev eth0',
        'ip route del default',
        `ip addr add 192.168.${vlan}.${host}/24 dev eth0`,
        `ip route add default via 192.168.${vlan}.1`,
      ),
    ),
    sh('sw1', 'bridge vlan add dev eth7 vid 10', 'bridge vlan add dev eth7 vid 20'),
    sh(
      'r1',
      ...[10, 20].flatMap((vid) => [
        `ip link add link eth0 name eth0.${vid} type vlan id ${vid}`,
        `ip link set eth0.${vid} up`,
        `ip addr add 192.168.${vid}.1/24 dev eth0.${vid}`,
      ]),
    ),
    sh('pc1', 'ping -c 1 192.168.20.10'),
  ],
  ospf: [
    add('router', 700, 170),
    add('pc', 840, 340),
    cable('r1/eth2', 'r2/eth1'),
    cable('pc5/eth0', 'r2/eth0'),
    sh('r1', 'ip addr add 10.0.0.1/30 dev eth2'),
    sh('r2', 'ip addr add 10.0.0.2/30 dev eth1', 'ip addr add 192.168.3.1/24 dev eth0'),
    sh('pc5', 'ip addr add 192.168.3.10/24 dev eth0', 'ip route add default via 192.168.3.1'),
    sh('r1', 'bird'),
    sh('r2', 'bird'),
    { wait: 40_000 },
    sh('r1', 'ip route'),
    sh('pc5', 'ping -c 1 192.168.2.10'),
  ],
  nat: [
    add('internet', 700, 0),
    cable('r1/eth3', 'internet1/eth0'),
    sh('r1', 'dhclient eth3', ...NAT('eth3')),
    sh('pc4', 'ping -c 1 198.18.0.10'),
    sh('r1', 'conntrack -F', ...FIREWALL('eth3')),
    sh('pc4', 'ping -c 1 198.18.0.10'),
  ],
  vpn: [
    add('router', 1000, 170),
    add('pc', 1060, 340),
    cable('pc6/eth0', 'r3/eth0'),
    cable('r3/eth1', 'internet1/eth1'),
    sh('r3', 'dhclient eth1', 'ip addr add 192.168.4.1/24 dev eth0'),
    sh('pc6', 'ip addr add 192.168.4.10/24 dev eth0', 'ip route add default via 192.168.4.1'),
    wireguard('r1', '10.8.0.1'),
    wireguard('r3', '10.8.0.2'),
    sh(
      'r1',
      'wg set wg0 peer {pubkey:r3} endpoint 198.51.100.100:51820 allowed-ips 10.8.0.2/32,192.168.4.0/24',
      'ip route add 192.168.4.0/24 dev wg0',
    ),
    sh(
      'r3',
      'wg set wg0 peer {pubkey:r1} endpoint 192.0.2.100:51820 allowed-ips 10.8.0.1/32,192.168.2.0/24',
      'ip route add 192.168.2.0/24 dev wg0',
    ),
    sh('pc4', 'ping -c 1 192.168.4.10'),
  ],
};
