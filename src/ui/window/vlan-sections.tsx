import { useState, type FormEvent } from 'react';
import type { Bridge } from '../../engine/bridge.ts';
import type { Device } from '../../engine/device.ts';
import type { Port } from '../../engine/port.ts';
import { FIELD, PRIMARY, SECONDARY } from '../apps/IpConfig.tsx';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

type Mode = 'access' | 'trunk';

/** How a port is set up, in switch terms: one untagged VLAN, or tagged VLANs on a trunk. */
function portMode(bridge: Bridge, port: Port): { mode: Mode; vlans: string } {
  const v = bridge.vlans.get(port);
  const vids = [...(v?.vids ?? [])].sort((a, b) => a - b);
  if (v && vids.length === 1 && v.pvid === vids[0] && v.untagged.has(v.pvid)) {
    return { mode: 'access', vlans: String(v.pvid) };
  }
  return { mode: 'trunk', vlans: vids.filter((vid) => !v?.untagged.has(vid)).join(',') };
}

function parseVids(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const vids = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  return vids.length > 0 && vids.every((v) => v >= 1 && v <= 4094) ? vids : null;
}

/** Applies a port mode with the same steps as `bridge vlan del` + `bridge vlan add`. */
function applyMode(bridge: Bridge, port: Port, mode: Mode, vids: number[]): void {
  for (const vid of [...(bridge.vlans.get(port)?.vids ?? [])]) bridge.delVlan(port, vid);
  if (mode === 'access') {
    bridge.addVlan(port, vids[0] ?? 1, { pvid: true, untagged: true });
    return;
  }
  // A trunk keeps VLAN 1 untagged (the native VLAN) and tags the others.
  bridge.addVlan(port, 1, { pvid: true, untagged: true });
  for (const vid of vids)
    if (vid !== 1) bridge.addVlan(port, vid, { pvid: false, untagged: false });
}

function commandsFor(port: Port, mode: Mode, vids: number[]): string {
  const add = (vid: number, flags: string) =>
    `bridge vlan add dev ${port.name} vid ${vid}${flags}`.trim();
  return mode === 'access'
    ? add(vids[0] ?? 1, ' pvid untagged')
    : vids.map((vid) => add(vid, '')).join('; ');
}

function PortVlanRow({ bridge, port }: { bridge: Bridge; port: Port }) {
  const current = portMode(bridge, port);
  const [mode, setMode] = useState<Mode>(current.mode);
  const [text, setText] = useState(current.vlans);
  const vids = parseVids(text);
  const valid = vids !== null && (mode === 'trunk' || vids.length === 1);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) applyMode(bridge, port, mode, vids);
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2 text-xs">
      <span className="w-10 font-mono">{port.name}</span>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
        aria-label={`${port.name} mode`}
        className={FIELD}
      >
        <option value="access">Access</option>
        <option value="trunk">Trunk</option>
      </select>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${port.name} VLANs`}
        aria-invalid={!valid}
        placeholder={mode === 'access' ? '10' : '10,20'}
        className={`${FIELD} w-24 ${valid ? '' : 'border-red-500'}`}
      />
      <button type="submit" disabled={!valid} className={SECONDARY}>
        Set
      </button>
      {valid && <code className="truncate text-(--nf-muted)">{commandsFor(port, mode, vids)}</code>}
    </form>
  );
}

/** Switch VLANs: turn filtering on, then make each port an access port or a trunk. */
export function SwitchVlanSection({ device }: { device: Device }) {
  useLab();
  const bridge = device.bridge;
  if (!bridge || bridge.ports.some((p) => p.type === 'wifi')) return null;
  return (
    <Section title="VLANs">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={bridge.vlanFiltering}
          onChange={(e) => bridge.setVlanFiltering(e.target.checked)}
        />
        VLAN filtering
        <code className="text-(--nf-muted)">
          ip link set br0 type bridge vlan_filtering {bridge.vlanFiltering ? 0 : 1}
        </code>
      </label>
      {bridge.vlanFiltering ? (
        <div className="space-y-1">
          <p className="text-xs text-(--nf-muted)">
            Access: the port belongs to one VLAN, frames go out untagged. Trunk: carries the listed
            VLANs tagged (802.1Q), for a link to another switch or a router.
          </p>
          {bridge.ports.map((port) => {
            const m = portMode(bridge, port);
            // Remount when the shell changes the port, so the form shows the new setting.
            const key = `${port.name}/${m.mode}/${m.vlans}`;
            return <PortVlanRow key={key} bridge={bridge} port={port} />;
          })}
        </div>
      ) : (
        <p className="text-xs text-(--nf-muted)">
          Off: every port is in one network and VLAN settings are ignored.
        </p>
      )}
    </Section>
  );
}

/** VLAN interfaces (`eth0.10`) for routing between VLANs over one trunk port. */
export function VlanInterfacesSection({ device }: { device: Device }) {
  const { net } = useLab();
  const parents = device.ip?.ports.filter((p) => !p.parent && p.type !== 'wifi') ?? [];
  const [parent, setParent] = useState(parents[0]?.name ?? '');
  const [vid, setVid] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (parents.length === 0) return null;
  const vids = parseVids(vid);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const port = device.port(parent);
    const id = vids?.[0];
    if (!port || id === undefined) return;
    const name = `${parent}.${id}`;
    const failed = device.addVlanPort(port, name, id);
    setError(failed);
    const created = device.port(name);
    if (!failed && created) net.setPortUp(created, true);
    if (!failed) setVid('');
  };
  return (
    <Section title="VLAN interfaces">
      <ul className="space-y-1 text-xs">
        {device.vlanPorts.map((p) => (
          <li key={p.name} className="flex items-center gap-2">
            <span className="font-mono">{p.name}</span>
            <span className="text-(--nf-muted)">
              VLAN {p.vid} on {p.parent?.name} · {device.ip?.addrsOn(p).length ?? 0} address(es)
            </span>
            <button
              type="button"
              onClick={() => device.removeVlanPort(p)}
              className={SECONDARY}
              aria-label={`Delete ${p.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          Port
          <select value={parent} onChange={(e) => setParent(e.target.value)} className={FIELD}>
            {parents.map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          VLAN id
          <input
            value={vid}
            onChange={(e) => setVid(e.target.value)}
            placeholder="10"
            className={`${FIELD} w-20`}
          />
        </label>
        <button type="submit" disabled={vids?.length !== 1} className={PRIMARY}>
          Add VLAN interface
        </button>
      </form>
      <code className="block text-xs text-(--nf-muted)">
        ip link add link {parent} name {parent}.{vids?.[0] ?? 'VID'} type vlan id{' '}
        {vids?.[0] ?? 'VID'}; ip link set {parent}.{vids?.[0] ?? 'VID'} up
      </code>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <p className="text-xs text-(--nf-muted)">
        Give each VLAN interface an address under Addresses; it becomes that VLAN&apos;s gateway.
      </p>
    </Section>
  );
}

/** Spanning Tree: on/off, bridge priority, the elected root and each port's role. */
export function StpSection({ device }: { device: Device }) {
  const { net } = useLab();
  const bridge = device.bridge;
  const [priority, setPriority] = useState(String(bridge?.stp.priority ?? 32768));
  const [error, setError] = useState<string | null>(null);
  if (!bridge || bridge.ports.some((p) => p.type === 'wifi')) return null;
  const stp = bridge.stp;
  const rootDevice = [...net.devices.values()].find((d) => d.bridge?.stp.bridgeId === stp.rootId);
  const toggle = (on: boolean) => {
    if (!on && net.hasL2Loop(device)) {
      setError('This switch is part of a loop: turning STP off would flood the network.');
      return;
    }
    setError(null);
    stp.setEnabled(on);
  };
  const value = Number(priority);
  const validPriority = /^\d+$/.test(priority) && value <= 65535;
  return (
    <Section title="Spanning Tree (STP)">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          aria-label="Spanning Tree"
          checked={stp.enabled}
          onChange={(e) => toggle(e.target.checked)}
        />
        Spanning Tree
        <code className="text-(--nf-muted)">
          ip link set br0 type bridge stp_state {stp.enabled ? 0 : 1}
        </code>
      </label>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <p className="text-xs text-(--nf-muted)">
        With STP on every switch, you can add redundant cables: the switches elect a root and block
        the extra paths. Ports listen and learn for 30 s before forwarding.
      </p>
      {stp.enabled && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (validPriority) stp.setPriority(value);
            }}
            className="flex items-end gap-2 text-xs"
          >
            <label className="flex flex-col gap-1">
              Bridge priority (lowest wins)
              <input
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                aria-invalid={!validPriority}
                className={`${FIELD} w-24`}
              />
            </label>
            <button type="submit" className={SECONDARY} disabled={!validPriority}>
              Set
            </button>
          </form>
          <p className="text-xs">
            {stp.rootPort === null
              ? 'This switch is the root bridge.'
              : `Root bridge: ${rootDevice?.name ?? stp.rootId}, reached through ${stp.rootPort.name} (path cost ${stp.rootCost}).`}
          </p>
          <table className="w-full text-left text-xs">
            <thead className="text-(--nf-muted)">
              <tr>
                <th className="py-1 font-medium">Port</th>
                <th className="py-1 font-medium">Role</th>
                <th className="py-1 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {bridge.ports
                .filter((p) => p.link)
                .map((p) => (
                  <tr key={p.name} className="border-t border-(--nf-border)">
                    <td className="py-1 font-mono">{p.name}</td>
                    <td className="py-1">{stp.ports.get(p)?.role}</td>
                    <td className="py-1">{stp.stateOf(p)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}
