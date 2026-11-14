import type { Fabric } from './device.ts';
import { STP_MAC, type BpduPacket } from './packet.ts';
import { hasCarrier, type Port } from './port.ts';

/**
 * Spanning Tree (802.1D, as the Linux bridge runs it with `stp_state 1`): bridges elect a
 * root, each keeps one path towards it and blocks the others, so redundant cables do not
 * loop. Simplified: BPDUs are sent when something changes instead of every 2 s hello, and
 * there is no max age (link failures are seen directly). See docs/FEATURES.md.
 */

export type StpState = 'disabled' | 'blocking' | 'listening' | 'learning' | 'forwarding';
export type StpRole = 'root' | 'designated' | 'alternate' | 'disabled';

/** Linux `forward_delay` (15 s): time spent listening, then learning, before forwarding. */
export const FORWARD_DELAY_MS = 15_000;
export const DEFAULT_PRIORITY = 32768;

interface Vector {
  rootId: string;
  rootCost: number;
  bridgeId: string;
  portId: number;
}

export interface StpPort {
  state: StpState;
  role: StpRole;
  /** Best BPDU heard on the port. */
  info: Vector | null;
  timer: number | null;
}

function compare(a: Vector, b: Vector): number {
  if (a.rootId !== b.rootId) return a.rootId < b.rootId ? -1 : 1;
  if (a.rootCost !== b.rootCost) return a.rootCost - b.rootCost;
  if (a.bridgeId !== b.bridgeId) return a.bridgeId < b.bridgeId ? -1 : 1;
  return a.portId - b.portId;
}

/** Linux path costs by speed: copper ports are 1 Gb/s (4), fiber 10 Gb/s (2). */
export function pathCost(port: Port): number {
  return port.type === 'sfp' ? 2 : 4;
}

export class Stp {
  enabled = false;
  priority = DEFAULT_PRIORITY;
  /** Time in each of listening and learning (`forward_delay`, set in ms; Linux: 2-30 s). */
  forwardDelay = FORWARD_DELAY_MS;
  /** While true, ports skip the forward delay (used when a saved lab is loaded). */
  instant = false;
  readonly ports = new Map<Port, StpPort>();
  rootId = '';
  rootCost = 0;
  rootPort: Port | null = null;
  readonly #seenChanges = new Set<string>();
  #changes = 0;

  constructor(
    readonly fabric: Fabric,
    readonly bridgePorts: readonly Port[],
    /** Forget learned MAC addresses (after a topology change). */
    readonly flush: () => void,
  ) {
    for (const port of bridgePorts) {
      this.ports.set(port, { state: 'forwarding', role: 'designated', info: null, timer: null });
    }
    this.rootId = this.bridgeId;
  }

  /** Priority in hex, then the lowest port MAC, like `8000.02:00:00:00:00:05`. */
  get bridgeId(): string {
    const mac = [...this.bridgePorts].map((p) => p.mac).sort()[0] ?? '';
    return `${this.priority.toString(16).padStart(4, '0')}.${mac}`;
  }

  portId(port: Port): number {
    return 0x8000 + this.bridgePorts.indexOf(port) + 1;
  }

  /** Whether the bridge may forward frames received on, or sent to, this port. */
  forwards(port: Port): boolean {
    return !this.enabled || this.ports.get(port)?.state === 'forwarding';
  }

  /** Whether the bridge learns addresses from frames on this port. */
  learns(port: Port): boolean {
    const state = this.ports.get(port)?.state;
    return !this.enabled || state === 'forwarding' || state === 'learning';
  }

  /** The state `bridge link` shows: without STP a port with a cable just forwards. */
  stateOf(port: Port): StpState {
    if (!hasCarrier(port)) return 'disabled';
    return this.enabled ? (this.ports.get(port)?.state ?? 'disabled') : 'forwarding';
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const [port, s] of this.ports) {
      this.#cancel(s);
      s.info = null;
      s.state = on ? (hasCarrier(port) ? 'blocking' : 'disabled') : 'forwarding';
      s.role = 'designated';
    }
    this.flush();
    if (on) {
      this.#recompute();
      this.#advertise();
    }
    this.fabric.changed();
  }

  /** `forward_delay`: the time spent listening, then learning, on ports that come up later. */
  setForwardDelay(ms: number): void {
    this.forwardDelay = ms;
    this.fabric.changed();
  }

  setPriority(priority: number): void {
    this.priority = priority;
    if (!this.enabled) return;
    this.#recompute();
    this.#advertise();
    this.fabric.changed();
  }

  carrierChanged(port: Port): void {
    const s = this.ports.get(port);
    if (!this.enabled || !s) return;
    s.info = null;
    if (!hasCarrier(port)) {
      if (s.state === 'forwarding') this.#topologyChange();
      this.#cancel(s);
      s.state = 'disabled';
    } else if (s.state === 'disabled') {
      s.state = 'blocking';
    }
    if (this.#recompute()) this.#advertise();
    else if (hasCarrier(port) && s.role === 'designated') this.#send(port);
    this.fabric.changed();
  }

  receive(port: Port, bpdu: BpduPacket): void {
    const s = this.ports.get(port);
    if (!s || !hasCarrier(port)) return;
    const heard: Vector = {
      rootId: bpdu.rootId,
      rootCost: bpdu.rootCost,
      bridgeId: bpdu.bridgeId,
      portId: bpdu.portId,
    };
    const old = s.info;
    // Better news replaces what we knew; so does any news from the same sender.
    const fromSame = old?.bridgeId === heard.bridgeId && old.portId === heard.portId;
    if (!old || fromSame || compare(heard, old) < 0) s.info = heard;
    if (bpdu.tc && !this.#seenChanges.has(bpdu.tc)) {
      this.#seenChanges.add(bpdu.tc);
      this.flush();
      this.#advertise(bpdu.tc, port);
    }
    if (this.#recompute()) this.#advertise();
    else if (s.role === 'designated' && compare(this.#offered(port), heard) < 0) {
      // The sender thinks it is designated here; tell it about the better root.
      this.#send(port);
    }
    this.fabric.changed();
  }

  #offered(port: Port): Vector {
    return {
      rootId: this.rootId,
      rootCost: this.rootCost,
      bridgeId: this.bridgeId,
      portId: this.portId(port),
    };
  }

  /** Elects the root port and the role of every port. Returns true if anything changed. */
  #recompute(): boolean {
    const me = this.bridgeId;
    let best: { v: Vector; port: Port } | null = null;
    for (const [port, s] of this.ports) {
      if (!s.info || !hasCarrier(port) || s.info.bridgeId === me) continue;
      const v = { ...s.info, rootCost: s.info.rootCost + pathCost(port) };
      if (v.rootId >= me) continue;
      const better =
        !best ||
        compare(v, best.v) < 0 ||
        (compare(v, best.v) === 0 && this.portId(port) < this.portId(best.port));
      if (better) best = { v, port };
    }
    const before = JSON.stringify([this.rootId, this.rootCost, this.rootPort?.name, this.#roles()]);
    this.rootId = best?.v.rootId ?? me;
    this.rootCost = best?.v.rootCost ?? 0;
    this.rootPort = best?.port ?? null;
    const resigned: Port[] = [];
    for (const [port, s] of this.ports) {
      const was = s.role;
      if (!hasCarrier(port)) s.role = 'disabled';
      else if (port === this.rootPort) s.role = 'root';
      else if (!s.info || compare(this.#offered(port), s.info) < 0) s.role = 'designated';
      else s.role = 'alternate';
      if (was === 'designated' && (s.role === 'root' || s.role === 'alternate'))
        resigned.push(port);
      this.#applyRole(s);
    }
    // We stopped being the designated bridge on these cables. Real bridges notice when our
    // hellos stop (max age); without hellos, say it once so the neighbor forgets our old
    // offer and can take over (otherwise its port stays blocked after a failover).
    for (const port of resigned) this.#send(port);
    return (
      before !== JSON.stringify([this.rootId, this.rootCost, this.rootPort?.name, this.#roles()])
    );
  }

  #roles(): string[] {
    return [...this.ports.values()].map((s) => s.role);
  }

  #applyRole(s: StpPort): void {
    if (s.role === 'disabled') return;
    if (s.role === 'alternate') {
      if (s.state === 'forwarding') this.#topologyChange();
      this.#cancel(s);
      s.state = 'blocking';
      return;
    }
    if (s.state !== 'blocking') return;
    if (this.instant) {
      s.state = 'forwarding';
      return;
    }
    s.state = 'listening';
    s.timer = this.fabric.scheduler.schedule(this.forwardDelay, () => {
      s.state = 'learning';
      s.timer = this.fabric.scheduler.schedule(this.forwardDelay, () => {
        s.timer = null;
        s.state = 'forwarding';
        this.#topologyChange();
        this.fabric.changed();
      });
      this.fabric.changed();
    });
  }

  #cancel(s: StpPort): void {
    if (s.timer !== null) this.fabric.scheduler.cancel(s.timer);
    s.timer = null;
  }

  /** A port started or stopped forwarding: everyone forgets learned addresses. */
  #topologyChange(): void {
    const id = `${this.bridgeId}#${++this.#changes}`;
    this.#seenChanges.add(id);
    this.flush();
    this.#advertise(id);
  }

  /** Sends our BPDU on designated ports (or, for a topology change, on every active port). */
  #advertise(tc?: string, except?: Port): void {
    for (const [port, s] of this.ports) {
      if (port === except || !hasCarrier(port)) continue;
      if (s.role === 'designated' || (tc && s.role === 'root')) this.#send(port, tc);
    }
  }

  #send(port: Port, tc?: string): void {
    const bpdu: BpduPacket = {
      kind: 'bpdu',
      rootId: this.rootId,
      rootCost: this.rootCost,
      bridgeId: this.bridgeId,
      portId: this.portId(port),
      ...(tc ? { tc } : {}),
    };
    this.fabric.transmit(port, { src: port.mac, dst: STP_MAC, payload: bpdu });
  }
}
