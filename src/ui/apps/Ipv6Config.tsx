import { useState, type FormEvent } from 'react';
import { formatCidr6, formatIp6, networkOf6, parseCidr6, type Cidr6 } from '../../engine/addr6.ts';
import type { Device } from '../../engine/device.ts';
import { RADVD_CONF } from '../../engine/ip6.ts';
import { hasCarrier, type Port } from '../../engine/port.ts';
import { useLab } from '../lab.ts';
import { FIELD, PRIMARY, SECONDARY } from './IpConfig.tsx';

const ORIGIN = { link: 'link-local', static: 'manual', ra: 'automatic (SLAAC)' } as const;

/** IPv6 addresses of one interface, with a field to add a static one. */
function PortV6({ device, port }: { device: Device; port: Port }) {
  const v6 = device.ip?.v6;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!v6) return null;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const cidr = parseCidr6(text.includes('/') ? text : `${text}/64`);
    if (!cidr) {
      setError('Not an IPv6 address, e.g. 2001:db8:1::10/64');
      return;
    }
    const failed = v6.addAddress(port, cidr);
    setError(failed);
    if (!failed) setText('');
  };
  return (
    <div className="space-y-1">
      <ul className="font-mono">
        {v6.addrsOn(port).map((a) => (
          <li key={formatCidr6(a.cidr)} className="flex items-center gap-2">
            {port.name} {formatCidr6(a.cidr)}
            <span className="font-sans text-(--nf-muted)">{ORIGIN[a.origin]}</span>
            {a.origin === 'static' && (
              <button
                type="button"
                className={SECONDARY}
                onClick={() => v6.removeAddress(port, a.cidr)}
                aria-label={`Remove ${formatCidr6(a.cidr)}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="2001:db8:1::10/64"
          aria-label={`IPv6 address for ${port.name}`}
          className={`${FIELD} w-52`}
        />
        <button type="submit" className={SECONDARY} disabled={!text}>
          Add IPv6 address
        </button>
      </form>
      {error && (
        <p role="alert" className="text-(--nf-bad)">
          {error}
        </p>
      )}
    </div>
  );
}

/** IPv6 on a host: addresses (link-local, manual, autoconfigured) and default routers. */
export function Ipv6Box({ device }: { device: Device }) {
  useLab();
  const v6 = device.ip?.v6;
  if (!v6) return null;
  const routers = v6.routes().filter((r) => r.proto === 'ra' || r.dst.prefix === 0);
  return (
    <section className="space-y-2 text-xs">
      <h3 className="text-sm font-semibold">
        IPv6 (<code>ip -6 addr</code>)
      </h3>
      <p className="text-(--nf-muted)">
        Every interface has a link-local address (fe80::). When a router announces a prefix (radvd),
        the device builds a global address from it by itself.
      </p>
      {v6.ports.map((port) => (
        <PortV6 key={port.name} device={device} port={port} />
      ))}
      <p>
        Default router:{' '}
        <span className="font-mono">
          {routers
            .map((r) => `${r.via === null ? '' : formatIp6(r.via)} (${r.port.name})`)
            .join(', ') || 'none'}
        </span>
      </p>
    </section>
  );
}

/** radvd on a router: announce one /64 prefix per interface so hosts configure themselves. */
export function RadvdSection({ device }: { device: Device }) {
  useLab();
  const v6 = device.ip?.v6;
  const ports = device.ip?.ports.filter((p) => !p.parent || hasCarrier(p)) ?? [];
  const [prefixes, setPrefixes] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ports.map((p) => [
        p.name,
        v6?.radvd?.interfaces.find((i) => i.name === p.name)?.prefixes.map(formatCidr6)[0] ?? '',
      ]),
    ),
  );
  const [message, setMessage] = useState<string | null>(null);
  if (!v6 || !device.fs || !device.ip?.forwarding || device.spec.id === 'internet') return null;
  const fs = device.fs;
  const chosen = Object.entries(prefixes).filter(([, text]) => text.trim() !== '');
  const parsed = chosen.map(([name, text]) => [name, parseCidr6(text.trim())] as const);
  const valid = parsed.every(([, c]) => c !== null && c.prefix === 64);

  const start = () => {
    const conf = parsed
      .map(
        ([name, c]) =>
          `interface ${name} {\n\tAdvSendAdvert on;\n\tprefix ${formatCidr6(c as Cidr6)} {\n\t};\n};`,
      )
      .join('\n');
    fs.write(RADVD_CONF, `${conf}\n`);
    // The router also needs its own address in each announced prefix.
    for (const [name, c] of parsed) {
      const port = device.port(name);
      if (!port || !c) continue;
      const own = v6
        .addrsOn(port)
        .some((a) => a.origin === 'static' && a.cidr.ip >> 64n === c.ip >> 64n);
      if (!own) v6.addAddress(port, { ip: networkOf6(c) | 1n, prefix: 64 });
    }
    device.stopRadvd();
    const error = device.startRadvd([]);
    setMessage(error ?? `radvd announces ${parsed.map(([n]) => n).join(', ')}.`);
  };

  return (
    <section aria-label="IPv6 router advertisements (radvd)" className="space-y-2 text-xs">
      <h3 className="text-sm font-semibold">IPv6 router advertisements (radvd)</h3>
      <p className="text-(--nf-muted)">
        Give a /64 prefix per network; hosts there build their own IPv6 address and use this router
        as gateway. The router takes the ::1 address of each prefix.
      </p>
      {ports.map((p) => (
        <label key={p.name} className="flex items-center gap-2">
          <span className="w-12 font-mono">{p.name}</span>
          <input
            value={prefixes[p.name] ?? ''}
            onChange={(e) => setPrefixes({ ...prefixes, [p.name]: e.target.value })}
            placeholder="2001:db8:1::/64"
            aria-label={`${p.name} IPv6 prefix`}
            className={`${FIELD} w-48`}
          />
        </label>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={!valid || chosen.length === 0}
          onClick={start}
        >
          {v6.radvd ? 'Restart radvd' : 'Start radvd'}
        </button>
        {v6.radvd && (
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              device.stopRadvd();
              setMessage('radvd stopped.');
            }}
          >
            Stop
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="text-(--nf-muted)">
          {message}
        </p>
      )}
    </section>
  );
}
