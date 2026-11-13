import { describe, expect, it } from 'vitest';
import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import { emptyProgress, parseProject, serializeProject } from '../ui/project.ts';
import { checkError, compile, describeCheck, type CustomTask } from './custom.ts';
import { advance, findTask, type TaskContext } from './tasks.ts';

const TASK: CustomTask = {
  id: 'custom-fix-it',
  title: 'Fix the office',
  summary: 'pc2 cannot reach the server.',
  steps: [
    {
      title: 'Cable pc2',
      detail: 'Plug pc2 into the switch.',
      check: { kind: 'cable', a: 'pc2', b: 'sw1' },
    },
    {
      title: 'Address pc2',
      detail: '',
      hint: 'Same network as srv1.',
      check: { kind: 'address', device: 'pc2', network: '10.0.0.0/24' },
    },
    { title: 'Ping', detail: '', check: { kind: 'ping', from: 'pc2', to: 'srv1' } },
    { title: 'Look', detail: '', check: { kind: 'command', device: '', text: 'ip neigh' } },
    { title: 'Serve', detail: '', check: { kind: 'service', device: 'srv1', service: 'httpd' } },
    { title: 'Grow', detail: '', check: { kind: 'devices', spec: 'pc', count: 3 } },
  ],
  done: 'Fixed!',
};

function play() {
  const net = new Network();
  const ctx: TaskContext = { net, commands: [] };
  const sh = (d: Device, line: string) => {
    ctx.commands.push({ device: d.id, line });
    run(net, d, line, { out: () => {}, exit: () => {} });
    net.scheduler.runUntil(net.scheduler.now + 30_000);
  };
  return { net, ctx, sh };
}

describe('custom tasks', () => {
  it('describe and validate their checks', () => {
    expect(TASK.steps.map((s) => describeCheck(s.check))).toEqual([
      'pc2 and sw1 are cabled together',
      'pc2 has an address in 10.0.0.0/24',
      'pc2 gets a ping reply from srv1',
      'any device ran a command containing "ip neigh"',
      'httpd runs on srv1',
      'at least 3 × PC',
    ]);
    expect(checkError({ kind: 'address', device: 'pc2', network: 'nope' })).toMatch(/Network/);
    expect(checkError({ kind: 'ping', from: '', to: 'x' })).toMatch(/Choose/);
  });

  it('play step by step on a prepared lab', () => {
    const { net, ctx, sh } = play();
    const sw = net.addDevice('switch');
    const srv = net.addDevice('server');
    const pc1 = net.addDevice('pc', 'pc1');
    const pc2 = net.addDevice('pc', 'pc2');
    net.connect(srv, sw);
    net.connect(pc1, sw);
    sh(srv, 'ip addr add 10.0.0.1/24 dev eth0');
    const task = findTask(TASK.id, [TASK]) ?? compile(TASK);
    expect(task.steps[1]?.detail).toBe('pc2 has an address in 10.0.0.0/24');
    expect(advance(task, ctx, 0)).toBe(0);
    net.connect(pc2, sw);
    expect(advance(task, ctx, 0)).toBe(1);
    sh(pc2, 'ip addr add 10.0.0.2/24 dev eth0');
    expect(advance(task, ctx, 0)).toBe(2);
    sh(pc2, 'ping -c 1 10.0.0.1');
    expect(advance(task, ctx, 0)).toBe(3);
    sh(pc2, 'ip neigh');
    sh(srv, 'httpd');
    expect(advance(task, ctx, 0)).toBe(5);
    net.addDevice('pc');
    expect(advance(task, ctx, 0)).toBe(6);
  });

  it('travel in lab files, and bad ones are refused', () => {
    const net = new Network();
    const tasks = { ...emptyProgress(), custom: [TASK] };
    const text = serializeProject({ net, layout: {}, tasks });
    expect(parseProject(text).tasks.custom).toEqual([TASK]);
    const broken = (change: (t: Record<string, unknown>) => void) => {
      const file = JSON.parse(text) as { tasks: { custom: Record<string, unknown>[] } };
      const first = file.tasks.custom[0];
      if (first) change(first);
      return JSON.stringify(file);
    };
    expect(() => parseProject(broken((t) => (t.steps = [])))).toThrow(/1 to 30 steps/);
    expect(() => parseProject(broken((t) => (t.id = 'first-ping')))).toThrow(/id is invalid/);
    expect(() =>
      parseProject(
        broken((t) => {
          (t.steps as unknown[])[0] = {
            title: 'x',
            detail: '',
            check: { kind: 'eval', code: 'alert(1)' },
          };
        }),
      ),
    ).toThrow(/kind is invalid/);
  });
});
