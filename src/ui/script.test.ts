import { describe, expect, test } from 'vitest';
import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { deviceScript } from '../engine/script.ts';
import { SOLUTIONS } from '../tasks/solutions.ts';
import { TASKS } from '../tasks/tasks.ts';
import { Lab } from './labBuilder.ts';
import { emptyProgress, type Project } from './project.ts';
import { SCENARIOS } from './scenarios.ts';

/**
 * The export is faithful if a fresh network, configured only by the generated commands run
 * through the simulator's own shell, ends up with the same configuration as the original.
 */

/** Lines the simulator cannot run (nothing today: every generated command exists in the shell). */
const EXPECTED_SKIPPED: string[] = [];

/** Runs generated lines the way a shell would: heredocs become files or piped input. */
function play(lab: Lab, device: Device, lines: readonly string[], skipped: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(.*) <<'(\w+)'$/.exec(line);
    if (!m) {
      try {
        lab.sh(device, line);
      } catch (error) {
        if (!String(error).includes('command not found')) throw error;
        skipped.push(`${device.name}: ${line}`);
      }
      continue;
    }
    const end = lines.indexOf(m[2] ?? '', i + 1);
    const body = lines.slice(i + 1, end).map((l) => `${l}\n`);
    i = end;
    const command = m[1] ?? '';
    const path = command.startsWith('cat > ') ? command.slice('cat > '.length) : '/tmp/nft.in';
    expect(device.fs?.write(path, body.join(''))).toBeNull();
    if (path === '/tmp/nft.in') {
      lab.sh(device, 'nft -f /tmp/nft.in');
      device.fs?.remove(path);
    }
  }
}

/** What must match: every device's saved configuration and the set of cables. */
function essence(net: Network) {
  const json = net.toJSON();
  const normalize = (files: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(files ?? {})
        // The export writes a key file for a WireGuard key that lived in no file.
        .filter(([path]) => !path.endsWith('.key'))
        .map(([path, text]) => [path, text.replace(/\n$/, '')]),
    );
  return {
    // The Internet cloud is simulator-only: the export gives it a comment, not commands.
    devices: json.devices
      .filter((d) => d.spec !== 'internet')
      .map((d) => ({ ...d, files: normalize(d.files) })),
    links: json.links
      .map((l) => [`${l.a.device}/${l.a.port}`, `${l.b.device}/${l.b.port}`].sort().join(' '))
      .sort(),
  };
}

/** The same machines as bare hardware: no addresses, services or setup, and no cables yet. */
function bareNetwork(original: Network): Network {
  const { devices, counters } = original.toJSON();
  return Network.fromJSON({
    devices: devices.map((d) => ({
      id: d.id,
      spec: d.spec,
      name: d.name,
      ports: d.ports.map((p) => ({ name: p.name, mac: p.mac, up: true })),
    })),
    links: [],
    counters,
  });
}

function roundTrip(original: Project): { skipped: string[]; rebuilt: Lab } {
  const lab = new Lab({
    net: bareNetwork(original.net),
    layout: original.layout,
    tasks: emptyProgress(),
  });
  const skipped: string[] = [];
  const snapshot = original.net.toJSON();
  for (const d of original.net.devices.values()) {
    const device = lab.net.devices.get(d.id);
    if (!device) throw new Error(`no ${d.id}`);
    play(lab, device, deviceScript(original.net, d, snapshot), skipped);
  }
  // Wi-Fi links come from `nmcli ... connect`; cables are plugged in last, like a person would.
  for (const l of snapshot.links) {
    const a = lab.net.devices.get(l.a.device);
    const b = lab.net.devices.get(l.b.device);
    if (!a || !b || a.port(l.a.port)?.type === 'wifi') continue;
    lab.cable(a, l.a.port, b, l.b.port);
  }
  lab.wait(30_000);
  return { skipped, rebuilt: lab };
}

function finishedTasks(): Project {
  const lab = new Lab();
  for (const task of TASKS) lab.apply(SOLUTIONS[task.id] ?? []);
  return lab.done();
}

describe('the exported commands rebuild the same network', () => {
  const cases: [string, () => Project][] = [
    ...SCENARIOS.map((s): [string, () => Project] => [`ready network: ${s.title}`, s.build]),
    ['the finished guided-task network', finishedTasks],
  ];
  for (const [name, build] of cases) {
    test(name, { timeout: 60_000 }, () => {
      const original = build();
      const { skipped, rebuilt } = roundTrip(original);
      expect(skipped).toEqual(EXPECTED_SKIPPED);
      expect(essence(rebuilt.net)).toEqual(essence(original.net));
    });
  }
});
