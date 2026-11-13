import { useState, type FormEvent } from 'react';
import { formatCidr, formatIp, maskOf, parseIp, type Ip } from '../../engine/addr.ts';
import { dhclient, dhcpRelease } from '../../engine/dhcp.ts';
import type { Device } from '../../engine/device.ts';
import { hasCarrier, type Port } from '../../engine/port.ts';

export const FIELD = 'rounded border border-(--nf-border) bg-(--nf-bg) px-2 py-1 font-mono text-xs';
export const PRIMARY =
  'rounded bg-(--nf-accent) px-3 py-1 text-xs font-semibold text-slate-950 hover:opacity-90 disabled:opacity-50';
export const SECONDARY =
  'rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent)';
const DEFAULT_ROUTE = { ip: 0, prefix: 0 };

/** "Obtain an address automatically": runs dhclient on the first interface and shows its log. */
function DhcpBox({ device }: { device: Device }) {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ip = device.ip;
  const port = ip?.ports[0];
  if (!ip || !port) return null;
  const lease = ip.dhcpLeases.get(port.name);
  const start = () => {
    const lines: string[] = [];
    setLog([]);
    setBusy(true);
    const result = dhclient(device, port, {
      out: (line) => {
        lines.push(line);
        setLog([...lines]);
      },
      exit: () => setBusy(false),
    });
    if (typeof result === 'string') {
      setLog([result]);
      setBusy(false);
    }
  };
  return (
    <section className="space-y-2 rounded-lg border border-(--nf-border) p-3 text-xs">
      <h3 className="text-sm font-semibold">Automatic (DHCP)</h3>
      {lease && (
        <p>
          Got <span className="font-mono">{formatCidr(lease.addr)}</span> from DHCP server{' '}
          <span className="font-mono">{formatIp(lease.server)}</span>.
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={start} disabled={busy} className={PRIMARY}>
          {busy ? 'Asking…' : 'Get an address automatically'}
        </button>
        {lease && (
          <button
            type="button"
            onClick={() => dhcpRelease(device, port, { out: (line) => setLog([line]) })}
            className={SECONDARY}
          >
            Release
          </button>
        )}
      </div>
      {log.length > 0 && (
        <pre
          className="rounded bg-[#05080f] p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-300"
          aria-label="DHCP log"
        >
          {log.join('\n')}
        </pre>
      )}
      <p className="text-(--nf-muted)">
        Same as the terminal command{' '}
        <code className="font-mono text-emerald-300">dhclient {port.name}</code>
      </p>
    </section>
  );
}

/** Default gateway and name servers, the other half of a host's IP settings. */
function GatewayDns({ device }: { device: Device }) {
  const ip = device.ip;
  const gateway = ip?.staticRoutes.find((r) => r.dst.prefix === 0)?.via ?? null;
  // Fields follow the live settings (e.g. after DHCP) until the user starts typing.
  const [typedGw, setGw] = useState<string | null>(null);
  const [typedDns, setDns] = useState<string | null>(null);
  const gw = typedGw ?? (gateway === null ? '' : formatIp(gateway));
  const dns = typedDns ?? (ip?.dns ?? []).map(formatIp).join(' ');
  const [message, setMessage] = useState<string | null>(null);
  if (!ip) return null;

  const saveGateway = (e: FormEvent) => {
    e.preventDefault();
    const text = gw.trim();
    if (text === '') {
      ip.removeRoute(DEFAULT_ROUTE);
      setGw(null);
      setMessage('Default gateway removed.');
      return;
    }
    const via = parseIp(text);
    if (via === null) {
      setMessage('Enter the gateway as an IPv4 address, like 192.168.1.1.');
      return;
    }
    const old = ip.staticRoutes.find((r) => r.dst.prefix === 0);
    if (old) ip.removeRoute(DEFAULT_ROUTE);
    const error = ip.addRoute(DEFAULT_ROUTE, via, null);
    if (error && old) ip.addRoute(DEFAULT_ROUTE, old.via, old.dev);
    if (!error) setGw(null);
    setMessage(
      error === 'Error: Nexthop has invalid gateway.'
        ? 'The gateway must be in the same network as one of your addresses.'
        : (error ?? 'Default gateway saved.'),
    );
  };

  const saveDns = (e: FormEvent) => {
    e.preventDefault();
    const words = dns.split(/[\s,]+/).filter(Boolean);
    const servers = words.map((w) => parseIp(w));
    if (servers.some((s) => s === null)) {
      setMessage('Enter DNS servers as IPv4 addresses, separated by spaces.');
      return;
    }
    ip.setDns(servers.filter((s): s is Ip => s !== null));
    setDns(null);
    setMessage('DNS servers saved.');
  };

  return (
    <section className="space-y-2 rounded-lg border border-(--nf-border) p-3 text-xs">
      <h3 className="text-sm font-semibold">Gateway and DNS</h3>
      <form onSubmit={saveGateway} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          Default gateway
          <input
            value={gw}
            onChange={(e) => setGw(e.target.value)}
            placeholder="192.168.1.1"
            className={`${FIELD} w-36`}
          />
        </label>
        <button type="submit" className={SECONDARY}>
          Save gateway
        </button>
        <code className="text-(--nf-muted)">ip route add default via {gw || 'GATEWAY'}</code>
      </form>
      <form onSubmit={saveDns} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          DNS servers
          <input
            value={dns}
            onChange={(e) => setDns(e.target.value)}
            placeholder="192.168.1.1"
            className={`${FIELD} w-36`}
          />
        </label>
        <button type="submit" className={SECONDARY}>
          Save DNS
        </button>
        <code className="text-(--nf-muted)">
          resolvectl dns {ip.ports[0]?.name ?? 'eth0'} {dns || 'SERVER'}
        </code>
      </form>
      {message && (
        <p role="status" className="text-(--nf-muted)">
          {message}
        </p>
      )}
    </section>
  );
}

const PREFIXES = [8, 16, 20, 24, 25, 26, 27, 28, 29, 30, 32];

/** Addresses of one interface: list, remove, add. Also used by the Config tab of routers. */
export function PortForm({ device, port }: { device: Device; port: Port }) {
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
      <DhcpBox device={device} />
      {ports.map((port) => (
        <PortForm key={port.name} device={device} port={port} />
      ))}
      <GatewayDns device={device} />
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
