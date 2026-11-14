import { describe, expect, it } from 'vitest';
import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import { TASKS, advance, findTask, type Task, type TaskContext } from './tasks.ts';

function play(net: Network) {
  const ctx: TaskContext = { net, commands: [] };
  const sh = (device: Device, line: string) => {
    ctx.commands.push({ device: device.id, line });
    run(net, device, line, { out: () => {}, exit: () => {} });
    net.scheduler.runUntil(net.scheduler.now + 30_000);
  };
  return { ctx, sh };
}

function task(id: string): Task {
  const t = findTask(id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

describe('tasks', () => {
  it('have unique ids and at least one step', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) expect(t.steps.length).toBeGreaterThan(0);
  });

  it('first-ping completes step by step as the user builds the network', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);

    expect(progress()).toBe(0);
    const pc1 = net.addDevice('pc');
    const pc2 = net.addDevice('pc');
    expect(progress()).toBe(1);
    net.connect(pc1, pc2);
    expect(progress()).toBe(2);
    sh(pc1, 'ip addr add 192.168.1.10/24 dev eth0');
    expect(progress()).toBe(3);
    sh(pc2, 'ip addr add 192.168.2.20/24 dev eth0');
    expect(progress()).toBe(3); // different network: not done yet
    sh(pc2, 'ip addr flush dev eth0');
    sh(pc2, 'ip addr add 192.168.1.20/24 dev eth0');
    expect(progress()).toBe(4);
    sh(pc1, 'ping -c 1 192.168.1.20');
    expect(progress()).toBe(5);
  });

  it('a ping to yourself does not count', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx, sh } = play(net);
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(pc1, pc2);
    sh(pc1, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(pc2, 'ip addr add 10.0.0.2/24 dev eth0');
    sh(pc1, 'ping -c 1 10.0.0.1');
    expect(advance(t, ctx, 0)).toBe(4);
  });

  it('keeps completed steps even if the network changes later', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx } = play(net);
    const pc = net.addDevice('pc');
    net.addDevice('pc');
    expect(advance(t, ctx, 0)).toBe(1);
    net.removeDevice(pc);
    expect(advance(t, ctx, 1)).toBe(1);
    expect(advance(t, ctx, 99)).toBe(t.steps.length);
  });
});
