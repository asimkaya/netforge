import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import type { SpecId } from '../engine/specs.ts';
import { FOOTPRINT } from './placement.ts';
import { emptyProgress, parseProject, serializeProject, type Project } from './project.ts';

/** A ready-made network the user can open and explore. */
export interface Scenario {
  id: string;
  level: 'Basic' | 'Intermediate' | 'Advanced';
  title: string;
  summary: string;
  /** Things to try once it is open. Text in backticks renders as code. */
  tryIt: string[];
  build(): Project;
}

const OUTPUT_PROBLEM = /error|cannot|not found|unreachable|failed|no dhcpoffers|usage/i;

/**
 * Builds a lab the way a user would: devices, cables, then shell commands. A command that
 * prints an error throws, so a scenario cannot silently rot when the engine changes.
 */
class Lab {
  readonly net = new Network();
  readonly layout: Project['layout'] = {};

  constructor() {
    // Wi-Fi range needs positions (the canvas provides them once the lab is open).
    this.net.locate = (id) => {
      const at = this.layout[id];
      const device = this.net.devices.get(id);
      if (!at || !device) return null;
      const size = FOOTPRINT[device.spec.id];
      return { x: at.x + size.w / 2, y: at.y + size.h / 2 };
    };
  }

  add(spec: SpecId, x: number, y: number): Device {
    const device = this.net.addDevice(spec);
    this.layout[device.id] = { x, y };
    return device;
  }

  cable(a: Device, aPort: string, b: Device, bPort: string): void {
    const pa = a.port(aPort);
    const pb = b.port(bPort);
    if (!pa || !pb) throw new Error(`scenario: no port ${a.name}/${aPort} or ${b.name}/${bPort}`);
    this.net.connect(pa, pb);
  }

  /** Lets simulated time pass (DHCP on a WAN port, Spanning Tree settling). */
  wait(ms: number): void {
    this.net.scheduler.runUntil(this.net.scheduler.now + ms);
  }

  sh(device: Device, ...lines: string[]): void {
    for (const line of lines) {
      let done = false;
      const proc = run(this.net, device, line, {
        out: (text) => {
          if (OUTPUT_PROBLEM.test(text)) throw new Error(`scenario: ${device.name}: ${text}`);
        },
        exit: () => (done = true),
      });
      for (let t = 0; proc && !done && t < 60_000; t += 100) this.wait(100);
      if (proc && !done) throw new Error(`scenario: ${device.name}: "${line}" did not finish`);
    }
  }

  /** The lab as a freshly opened file: settled, with no leftover frames or timers. */
  done(): Project {
    this.wait(1000);
    return parseProject(
      serializeProject({ net: this.net, layout: this.layout, tasks: emptyProgress() }),
    );
  }
}

const NAT = [
  'nft add table ip nat',
  'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
  'nft add rule ip nat postrouting oifname "eth0" masquerade',
];
const WIFI = 'password netforge123';

function home(): Project {
  const lab = new Lab();
  const internet = lab.add('internet', 300, 20);
  const router = lab.add('homerouter', 310, 220);
  const pc = lab.add('pc', 100, 430);
  const laptop = lab.add('laptop', 340, 440);
  const phone = lab.add('phone', 580, 400);
  lab.cable(internet, 'eth0', router, 'eth0');
  lab.cable(pc, 'eth0', router, 'eth1');
  lab.wait(15_000);
  lab.sh(pc, 'dhclient eth0');
  for (const d of [laptop, phone]) {
    lab.sh(d, `nmcli dev wifi connect HomeWiFi ${WIFI}`, 'dhclient wlan0');
  }
  return lab.done();
}

function office(): Project {
  const lab = new Lab();
  const internet = lab.add('internet', 360, 0);
  const router = lab.add('router', 360, 160);
  const sw = lab.add('switch', 300, 320);
  const server = lab.add('server', 760, 310);
  const pcs = [60, 270, 480, 690].map((x) => lab.add('pc', x, 500));
  lab.cable(internet, 'eth0', router, 'eth0');
  lab.cable(router, 'eth1', sw, 'eth7');
  lab.cable(server, 'eth0', sw, 'eth6');
  pcs.forEach((pc, i) => lab.cable(pc, 'eth0', sw, `eth${i}`));
  lab.sh(
    router,
    'dhclient eth0',
    'ip addr add 192.168.10.1/24 dev eth1',
    'dnsmasq --dhcp-range=192.168.10.100,192.168.10.199 --host-record=intranet.office,192.168.10.10',
    ...NAT,
  );
  lab.sh(
    server,
    'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
    'resolvectl dns eth0 192.168.10.1',
    'httpd',
  );
  for (const pc of pcs) lab.sh(pc, 'dhclient eth0');
  return lab.done();
}

function company(): Project {
  const lab = new Lab();
  const internet = lab.add('internet', 520, 0);
  const router = lab.add('router', 220, 150);
  const core = lab.add('switch', 180, 300);
  const office = lab.add('switch', 0, 470);
  const classroom = lab.add('switch', 420, 470);
  const web = lab.add('server', 580, 290);
  const mail = lab.add('server', 780, 290);
  const ap = lab.add('ap', -220, 470);
  const officePcs = [0, 200].map((x) => lab.add('pc', x, 640));
  const labPcs = [420, 620, 820].map((x) => lab.add('pc', x, 640));
  const phone = lab.add('phone', -220, 640);
  const branch = lab.add('homerouter', 900, 150);
  const branchPc = lab.add('pc', 1000, 340);
  const branchLaptop = lab.add('laptop', 1130, 150);

  // Redundant cables need Spanning Tree on every bridge first (the access point is one too).
  lab.sh(core, 'ip link set br0 type bridge stp_state 1 priority 4096');
  for (const bridge of [office, classroom, ap]) {
    lab.sh(bridge, 'ip link set br0 type bridge stp_state 1');
  }
  lab.cable(internet, 'eth0', router, 'eth0');
  lab.cable(internet, 'eth1', branch, 'eth0');
  lab.cable(router, 'eth1', core, 'eth0');
  lab.cable(core, 'eth8', office, 'eth8');
  lab.cable(core, 'eth9', classroom, 'eth9');
  lab.cable(office, 'eth7', classroom, 'eth7');
  lab.cable(web, 'eth0', core, 'eth1');
  lab.cable(mail, 'eth0', core, 'eth2');
  officePcs.forEach((pc, i) => lab.cable(pc, 'eth0', office, `eth${i}`));
  lab.cable(ap, 'eth0', office, 'eth2');
  labPcs.forEach((pc, i) => lab.cable(pc, 'eth0', classroom, `eth${i}`));
  lab.cable(branchPc, 'eth0', branch, 'eth1');

  // VLAN 10 office, 20 classroom, 30 servers. Cables between switches carry 10 and 20.
  const vlans = (sw: Device, trunks: Record<string, number[]>, access: Record<string, number>) => {
    lab.sh(sw, 'ip link set br0 type bridge vlan_filtering 1');
    for (const [port, ids] of Object.entries(trunks)) {
      for (const id of ids) lab.sh(sw, `bridge vlan add dev ${port} vid ${id}`);
    }
    for (const [port, id] of Object.entries(access)) {
      lab.sh(
        sw,
        `bridge vlan add dev ${port} vid ${id} pvid untagged; bridge vlan del dev ${port} vid 1`,
      );
    }
  };
  vlans(core, { eth0: [10, 20, 30], eth8: [10, 20], eth9: [10, 20] }, { eth1: 30, eth2: 30 });
  vlans(office, { eth8: [10, 20], eth7: [10, 20] }, { eth0: 10, eth1: 10, eth2: 10 });
  vlans(classroom, { eth9: [10, 20], eth7: [10, 20] }, { eth0: 20, eth1: 20, eth2: 20 });
  lab.wait(40_000);

  lab.sh(
    router,
    'dhclient eth0',
    ...[10, 20, 30].flatMap((id) => [
      `ip link add link eth1 name eth1.${id} type vlan id ${id}`,
      `ip link set eth1.${id} up`,
      `ip addr add 10.0.${id}.1/24 dev eth1.${id}`,
    ]),
    'dnsmasq --dhcp-range=10.0.10.100,10.0.10.199 --dhcp-range=10.0.20.100,10.0.20.199 --host-record=intranet.corp,10.0.30.10 --host-record=mail.corp,10.0.30.20',
    ...NAT,
    // Visitors from the Internet reach the web server; the classroom reaches only its web page.
    'nft add chain ip nat prerouting { type nat hook prerouting priority dstnat ; }',
    'nft add rule ip nat prerouting iifname "eth0" tcp dport 80 dnat to 10.0.30.10',
    'nft add table ip filter',
    'nft add chain ip filter forward { type filter hook forward priority 0 ; }',
    'nft add rule ip filter forward iifname "eth1.20" oifname "eth1.30" tcp dport 80 accept',
    'nft add rule ip filter forward iifname "eth1.20" oifname "eth1.30" drop',
  );
  const server = (device: Device, host: number, ...services: string[]) =>
    lab.sh(
      device,
      `ip addr add 10.0.30.${host}/24 dev eth0`,
      'ip route add default via 10.0.30.1',
      'resolvectl dns eth0 10.0.30.1',
      ...services,
    );
  server(web, 10, 'httpd');
  server(mail, 20, 'postfix start', 'dovecot');
  for (const pc of [...officePcs, ...labPcs, branchPc]) lab.sh(pc, 'dhclient eth0');
  lab.sh(phone, `nmcli dev wifi connect NetForge ${WIFI}`);
  lab.sh(branchLaptop, `nmcli dev wifi connect HomeWiFi ${WIFI}`, 'dhclient wlan0');
  // The access point's new Wi-Fi port listens and learns (Spanning Tree) before it forwards.
  lab.wait(40_000);
  lab.sh(phone, 'dhclient wlan0');
  return lab.done();
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'home',
    level: 'Basic',
    title: 'Home network',
    summary: 'A home router shares one Internet connection with a PC, a laptop and a phone.',
    tryIt: [
      'Open pc1 → Terminal and run `ping 198.18.0.10` (a website on the Internet).',
      'Open laptop1 → Web Browser and visit `http://198.18.0.10/`.',
      'On home1 (CLI) run `nft list ruleset` to see the NAT and firewall rules.',
      'Drag the phone far away from home1 and watch its Wi-Fi drop.',
    ],
    build: home,
  },
  {
    id: 'office',
    level: 'Intermediate',
    title: 'Small office',
    summary:
      'A router, a switch, four PCs and a web server: DHCP, names with DNS and NAT to the Internet.',
    tryIt: [
      'On pc1 run `ping intranet.office`, then `curl http://intranet.office/`.',
      'Run `traceroute 198.18.0.10` to see the router on the way to the Internet.',
      'On sw1 (CLI) run `bridge fdb` to see which PC is on which port.',
      'Switch to Simulation, ping from pc2 and step through every frame.',
    ],
    build: office,
  },
  {
    id: 'company',
    level: 'Advanced',
    title: 'Company with VLANs and a branch',
    summary:
      'Three switches with VLANs and a redundant cable, a firewall, two servers, Wi-Fi and a branch office behind the Internet.',
    tryIt: [
      'pc1 is in the office VLAN: `ping mail.corp` works. pc3 is in the classroom VLAN: the firewall drops it, but `curl -I http://intranet.corp/` works.',
      'On r1 run `nft list ruleset` and `ip -4 addr` to see one interface per VLAN.',
      'Delete the fiber cable between sw1 and sw2, wait 30 s, and ping again: Spanning Tree opens the spare cable.',
      'From pc6 in the branch run `curl http://192.0.2.100/`: the router forwards port 80 to the web server.',
    ],
    build: company,
  },
];
