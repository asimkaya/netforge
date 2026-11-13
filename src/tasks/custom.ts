import { inSubnet, parseCidr, parseIp } from '../engine/addr.ts';
import { formatIp6, parseIp6 } from '../engine/addr6.ts';
import type { Device } from '../engine/device.ts';
import type { Network } from '../engine/network.ts';
import { peerOf } from '../engine/port.ts';
import { SPECS, type SpecId } from '../engine/specs.ts';
import type { Task, TaskContext } from './tasks.ts';

/**
 * Tasks written in the task editor and saved with the lab. Checks are data (not code), so
 * a shared lab can carry them safely. Devices are referred to by host name.
 */

export const SERVICES = [
  'dnsmasq',
  'httpd',
  'postfix',
  'dovecot',
  'bird',
  'sshd',
  'hostapd',
] as const;
export type ServiceName = (typeof SERVICES)[number];

export type CustomCheck =
  | { kind: 'ping'; from: string; to: string }
  | { kind: 'address'; device: string; network: string }
  | { kind: 'cable'; a: string; b: string }
  | { kind: 'service'; device: string; service: ServiceName }
  | { kind: 'command'; device: string; text: string }
  | { kind: 'devices'; spec: SpecId; count: number };

export type CheckKind = CustomCheck['kind'];

export interface CustomStep {
  title: string;
  detail: string;
  hint?: string;
  check: CustomCheck;
}

export interface CustomTask {
  id: string;
  title: string;
  summary: string;
  steps: CustomStep[];
  done: string;
}

export const CHECK_LABELS: Record<CheckKind, string> = {
  ping: 'A device gets a ping reply',
  address: 'A device has an address in a network',
  cable: 'Two devices are cabled together',
  service: 'A service runs on a device',
  command: 'A command was run',
  devices: 'The lab has enough devices of a type',
};

/** An empty check of a kind, for the editor. */
export function blankCheck(kind: CheckKind): CustomCheck {
  switch (kind) {
    case 'ping':
      return { kind, from: '', to: '' };
    case 'address':
      return { kind, device: '', network: '' };
    case 'cable':
      return { kind, a: '', b: '' };
    case 'service':
      return { kind, device: '', service: 'dnsmasq' };
    case 'command':
      return { kind, device: '', text: '' };
    case 'devices':
      return { kind, spec: 'pc', count: 1 };
  }
}

/** The check in words, e.g. "pc1 gets a reply from 10.0.0.2". */
export function describeCheck(c: CustomCheck): string {
  switch (c.kind) {
    case 'ping':
      return `${c.from} gets a ping reply from ${c.to}`;
    case 'address':
      return `${c.device} has an address in ${c.network}`;
    case 'cable':
      return `${c.a} and ${c.b} are cabled together`;
    case 'service':
      return `${c.service} runs on ${c.device}`;
    case 'command':
      return `${c.device || 'any device'} ran a command containing "${c.text}"`;
    case 'devices':
      return `at least ${c.count} × ${SPECS[c.spec].label}`;
  }
}

/** What is wrong with a check, or null. Used by the editor and when loading lab files. */
export function checkError(c: CustomCheck): string | null {
  const named = (name: string, what: string) => (name.trim() ? null : `Choose ${what}.`);
  switch (c.kind) {
    case 'ping':
      return named(c.from, 'the device that pings') ?? named(c.to, 'what it should reach');
    case 'address':
      return (
        named(c.device, 'a device') ??
        (parseCidr(c.network) ? null : 'Network: e.g. 192.168.1.0/24.')
      );
    case 'cable':
      return named(c.a, 'the first device') ?? named(c.b, 'the second device');
    case 'service':
      return named(c.device, 'a device');
    case 'command':
      return c.text.trim() ? null : 'Type the text the command must contain.';
    case 'devices':
      return Number.isInteger(c.count) && c.count >= 1 && c.count <= 50 ? null : 'Count: 1 to 50.';
  }
}

function byName(net: Network, name: string): Device | undefined {
  return [...net.devices.values()].find((d) => d.name === name);
}

/** Addresses `to` stands for: a literal address, or every address of a device by name. */
function targets(net: Network, to: string): { v4: number[]; v6: string[] } {
  const v4 = parseIp(to);
  if (v4 !== null) return { v4: [v4], v6: [] };
  const v6 = parseIp6(to);
  if (v6 !== null) return { v4: [], v6: [formatIp6(v6)] };
  const d = byName(net, to);
  return {
    v4: d?.ip?.allAddrs().map((a) => a.ip) ?? [],
    v6:
      d?.ip?.ports.flatMap((p) => d.ip?.v6.addrsOn(p).map((a) => formatIp6(a.cidr.ip)) ?? []) ?? [],
  };
}

function passes(c: CustomCheck, ctx: TaskContext): boolean {
  const { net } = ctx;
  switch (c.kind) {
    case 'ping': {
      const from = byName(net, c.from)?.ip;
      if (!from) return false;
      const t = targets(net, c.to);
      const v6Replies = [...from.v6.echoRepliesFrom].map(formatIp6);
      return (
        t.v4.some((ip) => from.echoRepliesFrom.has(ip)) || t.v6.some((ip) => v6Replies.includes(ip))
      );
    }
    case 'address': {
      const net4 = parseCidr(c.network);
      const d = byName(net, c.device);
      return !!net4 && !!d?.ip?.allAddrs().some((a) => inSubnet(a.ip, net4));
    }
    case 'cable': {
      const a = byName(net, c.a);
      return !!a?.ports.some((p) => peerOf(p)?.device.name === c.b);
    }
    case 'service': {
      const d = byName(net, c.device);
      if (!d) return false;
      if (c.service === 'sshd') return d.sshd !== null;
      return d[c.service] !== null;
    }
    case 'command': {
      const text = c.text.toLowerCase();
      return ctx.commands.some((cmd) => {
        const d = net.devices.get(cmd.device);
        return (!c.device || d?.name === c.device) && cmd.line.toLowerCase().includes(text);
      });
    }
    case 'devices':
      return [...net.devices.values()].filter((d) => d.spec.id === c.spec).length >= c.count;
  }
}

/** Turns a saved task into a playable one. */
export function compile(t: CustomTask): Task {
  return {
    id: t.id,
    title: t.title,
    summary: t.summary,
    done: t.done || 'Task complete. Well done!',
    steps: t.steps.map((s) => ({
      title: s.title,
      detail: s.detail || describeCheck(s.check),
      ...(s.hint ? { hint: s.hint } : {}),
      check: (ctx) => passes(s.check, ctx),
    })),
  };
}
