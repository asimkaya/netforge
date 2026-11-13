import { describe, expect, it } from 'vitest';
import { parseCidr } from '../engine/addr.ts';
import { Network } from '../engine/network.ts';
import { ProjectError, parseProject, serializeProject, type ProjectFile } from './project.ts';

function sample() {
  const net = new Network();
  const pc = net.addHost();
  const sw = net.addSwitch();
  net.connect(pc, sw);
  const cidr = parseCidr('10.0.0.1/24');
  const port = pc.port('eth0');
  if (cidr && port) pc.addAddress(port, cidr);
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

  it('rejects files from a newer version', () => {
    const { text } = sample();
    expect(() => parseProject(mutate(text, (f) => (f.version = 99)))).toThrow(/newer version/);
  });

  it.each<[string, (f: ProjectFile) => void, RegExp]>([
    [
      'a bad device kind',
      (f) => Object.assign(f.network.devices[0] ?? {}, { kind: 'router' }),
      /kind/,
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
