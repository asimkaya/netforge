import { useState, type ReactNode } from 'react';
import { formatCidr, formatIp } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import { PORT_TYPE_LABEL, hasCarrier, peerOf, type Port } from '../engine/port.ts';
import { SpecArt } from './icons.tsx';
import { cable, openTerminal, removeDevice, useLab } from './lab.ts';

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

function NameField({ device }: { device: Device }) {
  const { net } = useLab();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? device.name;
  const valid = HOSTNAME.test(value);
  const commit = () => {
    if (valid && value !== device.name) net.rename(device, value);
    setDraft(null);
  };
  return (
    <label className="block text-xs text-(--nf-muted)">
      Name
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-invalid={!valid}
        className={`mt-1 w-full rounded border bg-(--nf-bg) px-2 py-1 font-mono text-sm text-(--nf-text) ${
          valid ? 'border-(--nf-border)' : 'border-red-500'
        }`}
      />
      {!valid && <span className="text-red-400">Letters, digits and dashes only.</span>}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Keyboard-friendly way to cable a free port: pick the other end from a list. */
function ConnectSelect({ port }: { port: Port }) {
  const { net } = useLab();
  const options = [...net.devices.values()]
    .filter((d) => d !== port.device)
    .flatMap((d) => net.freePortsFor(d, port));
  if (options.length === 0) return null;
  return (
    <select
      aria-label={`Connect ${port.name} to`}
      value=""
      onChange={(e) => {
        const [device, name] = e.target.value.split('/');
        const target = device && name ? net.devices.get(device)?.port(name) : undefined;
        if (target) cable(port, target);
      }}
      className="mt-1 w-full rounded border border-(--nf-border) bg-(--nf-bg) px-1 py-0.5 text-xs"
    >
      <option value="">Connect to…</option>
      {options.map((p) => (
        <option key={`${p.device.id}/${p.name}`} value={`${p.device.id}/${p.name}`}>
          {p.device.name} {p.name}
        </option>
      ))}
    </select>
  );
}

function PortRow({ device, port }: { device: Device; port: Port }) {
  const peer = peerOf(port);
  const up = hasCarrier(port);
  return (
    <li className="rounded border border-(--nf-border) p-2 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${up ? 'bg-emerald-400' : port.link ? 'bg-amber-500' : 'bg-slate-600'}`}
          aria-label={up ? 'link up' : port.link ? 'no carrier' : 'no cable'}
        />
        <span className="font-mono font-semibold">{port.name}</span>
        <span className="truncate text-(--nf-muted)">
          {peer ? `→ ${peer.device.name} ${peer.name}` : PORT_TYPE_LABEL[port.type]}
        </span>
      </div>
      <div className="mt-1 font-mono text-(--nf-muted)">{port.mac}</div>
      {device.ip?.ports.includes(port) &&
        device.ip.addrsOn(port).map((a) => (
          <div key={formatCidr(a)} className="font-mono">
            {formatCidr(a)}
          </div>
        ))}
      {!peer && <ConnectSelect port={port} />}
    </li>
  );
}

/** Right-hand panel describing the selected device. */
export function Inspector() {
  const { net, selected } = useLab();
  const device = selected ? net.devices.get(selected) : undefined;
  if (!device) {
    return (
      <p className="p-4 text-sm text-(--nf-muted)">
        Select a device to see its details. Double-click a device to open its terminal.
      </p>
    );
  }
  const fdb = device.bridge?.fdb() ?? [];
  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="flex items-center gap-2">
        <SpecArt spec={device.spec.id} className="h-7 w-8" />
        <span className="font-semibold">{device.spec.label}</span>
      </div>
      <NameField key={device.id} device={device} />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => openTerminal(device.id)}
          className="flex-1 rounded bg-(--nf-accent) px-3 py-1.5 text-xs font-semibold text-slate-950 hover:opacity-90"
        >
          Open terminal
        </button>
        <button
          type="button"
          onClick={() => removeDevice(device.id)}
          className="rounded border border-(--nf-border) px-3 py-1.5 text-xs hover:border-red-500 hover:text-red-400"
        >
          Delete
        </button>
      </div>
      <Section title="Ports">
        <ul className="space-y-2">
          {device.ports.map((port) => (
            <PortRow key={port.name} device={device} port={port} />
          ))}
        </ul>
      </Section>
      {device.ip && (
        <Section title="ARP table (ip neigh)">
          {device.ip.neighbors.size === 0 ? (
            <p className="text-xs text-(--nf-muted)">Empty.</p>
          ) : (
            <ul className="font-mono text-xs">
              {[...device.ip.neighbors.values()].map((n) => (
                <li key={n.ip}>
                  {formatIp(n.ip)} {n.mac ?? ''}{' '}
                  <span className="text-(--nf-muted)">{n.state}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {device.bridge && (
        <Section title="MAC table (bridge fdb)">
          {fdb.length === 0 ? (
            <p className="text-xs text-(--nf-muted)">Nothing learned yet.</p>
          ) : (
            <ul className="font-mono text-xs">
              {fdb.map((e) => (
                <li key={e.mac}>
                  {e.mac} <span className="text-(--nf-muted)">{e.port.name}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
