import { describe, expect, it } from 'vitest';
import { parseCidr } from '../engine/addr.ts';
import { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import {
  ProjectError,
  emptyProgress,
  parseProject,
  serializeProject,
  type ProjectFile,
} from './project.ts';

function sample() {
  const net = new Network();
  const pc = net.addDevice('pc');
  const sw = net.addDevice('switch');
  net.connect(pc, sw);
  const cidr = parseCidr('10.0.0.1/24');
  const port = pc.port('eth0');
  if (cidr && port) pc.ip?.addAddress(port, cidr);
  const text = serializeProject({
    net,
    layout: { [pc.id]: { x: 10, y: 20.5 }, [sw.id]: { x: -5, y: 0 } },
    tasks: { active: 'first-ping', steps: { 'first-ping': 2 } },
  });
  return { net, text };
}

function mutate(text: string, change: (file: ProjectFile) => void): string {
  const file = JSON.parse(text) as ProjectFile;
  change(file);
  return JSON.stringify(file);
}

describe('lab files', () => {
  it('round-trip the network, layout and task progress', () => {
    const { net, text } = sample();
    const project = parseProject(text);
    expect(project.net.toJSON()).toEqual(net.toJSON());
    expect(project.layout).toEqual({ d1: { x: 10, y: 20.5 }, d2: { x: -5, y: 0 } });
    expect(project.tasks).toEqual({ active: 'first-ping', steps: { 'first-ping': 2 } });
  });

  it('round-trip Wi-Fi devices and associations', () => {
    const net = new Network();
    net.locate = () => ({ x: 0, y: 0 });
    net.addDevice('ap');
    const laptop = net.addDevice('laptop');
    run(net, laptop, 'nmcli dev wifi connect NetForge password netforge123', {
      out: () => {},
      exit: () => {},
    });
    const project = parseProject(serializeProject({ net, layout: {}, tasks: emptyProgress() }));
    expect(project.net.toJSON()).toEqual(net.toJSON());
    expect(project.net.devices.get(laptop.id)?.port('wlan0')?.link?.medium).toBe('wireless');
  });

  it('accept files without task progress', () => {
    const { text } = sample();
    const project = parseProject(
      mutate(text, (f) => {
        delete (f as Partial<ProjectFile>).tasks;
      }),
    );
    expect(project.tasks).toEqual({ active: null, steps: {} });
  });

  it.each([
    ['not JSON', 'nope', /not valid JSON/],
    ['another format', '{"format":"other"}', /not a NetForge lab file/],
    ['a JSON array', '[]', /not an object/],
  ])('reject %s', (_, text, message) => {
    expect(() => parseProject(text)).toThrow(message);
  });

  it('upgrades version 1 files', () => {
    const mac = (n: number) => `02:00:00:00:00:0${n}`;
    const v1 = {
      format: 'netforge-lab',
      version: 1,
      network: {
        devices: [
          {
            id: 'd1',
            kind: 'host',
            name: 'pc1',
            ports: [{ name: 'eth0', mac: mac(1), up: true, addrs: ['10.0.0.1/24'] }],
          },
          {
            id: 'd2',
            kind: 'switch',
            name: 'sw1',
            ports: Array.from({ length: 8 }, (_, i) => ({
              name: `eth${i}`,
              mac: mac(i + 2),
              up: i !== 5,
            })),
          },
        ],
        links: [{ id: 'l1', a: { device: 'd1', port: 'eth0' }, b: { device: 'd2', port: 'eth3' } }],
        counters: { device: 2, link: 1, mac: 9, host: 1, switch: 1 },
      },
      layout: { d1: { x: 0, y: 0 }, d2: { x: 100, y: 0 } },
      tasks: { active: null, steps: { 'first-ping': 5 } },
    };
    const { net, tasks } = parseProject(JSON.stringify(v1));
    const sw = net.devices.get('d2');
    expect(sw?.spec.id).toBe('switch');
    expect(sw?.ports.map((p) => `${p.name}:${p.type}`).slice(-3)).toEqual([
      'eth7:ethernet',
      'eth8:sfp',
      'eth9:sfp',
    ]);
    expect(sw?.ports.at(-1)?.mac).toBe('02:00:00:00:00:0b');
    expect(sw?.port('eth5')?.adminUp).toBe(false);
    expect(net.devices.get('d1')?.ip?.allAddrs()).toHaveLength(1);
    expect(net.links.get('l1')?.b.name).toBe('eth3');
    expect(tasks.steps['first-ping']).toBe(5);
    // Counters carry over: new devices and MACs don't collide with old ones.
    const pc = net.addDevice('pc');
    expect([pc.id, pc.name, pc.ports[0]?.mac]).toEqual(['d3', 'pc2', '02:00:00:00:00:0c']);
  });

  it('loads version 5 files, which had no VLAN settings', () => {
    const { net, text } = sample();
    const project = parseProject(mutate(text, (f) => (f.version = 5)));
    expect(project.net.toJSON()).toEqual(net.toJSON());
  });

  it('round-trip VLAN settings and reject inconsistent ones', () => {
    const { net } = sample();
    const sw = net.devices.get('d2') ?? (undefined as never);
    const r1 = net.addDevice('router');
    const say = (d: typeof sw, line: string) =>
      run(net, d, line, { out: () => {}, exit: () => {} });
    say(sw, 'ip link set br0 type bridge vlan_filtering 1');
    say(sw, 'bridge vlan add dev eth3 vid 30 pvid untagged');
    say(r1, 'ip link add link eth0 name eth0.30 type vlan id 30');
    say(r1, 'ip addr add 10.30.0.1/24 dev eth0.30');
    const text = serializeProject({ net, layout: {}, tasks: emptyProgress() });
    expect(parseProject(text).net.toJSON()).toEqual(net.toJSON());
    const broken = mutate(text, (f) => {
      const vlans = f.network.devices[1]?.bridge?.vlans;
      if (vlans?.eth3) vlans.eth3.pvid = 99;
    });
    expect(() => parseProject(broken)).toThrow(/Invalid PVID/);
    const badId = mutate(text, (f) => {
      const v = f.network.devices[2]?.vlanPorts?.[0];
      if (v) v.vid = 5000;
    });
    expect(() => parseProject(badId)).toThrow(/VLAN id is invalid/);
  });

  it('round-trip the STP forward delay and dhcrelay; version 11 files still load', () => {
    const net = new Network();
    const sw = net.addDevice('switch');
    const r1 = net.addDevice('router');
    const say = (d: typeof sw, line: string) =>
      run(net, d, line, { out: () => {}, exit: () => {} });
    say(sw, 'ip link set br0 type bridge stp_state 1 forward_delay 200');
    say(r1, 'ip addr add 10.0.1.1/24 dev eth1');
    say(r1, 'dhcrelay -i eth1 10.0.0.10');
    const text = serializeProject({ net, layout: {}, tasks: emptyProgress() });
    const loaded = parseProject(text).net;
    expect(loaded.toJSON()).toEqual(net.toJSON());
    expect(loaded.devices.get(sw.id)?.bridge?.stp.forwardDelay).toBe(2000);
    expect(loaded.devices.get(r1.id)?.dhcrelay?.args).toEqual(['-i', 'eth1', '10.0.0.10']);
    // An older file has neither field and loads with the defaults.
    const empty = serializeProject({ net: new Network(), layout: {}, tasks: emptyProgress() });
    const old = mutate(empty, (f) => {
      f.version = 11;
    });
    expect(parseProject(old).net.devices.size).toBe(0);
    const bad = mutate(text, (f) => {
      const b = f.network.devices[0]?.bridge;
      if (b) b.forwardDelay = -3;
    });
    expect(() => parseProject(bad)).toThrow(/forward delay is invalid/);
  });

  it('round-trip IPv6 settings and reject bad ones', () => {
    const { net } = sample();
    const pc = net.devices.get('d1') ?? (undefined as never);
    const say = (line: string) => run(net, pc, line, { out: () => {}, exit: () => {} });
    say('ip addr add 2001:db8::10/64 dev eth0');
    say('ip -6 route add 2001:db8:5::/64 via 2001:db8::1');
    const text = serializeProject({ net, layout: {}, tasks: emptyProgress() });
    expect(parseProject(text).net.toJSON()).toEqual(net.toJSON());
    const bad = mutate(text, (f) => {
      const ip6 = f.network.devices[0]?.ip6;
      if (ip6) ip6.addrs.eth0 = ['2001:db8::<script>'];
    });
    expect(() => parseProject(bad)).toThrow(/IPv6 address is invalid/);
  });

  it('rejects files from a newer version', () => {
    const { text } = sample();
    expect(() => parseProject(mutate(text, (f) => (f.version = 99)))).toThrow(/newer version/);
  });

  it.each<[string, (f: ProjectFile) => void, RegExp]>([
    [
      'an unknown device type',
      (f) => Object.assign(f.network.devices[0] ?? {}, { spec: 'toaster' }),
      /type is invalid/,
    ],
    [
      'an address on a switch port',
      (f) => Object.assign(f.network.devices[1]?.ports[0] ?? {}, { addrs: ['10.0.0.9/24'] }),
      /cannot have an address/,
    ],
    [
      'an unsafe name',
      (f) => Object.assign(f.network.devices[0] ?? {}, { name: '<img onerror>' }),
      /name/,
    ],
    ['a bad MAC', (f) => Object.assign(f.network.devices[0]?.ports[0] ?? {}, { mac: 'zz' }), /MAC/],
    [
      'a bad address',
      (f) => Object.assign(f.network.devices[0]?.ports[0] ?? {}, { addrs: ['1.2.3.999/24'] }),
      /damaged/,
    ],
    [
      'a route out of an unknown interface',
      (f) =>
        Object.assign(f.network.devices[0] ?? {}, {
          ip: {
            forwarding: false,
            dns: [],
            routes: [{ dst: '0.0.0.0/0', via: '9.9.9.9', dev: 'eth99' }],
          },
        }),
      /damaged/,
    ],
    [
      'a malformed DNS server',
      (f) =>
        Object.assign(f.network.devices[0] ?? {}, {
          ip: { forwarding: false, dns: ['x'], routes: [] },
        }),
      /DNS server is invalid/,
    ],
    [
      'a dnsmasq option with odd characters',
      (f) =>
        Object.assign(f.network.devices[0] ?? {}, { services: { dnsmasq: ['--x=<b>\u0000'] } }),
      /dnsmasq option is invalid/,
    ],
    [
      'an unknown dnsmasq option',
      (f) => Object.assign(f.network.devices[0] ?? {}, { services: { dnsmasq: ['--foo'] } }),
      /bad command line options/,
    ],
    [
      'a dangling cable',
      (f) => Object.assign(f.network.links[0]?.b ?? {}, { device: 'd99' }),
      /damaged/,
    ],
    ['a NaN position', (f) => Object.assign(f.layout, { d1: { x: 'a', y: 1 } }), /position/],
    ['a negative counter', (f) => Object.assign(f.network.counters, { mac: -1 }), /counter/],
  ])('rejects %s', (_, change, message) => {
    const { text } = sample();
    expect(() => parseProject(mutate(text, change))).toThrow(message);
    expect(() => parseProject(mutate(text, change))).toThrow(ProjectError);
  });
});
