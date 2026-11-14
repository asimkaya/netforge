import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { run } from '../engine/shell.ts';
import type { SpecId } from '../engine/specs.ts';
import type { Action } from '../tasks/solutions.ts';
import { FOOTPRINT } from './placement.ts';
import { emptyProgress, parseProject, serializeProject, type Project } from './project.ts';

const OUTPUT_PROBLEM = /error|cannot|not found|unreachable|failed|no dhcpoffers|usage/i;

/**
 * Builds a lab the way a user would: devices, cables, then shell commands. A command that
 * prints an error throws, so a scenario cannot silently rot when the engine changes.
 */
export class Lab {
  readonly net: Network;
  readonly layout: Project['layout'];
  /** Every command run with `sh`, the way the app records a learner's commands. */
  readonly commands: { device: string; line: string }[] = [];

  constructor(from?: Project) {
    this.net = from?.net ?? new Network();
    this.layout = from?.layout ?? {};
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
    this.#run(device, lines, true);
  }

  /** `watch`: a command that never ends on its own runs this many ms, then gets Ctrl+C. */
  #run(device: Device, lines: string[], strict: boolean, watch?: number): void {
    for (const raw of lines) {
      const line = raw.replace(/\{pubkey:(\w+)\}/g, (_, name: string) => {
        const peer = this.named(name);
        return peer.wireguard(peer.port('wg0'))?.publicKey ?? '';
      });
      this.commands.push({ device: device.id, line });
      let done = false;
      const proc = run(this.net, device, line, {
        out: (text) => {
          if (strict && OUTPUT_PROBLEM.test(text)) {
            throw new Error(`scenario: ${device.name}: ${text}`);
          }
        },
        exit: () => (done = true),
      });
      if (proc && watch !== undefined) {
        this.wait(watch);
        proc.interrupt();
        this.wait(5_000);
      }
      for (let t = 0; proc && !done && t < 60_000; t += 100) this.wait(100);
      if (proc && !done) throw new Error(`scenario: ${device.name}: "${line}" did not finish`);
    }
  }

  named(name: string): Device {
    const device = [...this.net.devices.values()].find((d) => d.name === name);
    if (!device) throw new Error(`scenario: no device ${name}`);
    return device;
  }

  #port(ref: string) {
    const [name = '', port = ''] = ref.split('/');
    const found = this.named(name).port(port);
    if (!found) throw new Error(`scenario: no port ${ref}`);
    return found;
  }

  /** Plays a scripted list of moves (see `SOLUTIONS`). */
  apply(actions: readonly Action[]): void {
    for (const a of actions) {
      if ('add' in a) this.add(a.add, ...a.at);
      else if ('cable' in a) this.net.connect(this.#port(a.cable[0]), this.#port(a.cable[1]));
      else if ('uncable' in a) {
        const link = this.#port(a.uncable).link;
        if (!link) throw new Error(`scenario: ${a.uncable} has no cable`);
        this.net.disconnect(link);
      } else if ('sh' in a) this.#run(this.named(a.sh), a.lines, !a.failing, a.watch);
      else this.wait(a.wait);
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
