import { describe, expect, it } from 'vitest';
import { printJob, watchCamera, type CameraEvent, type PrintResult } from './appliance-clients.ts';
import { Network } from './network.ts';
import { formatIp } from './addr.ts';
import type { Device } from './device.ts';
import { port, sh, wait } from './testing.ts';

const ipOf = (d: Device) => formatIp(d.ip?.allAddrs()[0]?.ip ?? 0);

/** A router with DHCP, a printer and a camera on a switch, and a PC. */
function lab() {
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

describe('printJob', () => {
  it('prints a page and reports where it went', () => {
    const { net, printer, pc } = lab();
    let result: PrintResult | undefined;
    printJob(pc, ipOf(printer), 'Hello', (r) => (result = r));
    wait(net, 5_000);
    expect(result).toEqual({ ok: true, ip: ipOf(printer) });
    expect(printer.printer?.pages).toBe(1);
  });

  it('reports a name that does not resolve and a closed port', () => {
    const { net, pc } = lab();
    const results: PrintResult[] = [];
    printJob(pc, 'nope.lab', 'Hello', (r) => results.push(r));
    printJob(pc, '192.168.1.1', 'Hello', (r) => results.push(r));
    wait(net, 30_000);
    const errors = results.map((r) => (r.ok ? '' : r.error));
    expect(errors.some((e) => e.includes('Could not resolve'))).toBe(true);
    expect(errors.some((e) => e.includes('Connection refused'))).toBe(true);
  });
});

describe('watchCamera', () => {
  it('receives frames, and cancel leaves nothing pending', () => {
    const { net, camera, pc } = lab();
    const events: CameraEvent[] = [];
    const cancel = watchCamera(pc, ipOf(camera), (e) => events.push(e));
    wait(net, 3_500);
    const frames = events.flatMap((e) => (e.kind === 'frame' ? [e.frame] : []));
    expect(frames).toEqual([1, 2, 3]);
    expect(events[0]?.kind).toBe('connected');
    expect(camera.camera?.watchers.size).toBe(1);
    cancel();
    wait(net, 5_000);
    expect(camera.camera?.viewers).toBe(0);
    expect(net.scheduler.pending).toBe(0);
  });

  it('reports an unknown name', () => {
    const { net, pc } = lab();
    const events: CameraEvent[] = [];
    watchCamera(pc, 'nope.lab', (e) => events.push(e));
    wait(net, 10_000);
    expect(events.map((e) => e.kind)).toEqual(['error']);
  });
});
