import { useState } from 'react';
import { formatCidr, formatIp } from '../../engine/addr.ts';
import { BIRD_CONF, DEFAULT_COST, parseBirdConf } from '../../engine/bird.ts';
import type { Device } from '../../engine/device.ts';
import { FIELD, PRIMARY, SECONDARY } from '../apps/IpConfig.tsx';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

function birdConf(interfaces: { name: string; cost: number }[]): string {
  const lines = interfaces.map((i) => `\t\tinterface "${i.name}" {\n\t\t\tcost ${i.cost};\n\t\t};`);
  return [
    '# Written by NetForge (Config tab). Start BIRD with `bird`.',
    'protocol device {',
    '}',
    '',
    'protocol kernel {',
    '\tipv4 {',
    '\t\texport all;',
    '\t};',
    '}',
    '',
    'protocol ospf v2 {',
    '\tarea 0 {',
    ...lines,
    '\t};',
    '}',
    '',
  ].join('\n');
}

/** OSPF with BIRD: pick interfaces and costs, start the daemon, see neighbors and routes. */
export function OspfSection({ device }: { device: Device }) {
  useLab();
  const ip = device.ip;
  const fs = device.fs;
  const ports = ip?.ports.filter((p) => !p.parent || ip.addrsOn(p).length > 0) ?? [];
  const parsed = parseBirdConf(fs?.read(BIRD_CONF) ?? '');
  const config = device.bird?.config ?? (typeof parsed === 'string' ? null : parsed);
  const initial = Object.fromEntries(
    ports.map((p) => {
      const match = config?.ospf?.interfaces.find((i) =>
        new RegExp(`^${i.pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`).test(p.name),
      );
      return [p.name, match ? String(match.cost) : ''];
    }),
  );
  const [costs, setCosts] = useState<Record<string, string>>(initial);
  const [message, setMessage] = useState<string | null>(null);
  if (!ip || !fs || !ip.forwarding || device.spec.id === 'internet') return null;
  const bird = device.bird;

  const chosen = ports
    .filter((p) => costs[p.name] !== '' && costs[p.name] !== undefined)
    .map((p) => ({ name: p.name, cost: Number(costs[p.name]) }));
  const valid = chosen.every((c) => Number.isInteger(c.cost) && c.cost >= 1 && c.cost <= 65535);

  const apply = () => {
    fs.write(BIRD_CONF, birdConf(chosen));
    const args = bird?.args ?? [];
    device.stopBird();
    const error = device.startBird(args);
    setMessage(
      error ??
        `BIRD running with OSPF on ${chosen.map((c) => c.name).join(', ') || 'no interfaces'}.`,
    );
  };

  return (
    <Section title="Dynamic routing (OSPF)">
      <p className="text-xs text-(--nf-muted)">
        Routers running OSPF tell each other which networks they reach and pick the cheapest paths.
        Tick the ports that face other routers or networks to announce; lower cost wins.
      </p>
      <ul className="space-y-1 text-xs">
        {ports.map((p) => {
          const on = costs[p.name] !== '' && costs[p.name] !== undefined;
          return (
            <li key={p.name} className="flex items-center gap-2">
              <label className="flex w-24 items-center gap-2">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setCosts({ ...costs, [p.name]: e.target.checked ? String(DEFAULT_COST) : '' })
                  }
                />
                <span className="font-mono">{p.name}</span>
              </label>
              {on && (
                <label className="flex items-center gap-1">
                  cost
                  <input
                    value={costs[p.name]}
                    onChange={(e) => setCosts({ ...costs, [p.name]: e.target.value })}
                    aria-label={`${p.name} OSPF cost`}
                    className={`${FIELD} w-16`}
                  />
                </label>
              )}
              <span className="text-(--nf-muted)">
                {ip.addrsOn(p).map(formatCidr).join(', ') || 'no address'}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} disabled={!valid} onClick={apply}>
          {bird ? 'Save and restart BIRD' : 'Start OSPF (bird)'}
        </button>
        {bird && (
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              device.stopBird();
              setMessage('BIRD stopped.');
            }}
          >
            Stop
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="text-xs text-(--nf-muted)">
          {message}
        </p>
      )}
      {bird && (
        <div className="space-y-1 text-xs">
          <h4 className="font-semibold">Neighbors</h4>
          {bird.neighbors.length === 0 ? (
            <p className="text-(--nf-muted)">None yet. Start OSPF on the router next door too.</p>
          ) : (
            <ul aria-label="OSPF neighbors" className="font-mono">
              {bird.neighbors.map((n) => (
                <li key={`${n.port.name}/${n.routerId}`}>
                  {formatIp(n.routerId)} on {n.port.name} · {n.full ? 'Full' : 'Init'}
                </li>
              ))}
            </ul>
          )}
          <h4 className="font-semibold">Learned routes</h4>
          {bird.routes.length === 0 ? (
            <p className="text-(--nf-muted)">None yet.</p>
          ) : (
            <ul aria-label="OSPF routes" className="font-mono">
              {bird.routes.map((r) => (
                <li key={formatCidr(r.dst)}>
                  {formatCidr(r.dst)} via {formatIp(r.via)} ({r.dev.name}), cost {r.cost}
                </li>
              ))}
            </ul>
          )}
          <p className="text-(--nf-muted)">
            In the CLI: <code>birdc show ospf neighbors</code>, <code>birdc show route</code>,{' '}
            <code>ip route</code>.
          </p>
        </div>
      )}
    </Section>
  );
}
