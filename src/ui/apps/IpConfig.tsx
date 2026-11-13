import { useState, type FormEvent } from 'react';
import { formatCidr, formatIp, maskOf, parseIp } from '../../engine/addr.ts';
import type { Device } from '../../engine/device.ts';
import { hasCarrier, type Port } from '../../engine/port.ts';

const PREFIXES = [8, 16, 20, 24, 25, 26, 27, 28, 29, 30, 32];

function PortForm({ device, port }: { device: Device; port: Port }) {
  const ip = device.ip;
  const [address, setAddress] = useState('');
  const [prefix, setPrefix] = useState(24);
  const [error, setError] = useState<string | null>(null);
  if (!ip) return null;
  const addrs = ip.addrsOn(port);
  const command = `ip addr add ${address || 'ADDRESS'}/${prefix} dev ${port.name}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseIp(address.trim());
    if (parsed === null) {
      setError('Enter an IPv4 address like 192.168.1.10.');
      return;
    }
    const result = ip.addAddress(port, { ip: parsed, prefix });
    setError(result);
    if (!result) setAddress('');
  };

  return (
    <section className="space-y-2 rounded-lg border border-(--nf-border) p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span
          className={`h-2 w-2 rounded-full ${hasCarrier(port) ? 'bg-emerald-400' : 'bg-slate-600'}`}
          aria-hidden
        />
        <span className="font-mono">{port.name}</span>
        <span className="text-xs font-normal text-(--nf-muted)">
          {hasCarrier(port) ? 'connected' : 'no link'}
        </span>
      </h3>
      {addrs.length === 0 ? (
        <p className="text-xs text-(--nf-muted)">No IPv4 address yet.</p>
      ) : (
        <ul className="space-y-1">
          {addrs.map((a) => (
            <li key={formatCidr(a)} className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono">
                {formatCidr(a)}{' '}
                <span className="text-(--nf-muted)">mask {formatIp(maskOf(a.prefix))}</span>
              </span>
              <button
                type="button"
                onClick={() => ip.removeAddress(port, a)}
                className="rounded border border-(--nf-border) px-2 py-0.5 hover:border-red-500 hover:text-red-400"
                aria-label={`Remove ${formatCidr(a)} from ${port.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          IPv4 address
          <input
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setError(null);
            }}
            placeholder="192.168.1.10"
            aria-invalid={error !== null}
            className="w-36 rounded border border-(--nf-border) bg-(--nf-bg) px-2 py-1 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          Prefix (subnet mask)
          <select
            value={prefix}
            onChange={(e) => setPrefix(Number(e.target.value))}
            className="rounded border border-(--nf-border) bg-(--nf-bg) px-1 py-1 font-mono"
          >
            {PREFIXES.map((p) => (
              <option key={p} value={p}>
                /{p} ({formatIp(maskOf(p))})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded bg-(--nf-accent) px-3 py-1 font-semibold text-slate-950 hover:opacity-90"
        >
          Add address
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      <p className="text-xs text-(--nf-muted)">
        Same as the terminal command <code className="font-mono text-emerald-300">{command}</code>
      </p>
    </section>
  );
}

/** Graphical front end for `ip addr`: edits the same configuration as the shell. */
export function IpConfig({ device }: { device: Device }) {
  const ports = device.ip?.ports ?? [];
  const neighbors = [...(device.ip?.neighbors.values() ?? [])];
  return (
    <div className="space-y-3 p-4">
      {ports.map((port) => (
        <PortForm key={port.name} device={device} port={port} />
      ))}
      <section className="space-y-1 text-xs">
        <h3 className="text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
          Known neighbors (ARP table, <code>ip neigh</code>)
        </h3>
        {neighbors.length === 0 ? (
          <p className="text-(--nf-muted)">
            Empty. The PC learns a neighbor's MAC address the first time it talks to it.
          </p>
        ) : (
          <ul className="font-mono">
            {neighbors.map((n) => (
              <li key={n.ip}>
                {formatIp(n.ip)} {n.mac ?? ''} <span className="text-(--nf-muted)">{n.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
