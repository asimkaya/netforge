import { useState, type FormEvent, type ReactNode } from 'react';
import { formatCidr, formatIp, networkOf, parseCidr, parseIp } from '../../engine/addr.ts';
import type { Device } from '../../engine/device.ts';
import { FIELD, PRIMARY, SECONDARY } from '../apps/IpConfig.tsx';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** ip_forward, the routing table and a form to add static routes. */
export function RoutingSection({ device }: { device: Device }) {
  const ip = device.ip;
  const [dst, setDst] = useState('');
  const [via, setVia] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  if (!ip) return null;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const target = dst.trim() === 'default' ? { ip: 0, prefix: 0 } : parseCidr(dst.trim());
    const gateway = parseIp(via.trim());
    if (!target) {
      setMessage('Destination: a network like 10.0.2.0/24, or "default".');
      return;
    }
    if (gateway === null) {
      setMessage('Gateway: the IPv4 address of the next router, like 10.0.1.1.');
      return;
    }
    const error = ip.addRoute(target, gateway, null);
    setMessage(
      error === 'Error: Nexthop has invalid gateway.'
        ? 'The gateway must be in the same network as one of this device’s addresses.'
        : error === 'RTNETLINK answers: File exists'
          ? 'There is already a route to that destination.'
          : (error ?? 'Route added.'),
    );
    if (!error) {
      setDst('');
      setVia('');
    }
  };

  const kernel = ip.routes().filter((r) => r.proto === 'kernel');
  return (
    <Section title="Routing">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={ip.forwarding}
          onChange={(e) => ip.setForwarding(e.target.checked)}
        />
        Forward packets between networks (act as a router)
        <code className="text-(--nf-muted)">
          sysctl -w net.ipv4.ip_forward={ip.forwarding ? 1 : 0}
        </code>
      </label>
      <table className="w-full text-left text-xs">
        <thead className="text-(--nf-muted)">
          <tr>
            <th className="py-1 font-medium">Destination</th>
            <th className="py-1 font-medium">Gateway</th>
            <th className="py-1 font-medium">Interface</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody className="font-mono">
          {kernel.map((r) => (
            <tr
              key={`k${formatCidr(r.dst)}${r.port.name}`}
              className="border-t border-(--nf-border)"
            >
              <td className="py-1">{formatCidr(r.dst)}</td>
              <td className="py-1 text-(--nf-muted)">directly connected</td>
              <td className="py-1">{r.port.name}</td>
              <td />
            </tr>
          ))}
          {ip.staticRoutes.map((r) => (
            <tr key={`s${formatCidr(r.dst)}`} className="border-t border-(--nf-border)">
              <td className="py-1">{r.dst.prefix === 0 ? 'default' : formatCidr(r.dst)}</td>
              <td className="py-1">{r.via === null ? '—' : formatIp(r.via)}</td>
              <td className="py-1">{r.dev.name}</td>
              <td className="py-1 text-right">
                <button
                  type="button"
                  onClick={() => ip.removeRoute(r.dst)}
                  className="rounded border border-(--nf-border) px-1.5 hover:border-red-500 hover:text-red-400"
                  aria-label={`Remove the route to ${r.dst.prefix === 0 ? 'default' : formatCidr(r.dst)}`}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          Destination
          <input
            value={dst}
            onChange={(e) => setDst(e.target.value)}
            placeholder="10.0.2.0/24"
            className={`${FIELD} w-32`}
          />
        </label>
        <label className="flex flex-col gap-1">
          Gateway
          <input
            value={via}
            onChange={(e) => setVia(e.target.value)}
            placeholder="10.0.1.1"
            className={`${FIELD} w-28`}
          />
        </label>
        <button type="submit" className={SECONDARY}>
          Add route
        </button>
        <code className="text-(--nf-muted)">
          ip route add {dst || 'DEST'} via {via || 'GATEWAY'}
        </code>
      </form>
      {message && (
        <p role="status" className="text-xs text-(--nf-muted)">
          {message}
        </p>
      )}
    </Section>
  );
}

/** A suggested DHCP range: .100 to .199 of the device's first subnet. */
function suggestRange(device: Device): [string, string] {
  const first = device.ip?.allAddrs()[0];
  if (!first || first.prefix > 24) return ['', ''];
  const base = networkOf(first);
  return [formatIp(base + 100), formatIp(base + 199)];
}

/** Starts, shows and stops dnsmasq (DHCP and DNS server) without the command line. */
export function ServicesSection({ device }: { device: Device }) {
  // Until the user types, the range follows the device's current address.
  const [suggestedStart, suggestedEnd] = suggestRange(device);
  const [typedStart, setStart] = useState<string | null>(null);
  const [typedEnd, setEnd] = useState<string | null>(null);
  const start = typedStart ?? suggestedStart;
  const end = typedEnd ?? suggestedEnd;
  const [records, setRecords] = useState('');
  const [log, setLog] = useState<string[]>([]);
  if (!device.ip) return null;
  const server = device.dnsmasq;

  const args = () => {
    const list = start || end ? [`--dhcp-range=${start.trim()},${end.trim()}`] : [];
    for (const line of records.split('\n')) {
      const [name, ip] = line.trim().split(/\s+/);
      if (name && ip) list.push(`--address=/${name}/${ip}`);
    }
    return list;
  };

  const startServer = (e: FormEvent) => {
    e.preventDefault();
    const result = device.startDnsmasq(args());
    setLog(typeof result === 'string' ? [result] : result);
  };

  return (
    <Section title="DHCP and DNS server (dnsmasq)">
      {server ? (
        <div className="space-y-2 text-xs">
          <p>
            Running:{' '}
            <code className="font-mono text-emerald-300">dnsmasq {server.args.join(' ')}</code>
          </p>
          <table className="w-full text-left">
            <thead className="text-(--nf-muted)">
              <tr>
                <th className="py-1 font-medium">Client</th>
                <th className="py-1 font-medium">Address</th>
                <th className="py-1 font-medium">MAC address</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {server.activeLeases().map((l) => (
                <tr key={l.mac} className="border-t border-(--nf-border)">
                  <td className="py-1">{l.hostname ?? '—'}</td>
                  <td className="py-1">{formatIp(l.ip)}</td>
                  <td className="py-1 text-(--nf-muted)">{l.mac}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {server.activeLeases().length === 0 && (
            <p className="text-(--nf-muted)">No leases yet. Run dhclient on a client.</p>
          )}
          <button type="button" onClick={() => device.stopDnsmasq()} className={SECONDARY}>
            Stop server
          </button>
        </div>
      ) : (
        <form onSubmit={startServer} className="space-y-2 text-xs">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              First address to hand out
              <input
                value={start}
                onChange={(e) => setStart(e.target.value)}
                placeholder="192.168.1.100"
                className={`${FIELD} w-32`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Last address
              <input
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                placeholder="192.168.1.199"
                className={`${FIELD} w-32`}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            DNS names, one per line: name address
            <textarea
              value={records}
              onChange={(e) => setRecords(e.target.value)}
              placeholder="web.lab 10.0.2.10"
              rows={2}
              className={`${FIELD} w-full`}
            />
          </label>
          <button type="submit" className={PRIMARY}>
            Start server
          </button>
          <p className="text-(--nf-muted)">
            Same as <code className="font-mono text-emerald-300">dnsmasq {args().join(' ')}</code>
          </p>
        </form>
      )}
      {log.length > 0 && (
        <pre className="rounded bg-[#05080f] p-2 font-mono text-[11px] whitespace-pre-wrap text-slate-300">
          {log.join('\n')}
        </pre>
      )}
    </Section>
  );
}

/** Starts and stops httpd, the web server that serves the device's files. */
export function WebServerSection({ device }: { device: Device }) {
  const [error, setError] = useState<string | null>(null);
  if (!device.fs) return null;
  const server = device.httpd;
  return (
    <Section title="Web server (httpd)">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {server ? (
          <>
            <span>
              Serving <code className="font-mono">{server.config.home}</code> on port{' '}
              {server.config.port}.
            </span>
            <button type="button" onClick={() => device.stopHttpd()} className={SECONDARY}>
              Stop web server
            </button>
          </>
        ) : (
          <>
            <span className="text-(--nf-muted)">Stopped.</span>
            <button
              type="button"
              onClick={() => setError(device.startHttpd([]))}
              className={PRIMARY}
            >
              Start web server
            </button>
          </>
        )}
        <code className="text-(--nf-muted)">
          {server ? 'killall httpd' : 'httpd -p 80 -h /var/www/html'}
        </code>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </Section>
  );
}
