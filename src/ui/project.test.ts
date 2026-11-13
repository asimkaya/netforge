import { describe, expect, it } from 'vitest';
import { parseCidr } from '../engine/addr.ts';
import { Network } from '../engine/network.ts';
import { ProjectError, parseProject, serializeProject, type ProjectFile } from './project.ts';

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
      'a route through an unknown gateway',
      (f) =>
        Object.assign(f.network.devices[0] ?? {}, {
          ip: {
            forwarding: false,
            dns: [],
            routes: [{ dst: '0.0.0.0/0', via: '9.9.9.9', dev: 'eth0' }],
          },
        }),
      /invalid gateway/,
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
