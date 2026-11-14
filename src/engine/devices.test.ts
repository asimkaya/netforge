import { describe, expect, it } from 'vitest';
import { Network } from './network.ts';
import { run, type Process } from './shell.ts';
import { SPECS } from './specs.ts';
import { port, sh, wait } from './testing.ts';
import type { Device } from './device.ts';

const pings = (net: Network, from: Device, to: string) =>
  sh(net, from, `ping -c 1 ${to}`).some((l) => l.includes(' 1 received'));

describe('device specs', () => {
  it('24-port and L3 switches have 24 copper ports and 4 SFP uplinks', () => {
    for (const id of ['switch24', 'l3switch'] as const) {
      const names = SPECS[id].ports.map((p) => `${p.name}:${p.type}`);
      expect(names).toHaveLength(28);
      expect(names[0]).toBe('eth0:ethernet');
      expect(names[23]).toBe('eth23:ethernet');
      expect(names.slice(24)).toEqual(['eth24:sfp', 'eth25:sfp', 'eth26:sfp', 'eth27:sfp']);
    }
  });

  it('gives every switch a unique name, and appliances their own prefix', () => {
    const net = new Network();
    const names = (['switch', 'switch24', 'switch', 'l3switch', 'printer', 'camera'] as const).map(
      (id) => net.addDevice(id).name,
    );
    expect(names).toEqual(['sw1', 'sw2', 'sw3', 'l3sw1', 'printer1', 'cam1']);
  });

  it('a printer and a camera have one Ethernet port', () => {
    for (const id of ['printer', 'camera'] as const) {
      expect(SPECS[id].ports).toEqual([{ name: 'eth0', type: 'ethernet' }]);
    }
  });
});

describe('24-port switch', () => {
  it('carries VLANs over an SFP trunk to the 8-port switch', () => {
    const net = new Network();
    const small = net.addDevice('switch');
    const big = net.addDevice('switch24');
    const [pc1, pc2, pc3] = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
    net.connect(port(small, 'eth8'), port(big, 'eth24'));
    net.connect(port(pc1, 'eth0'), port(small, 'eth0'));
    net.connect(port(pc2, 'eth0'), port(big, 'eth23'));
    net.connect(port(pc3, 'eth0'), port(big, 'eth22'));
    [pc1, pc2, pc3].forEach((pc, i) => sh(net, pc, `ip addr add 10.0.0.${i + 1}/24 dev eth0`));
    const access = (sw: Device, dev: string, vid: number) => {
      sh(net, sw, `bridge vlan add dev ${dev} vid ${vid} pvid untagged`);
      sh(net, sw, `bridge vlan del dev ${dev} vid 1`);
    };
    for (const sw of [small, big]) sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1');
    access(small, 'eth0', 10);
    access(big, 'eth23', 10);
    access(big, 'eth22', 20);
    for (const [sw, dev] of [
      [small, 'eth8'],
      [big, 'eth24'],
    ] as const) {
      sh(net, sw, `bridge vlan add dev ${dev} vid 10`);
      sh(net, sw, `bridge vlan add dev ${dev} vid 20`);
    }
    expect(pings(net, pc1, '10.0.0.2')).toBe(true);
    expect(pings(net, pc1, '10.0.0.3')).toBe(false);
  });
});

describe('L3 switch', () => {
  /** pc1 in VLAN 10 and pc2 in VLAN 20 on one L3 switch, no router. */
  function lab() {
    const net = new Network();
    const l3 = net.addDevice('l3switch');
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(port(pc1, 'eth0'), port(l3, 'eth0'));
    net.connect(port(pc2, 'eth0'), port(l3, 'eth1'));
    const cmds = [
      'ip link set br0 type bridge vlan_filtering 1',
      'bridge vlan add dev eth0 vid 10 pvid untagged',
      'bridge vlan del dev eth0 vid 1',
      'bridge vlan add dev eth1 vid 20 pvid untagged',
      'bridge vlan del dev eth1 vid 1',
      'ip link add link br0 name br0.10 type vlan id 10',
      'ip link add link br0 name br0.20 type vlan id 20',
      'ip link set br0.10 up',
      'ip link set br0.20 up',
      'ip addr add 10.0.10.1/24 dev br0.10',
      'ip addr add 10.0.20.1/24 dev br0.20',
    ];
    for (const c of cmds) expect(sh(net, l3, c)).toEqual([]);
    sh(net, pc1, 'ip addr add 10.0.10.2/24 dev eth0');
    sh(net, pc1, 'ip route add default via 10.0.10.1');
    sh(net, pc2, 'ip addr add 10.0.20.2/24 dev eth0');
    sh(net, pc2, 'ip route add default via 10.0.20.1');
    return { net, l3, pc1, pc2 };
  }

  it('forwards by default and answers on its VLAN interfaces', () => {
    const { net, l3, pc1 } = lab();
    expect(l3.ip?.forwarding).toBe(true);
    expect(pings(net, pc1, '10.0.10.1')).toBe(true);
  });

  it('routes between two VLANs through br0.10 and br0.20', () => {
    const { net, pc1, pc2 } = lab();
    expect(pings(net, pc1, '10.0.20.2')).toBe(true);
    expect(pings(net, pc2, '10.0.10.2')).toBe(true);
  });

  it('stops routing when the VLAN interface goes down', () => {
    const { net, l3, pc1 } = lab();
    sh(net, l3, 'ip link set br0.20 down');
    expect(pings(net, pc1, '10.0.20.2')).toBe(false);
  });

  it('keeps VLAN interfaces and addresses in a saved lab', () => {
    const { net, pc1 } = lab();
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    const l3 = [...copy.devices.values()].find((d) => d.spec.id === 'l3switch');
    expect(l3 && sh(copy, l3, 'ip -4 addr show br0.10').at(-1)).toContain('10.0.10.1/24');
    const copyPc = [...copy.devices.values()].find((d) => d.name === pc1.name);
    expect(copyPc && pings(copy, copyPc, '10.0.20.2')).toBe(true);
  });
});

/** A router with DHCP on eth0, a printer and a camera on a switch, and a PC. */
function office() {
  const net = new Network();
  const r1 = net.addDevice('router');
  const sw = net.addDevice('switch');
  const [printer, camera, pc] = [
    net.addDevice('printer'),
    net.addDevice('camera'),
    net.addDevice('pc'),
  ];
  net.connect(port(r1, 'eth0'), port(sw, 'eth0'));
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth0');
  sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.110,12h');
  net.connect(port(printer, 'eth0'), port(sw, 'eth1'));
  net.connect(port(camera, 'eth0'), port(sw, 'eth2'));
  net.connect(port(pc, 'eth0'), port(sw, 'eth3'));
  wait(net, 10_000);
  sh(net, pc, 'ip addr add 192.168.1.50/24 dev eth0');
  return { net, printer, camera, pc };
}

const addr = (d: Device) => d.ip?.allAddrs()[0] ?? null;

describe('printer', () => {
  it('asks for an address with DHCP when its cable is plugged in', () => {
    const { net, printer, camera } = office();
    expect(sh(net, printer, 'ip -4 addr show eth0').at(-1)).toContain('inet 192.168.1.');
    expect(addr(printer)?.ip).not.toBe(addr(camera)?.ip);
  });

  it('answers ping and serves a status page', () => {
    const { net, printer, pc } = office();
    const ip = sh(net, printer, 'ip -4 addr show eth0')
      .at(-1)
      ?.match(/inet ([\d.]+)\//)?.[1];
    expect(pings(net, pc, ip ?? '')).toBe(true);
    const page = sh(net, pc, `curl -s http://${ip}/`).join('\n');
    expect(page).toContain('Printer ready');
    expect(page).toContain('Name: printer1');
    expect(page).toContain(`Address: ${ip}`);
    expect(page).toContain('Pages printed: 0');
    expect(sh(net, pc, `curl -s http://${ip}/nope`).join('')).toContain('404 Not Found');
  });

  it('counts a print job sent with nc HOST 9100 < FILE', () => {
    const { net, printer, pc } = office();
    const ip = sh(net, printer, 'ip -4 addr show eth0')
      .at(-1)
      ?.match(/inet ([\d.]+)\//)?.[1];
    sh(net, pc, 'echo hello printer > /root/report.txt');
    expect(sh(net, pc, `nc ${ip} 9100 < /root/report.txt`)).toEqual([]);
    expect(printer.printer?.pages).toBe(1);
    sh(net, pc, `nc ${ip} 9100 < /root/report.txt`);
    expect(printer.printer?.pages).toBe(2);
    expect(sh(net, pc, `curl -s http://${ip}/`).join('\n')).toContain('Pages printed: 2');
    printer.printer?.reset();
    expect(printer.printer?.pages).toBe(0);
    // Connecting without sending anything is not a job.
    sh(net, pc, `nc -z ${ip} 9100`);
    expect(printer.printer?.pages).toBe(0);
    expect(net.scheduler.pending).toBe(0);
  });

  it('says so when the file does not exist', () => {
    const { net, pc } = office();
    expect(sh(net, pc, 'nc 192.168.1.101 9100 < /root/none.txt')).toEqual([
      'bash: /root/none.txt: No such file or directory',
    ]);
  });
});

describe('IP camera', () => {
  const ipOf = (net: Network, d: Device) =>
    sh(net, d, 'ip -4 addr show eth0')
      .at(-1)
      ?.match(/inet ([\d.]+)\//)?.[1] ?? '';

  it('serves a Live view page and answers ping', () => {
    const { net, camera, pc } = office();
    const ip = ipOf(net, camera);
    expect(pings(net, pc, ip)).toBe(true);
    const page = sh(net, pc, `curl -s http://${ip}/`).join('\n');
    expect(page).toContain('Live view');
    expect(page).toContain('Camera: cam1');
    expect(page).toContain('Viewers: 0');
  });

  it('streams one packet per second to a viewer until Ctrl+C, then goes quiet', () => {
    const { net, camera, pc } = office();
    const ip = ipOf(net, camera);
    const lines: string[] = [];
    let done = false;
    const before = net.trace.length;
    const proc = startCommand(net, pc, `nc ${ip} 554`, lines, () => (done = true));
    wait(net, 3_500);
    expect(lines).toEqual(['frame 1', 'frame 2', 'frame 3']);
    expect(camera.camera?.viewers).toBe(1);
    const stream = net.trace
      .slice(before)
      .filter((t) => t.frame.payload.kind === 'ipv4' && t.frame.payload.payload.kind === 'udp');
    expect(stream.length).toBeGreaterThanOrEqual(3);
    proc?.interrupt();
    expect(done).toBe(true);
    wait(net, 5_000);
    expect(camera.camera?.viewers).toBe(0);
    expect(net.scheduler.pending).toBe(0);
    wait(net, 5_000);
    expect(lines).toHaveLength(3);
  });

  it('stops streaming when the camera is removed', () => {
    const { net, camera, pc } = office();
    const lines: string[] = [];
    startCommand(net, pc, `nc ${ipOf(net, camera)} 554`, lines, () => {});
    wait(net, 2_500);
    net.removeDevice(camera);
    wait(net, 5_000);
    expect(lines).toHaveLength(2);
    expect(net.scheduler.pending).toBeLessThanOrEqual(1);
  });

  it('a firewall can block the stream', () => {
    const { net, camera, pc } = office();
    const lines: string[] = [];
    sh(net, pc, 'nft add table ip filter');
    sh(net, pc, 'nft add chain ip filter input { type filter hook input priority filter ; }');
    sh(net, pc, 'nft add rule ip filter input udp dport 5004 drop');
    startCommand(net, pc, `nc ${ipOf(net, camera)} 554`, lines, () => {});
    wait(net, 4_500);
    expect(lines).toEqual([]);
  });
});

/** Starts a long-running command; output goes to `lines` while virtual time advances. */
function startCommand(
  net: Network,
  device: Device,
  line: string,
  lines: string[],
  exit: () => void,
): Process | undefined {
  return run(net, device, line, { out: (l) => lines.push(l), exit });
}
