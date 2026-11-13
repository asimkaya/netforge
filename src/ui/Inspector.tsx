import { useState, type ReactNode } from 'react';
import { formatCidr, formatIp } from '../engine/addr.ts';
import { hasCarrier, peerOf, type Device } from '../engine/device.ts';
import { Host } from '../engine/host.ts';
import { Switch } from '../engine/switch.ts';
import { DeviceIcon } from './icons.tsx';
import { openTerminal, removeDevice, useLab } from './lab.ts';

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
  const cabled = device.ports.filter((p) => p.link || device instanceof Host);
  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="flex items-center gap-2">
        <DeviceIcon kind={device.kind} className="h-6 w-6 text-(--nf-accent)" />
        <span className="font-semibold">{device.kind === 'host' ? 'PC' : 'Switch'}</span>
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
        {cabled.length === 0 && <p className="text-xs text-(--nf-muted)">No cables connected.</p>}
        <ul className="space-y-2">
          {cabled.map((port) => {
            const peer = peerOf(port);
            const up = hasCarrier(port);
            return (
              <li key={port.name} className="rounded border border-(--nf-border) p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${up ? 'bg-emerald-400' : 'bg-red-500'}`}
                    aria-label={up ? 'link up' : 'link down'}
                  />
                  <span className="font-mono font-semibold">{port.name}</span>
                  <span className="text-(--nf-muted)">
                    {peer ? `→ ${peer.device.name} ${peer.name}` : 'not connected'}
                  </span>
                </div>
                <div className="mt-1 font-mono text-(--nf-muted)">{port.mac}</div>
                {device instanceof Host &&
                  device.addrsOn(port).map((a) => (
                    <div key={formatCidr(a)} className="font-mono">
                      {formatCidr(a)}
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      </Section>
      {device instanceof Host && (
        <Section title="ARP table (ip neigh)">
          {device.neighbors.size === 0 ? (
            <p className="text-xs text-(--nf-muted)">Empty.</p>
          ) : (
            <ul className="font-mono text-xs">
              {[...device.neighbors.values()].map((n) => (
                <li key={n.ip}>
                  {formatIp(n.ip)} {n.mac ?? ''}{' '}
                  <span className="text-(--nf-muted)">{n.state}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {device instanceof Switch && (
        <Section title="MAC table (bridge fdb)">
          {device.fdb().length === 0 ? (
            <p className="text-xs text-(--nf-muted)">Nothing learned yet.</p>
          ) : (
            <ul className="font-mono text-xs">
              {device.fdb().map((e) => (
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
