import type { PortType } from './port.ts';

export type SpecId =
  | 'pc'
  | 'laptop'
  | 'phone'
  | 'server'
  | 'printer'
  | 'camera'
  | 'switch'
  | 'switch24'
  | 'l3switch'
  | 'ap'
  | 'router'
  | 'homerouter'
  | 'internet';

/** The devices that are switches: guided tasks, VLAN and STP screens treat them alike. */
export const SWITCH_SPECS: readonly SpecId[] = ['switch', 'switch24', 'l3switch'];
export const isSwitchSpec = (id: SpecId): boolean => SWITCH_SPECS.includes(id);

/**
 * What a device is made of. Adding a device type means adding a spec here (and its
 * faceplate in the UI), not writing a new class. See ADR 0006.
 */
export interface DeviceSpec {
  id: SpecId;
  label: string;
  description: string;
  /** Default hostnames are prefix + counter, e.g. pc1, sw2. */
  namePrefix: string;
  ports: { name: string; type: PortType }[];
  /** Ports are enslaved to one learning bridge (L2 switching): all, or `bridgePorts`. */
  bridge: boolean;
  bridgePorts?: string[];
  /** The bridge gets its own IP interface, `br0` (a home router's LAN side). */
  bridgeIp?: boolean;
  /** A port that asks for an address with DHCP whenever its link comes up (a WAN port). */
  wanDhcp?: string;
  /** A single-purpose device whose services start with it (see appliances.ts). */
  appliance?: 'printer' | 'camera';
  /** Runs an IP stack on the ports that are not bridged. */
  ip: boolean;
  /** Initial `net.ipv4.ip_forward`: forwards packets between its interfaces. */
  forwarding: boolean;
  /** Files a new device starts with. */
  files?: Record<string, string>;
  /** Shell commands a new device runs once, e.g. to come pre-configured. */
  setup?: string[];
}

function ports(type: PortType, from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `eth${from + i}`, type }));
}

const SAMPLE_PAGE = `<!doctype html>
<html>
  <head><title>It works!</title></head>
  <body>
    <h1>It works!</h1>
    <p>This page is served by NetForge's httpd from /var/www/html/index.html.</p>
    <p>Edit it with the Text Editor, or: echo "&lt;h1&gt;Hello&lt;/h1&gt;" &gt; /var/www/html/index.html</p>
  </body>
</html>
`;

/** BIRD's configuration on a new router: OSPF on every Ethernet port, routes exported. */
const BIRD_SAMPLE = `# BIRD routing daemon. Start it with \`bird\`; check it with \`birdc show ospf neighbors\`.
# router id 10.0.0.1;

protocol device {
}

protocol kernel {
	ipv4 {
		export all;
	};
}

protocol ospf v2 {
	area 0 {
		interface "eth*" {
			cost 10;
		};
	};
}
`;

const INTERNET_PAGE = `<!doctype html>
<html>
  <head><title>Example site</title></head>
  <body>
    <h1>Hello from the Internet</h1>
    <p>You reached www.example.com, a site inside NetForge's simulated Internet.</p>
    <p>Your request travelled through every router between you and this cloud.</p>
  </body>
</html>
`;

/** The cloud's access networks (documentation ranges) and its website address. */
const ISP_NETS = ['192.0.2', '198.51.100', '203.0.113', '100.64.0'];
const SITE = '198.18.0.10';

export const SPECS: Record<SpecId, DeviceSpec> = {
  pc: {
    id: 'pc',
    label: 'PC',
    description: 'A computer with one Ethernet port',
    namePrefix: 'pc',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    ip: true,
    forwarding: false,
  },
  laptop: {
    id: 'laptop',
    label: 'Laptop',
    description: 'A laptop with an Ethernet port and Wi-Fi',
    namePrefix: 'laptop',
    ports: [...ports('ethernet', 0, 1), { name: 'wlan0', type: 'wifi' }],
    bridge: false,
    ip: true,
    forwarding: false,
  },
  phone: {
    id: 'phone',
    label: 'Phone',
    description: 'A phone with Wi-Fi only',
    namePrefix: 'phone',
    ports: [{ name: 'wlan0', type: 'wifi' }],
    bridge: false,
    ip: true,
    forwarding: false,
  },
  server: {
    id: 'server',
    label: 'Server',
    description: 'A server with one Ethernet port and a sample website in /var/www/html',
    namePrefix: 'srv',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    ip: true,
    forwarding: false,
    files: {
      '/var/www/html/index.html': SAMPLE_PAGE,
    },
  },
  printer: {
    id: 'printer',
    label: 'Printer',
    description:
      'A network printer: asks for an address with DHCP, shows a status page on port 80 and prints jobs sent to port 9100',
    namePrefix: 'printer',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    wanDhcp: 'eth0',
    appliance: 'printer',
    ip: true,
    forwarding: false,
  },
  camera: {
    id: 'camera',
    label: 'IP Camera',
    description:
      'An IP camera: asks for an address with DHCP, has a live view page on port 80 and streams to viewers that connect to port 554',
    namePrefix: 'cam',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    wanDhcp: 'eth0',
    appliance: 'camera',
    ip: true,
    forwarding: false,
  },
  switch: {
    id: 'switch',
    label: 'Switch',
    description: 'Switch with 8 Ethernet ports and 2 fiber (SFP) uplinks; supports VLANs',
    namePrefix: 'sw',
    ports: [...ports('ethernet', 0, 8), ...ports('sfp', 8, 2)],
    bridge: true,
    ip: false,
    forwarding: false,
  },
  switch24: {
    id: 'switch24',
    label: '24-port Switch',
    description:
      'Switch with 24 Ethernet ports and 4 fiber (SFP) uplinks; supports VLANs and Spanning Tree',
    // Shares the sw counter with the 8-port switch, so every switch has a unique name.
    namePrefix: 'sw',
    ports: [...ports('ethernet', 0, 24), ...ports('sfp', 24, 4)],
    bridge: true,
    ip: false,
    forwarding: false,
  },
  l3switch: {
    id: 'l3switch',
    label: 'L3 Switch',
    description:
      'Switch with 24 Ethernet ports and 4 SFP uplinks that also routes: give br0.10, br0.20... an address to route between VLANs',
    namePrefix: 'l3sw',
    ports: [...ports('ethernet', 0, 24), ...ports('sfp', 24, 4)],
    bridge: true,
    bridgeIp: true,
    ip: true,
    forwarding: true,
    files: { '/etc/bird.conf': BIRD_SAMPLE },
  },
  ap: {
    id: 'ap',
    label: 'Access Point',
    description: 'Wi-Fi access point bridging wireless clients to its Ethernet port (hostapd)',
    namePrefix: 'ap',
    // One radio slot per associated client, all bridged with the wired port.
    ports: [
      ...ports('ethernet', 0, 1),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `wlan${i}`, type: 'wifi' as const })),
    ],
    bridge: true,
    ip: true,
    forwarding: false,
    files: {
      '/etc/hostapd/hostapd.conf':
        'interface=wlan0\nssid=NetForge\nwpa=2\nwpa_passphrase=netforge123\n',
    },
    setup: ['hostapd -B /etc/hostapd/hostapd.conf'],
  },
  router: {
    id: 'router',
    label: 'Router',
    description: 'Linux router with 4 Ethernet ports; forwards packets between networks',
    namePrefix: 'r',
    ports: ports('ethernet', 0, 4),
    bridge: false,
    ip: true,
    forwarding: true,
    files: { '/etc/bird.conf': BIRD_SAMPLE },
  },
  homerouter: {
    id: 'homerouter',
    label: 'Home Router',
    description:
      'Home Wi-Fi router: Internet port (eth0) with DHCP, 4 LAN ports and Wi-Fi bridged as br0, DHCP server, NAT and a firewall, all ready',
    namePrefix: 'home',
    ports: [
      ...ports('ethernet', 0, 5),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `wlan${i}`, type: 'wifi' as const })),
    ],
    bridge: true,
    bridgePorts: [
      ...['eth1', 'eth2', 'eth3', 'eth4'],
      ...Array.from({ length: 8 }, (_, i) => `wlan${i}`),
    ],
    bridgeIp: true,
    wanDhcp: 'eth0',
    ip: true,
    forwarding: true,
    files: {
      '/etc/hostapd/hostapd.conf':
        'interface=wlan0\nssid=HomeWiFi\nwpa=2\nwpa_passphrase=netforge123\n',
    },
    setup: [
      'ip addr add 192.168.1.1/24 dev br0',
      'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199,12h',
      'hostapd -B /etc/hostapd/hostapd.conf',
      'nft add table ip nat',
      'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
      'nft add rule ip nat postrouting oifname "eth0" masquerade',
      'nft add table ip filter',
      'nft add chain ip filter forward { type filter hook forward priority filter ; policy drop ; }',
      'nft add rule ip filter forward ct state established,related accept',
      'nft add rule ip filter forward iifname "br0" accept',
    ],
  },
  internet: {
    id: 'internet',
    label: 'Internet',
    description:
      'The Internet as one box: each port is a provider network with DHCP, DNS and a sample website',
    namePrefix: 'internet',
    ports: ports('ethernet', 0, 4),
    bridge: false,
    ip: true,
    forwarding: true,
    files: { '/var/www/html/index.html': INTERNET_PAGE },
    setup: [
      ...ISP_NETS.map((net, i) => `ip addr add ${net}.1/24 dev eth${i}`),
      `ip addr add ${SITE}/32 dev eth0`,
      [
        'dnsmasq',
        ...ISP_NETS.map((net) => `--dhcp-range=${net}.100,${net}.199,12h`),
        `--address=/www.example.com/${SITE}`,
        `--address=/example.com/${SITE}`,
      ].join(' '),
      'httpd',
    ],
  },
};

export function isSpecId(value: unknown): value is SpecId {
  return typeof value === 'string' && Object.hasOwn(SPECS, value);
}
