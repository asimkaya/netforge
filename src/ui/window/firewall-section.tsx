import { useState, type FormEvent } from 'react';
import { formatIp } from '../../engine/addr.ts';
import type { Device } from '../../engine/device.ts';
import type { Netfilter } from '../../engine/netfilter.ts';
import { formatRuleset, runNft } from '../../engine/nft.ts';
import { FIELD, PRIMARY, SECONDARY } from '../apps/IpConfig.tsx';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

/** The interface NAT goes out of: the `oifname` of a masquerade rule in table ip nat. */
function natInterface(nf: Netfilter): string | null {
  const chain = nf.tables
    .find((t) => t.name === 'nat')
    ?.chains.find((c) => c.base?.hook === 'postrouting');
  for (const rule of chain?.rules ?? []) {
    const out = rule.matches.find((m) => m.kind === 'oifname');
    if (rule.action.kind === 'masquerade' && out?.kind === 'oifname') return out.name;
  }
  return null;
}

/** Port forwards: `dnat` rules in the nat prerouting chain. */
function forwards(nf: Netfilter) {
  const chain = nf.tables
    .find((t) => t.name === 'nat')
    ?.chains.find((c) => c.base?.hook === 'prerouting');
  return (chain?.rules ?? []).flatMap((rule) => {
    const a = rule.action;
    const port = rule.matches.find((m) => m.kind === 'port');
    if (a.kind !== 'dnat' || port?.kind !== 'port') return [];
    const to = `${formatIp(a.addr)}${a.port === null ? '' : `:${a.port}`}`;
    return [{ handle: rule.handle, proto: port.proto, port: port.ports.join(','), to }];
  });
}

const NAT_TABLE = 'nft add table ip nat';
const POSTROUTING =
  'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }';
const PREROUTING = 'nft add chain ip nat prerouting { type nat hook prerouting priority dstnat ; }';

/** Firewall and NAT with nftables: shortcuts for common setups and the full ruleset. */
export function FirewallSection({ device }: { device: Device }) {
  useLab();
  const nf = device.ip?.nf;
  const wanChoices = device.ip?.ports.map((p) => p.name) ?? [];
  // The default route usually points at the Internet side.
  const [wan, setWan] = useState(device.ip?.routeTo(0)?.port.name ?? wanChoices.at(-1) ?? '');
  const [proto, setProto] = useState<'tcp' | 'udp'>('tcp');
  const [publicPort, setPublicPort] = useState('80');
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!nf || !device.ip?.forwarding) return null;

  /** Runs nft commands (one per line, without the `nft` word) and reports the first error. */
  const apply = (commands: string[], done: string) => {
    for (const command of commands) {
      const error = runNft(nf, command.replace(/^nft /, ''), () => {});
      if (error) {
        setMessage(error);
        return;
      }
    }
    setMessage(done);
  };

  const natOn = natInterface(nf);
  const ruleset = formatRuleset(nf.tables).join('\n');

  const forward = (e: FormEvent) => {
    e.preventDefault();
    if (!natOn) return;
    apply(
      [
        NAT_TABLE,
        PREROUTING,
        `nft add rule ip nat prerouting iifname "${natOn}" ${proto} dport ${publicPort} dnat to ${target}`,
      ],
      `Port ${publicPort} forwarded to ${target}.`,
    );
  };

  return (
    <Section title="Firewall and NAT (nftables)">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        {natOn ? (
          <>
            <span>
              NAT is on: devices behind this router reach other networks through{' '}
              <strong>{natOn}</strong>&apos;s address.
            </span>
            <button
              type="button"
              className={SECONDARY}
              onClick={() => apply(['nft delete chain ip nat postrouting'], 'NAT turned off.')}
            >
              Turn NAT off
            </button>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              Internet side
              <select value={wan} onChange={(e) => setWan(e.target.value)} className={FIELD}>
                {wanChoices.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={PRIMARY}
              onClick={() =>
                apply(
                  [
                    NAT_TABLE,
                    POSTROUTING,
                    `nft add rule ip nat postrouting oifname "${wan}" masquerade`,
                  ],
                  `NAT on through ${wan}.`,
                )
              }
            >
              Share this connection (NAT)
            </button>
          </>
        )}
      </div>
      {natOn && (
        <form onSubmit={forward} className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1">
            Protocol
            <select
              value={proto}
              onChange={(e) => setProto(e.target.value as 'tcp' | 'udp')}
              className={FIELD}
            >
              <option>tcp</option>
              <option>udp</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Public port
            <input
              value={publicPort}
              onChange={(e) => setPublicPort(e.target.value)}
              className={`${FIELD} w-16`}
            />
          </label>
          <label className="flex flex-col gap-1">
            Forward to (IP or IP:port)
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="192.168.1.20"
              className={`${FIELD} w-36`}
            />
          </label>
          <button type="submit" className={PRIMARY} disabled={!target}>
            Forward port
          </button>
        </form>
      )}
      {forwards(nf).length > 0 && (
        <ul className="text-xs" aria-label="Port forwards">
          {forwards(nf).map((f) => (
            <li key={f.handle} className="flex items-center gap-2">
              {f.proto} {f.port} → {f.to}
              <button
                type="button"
                className={SECONDARY}
                onClick={() =>
                  apply([`nft delete rule ip nat prerouting handle ${f.handle}`], 'Removed.')
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="block text-xs text-(--nf-muted)">
        Ruleset (same text as <code>nft list ruleset</code>; edit and apply to replace it)
        <textarea
          value={draft ?? ruleset}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(16, Math.max(4, (draft ?? ruleset).split('\n').length + 1))}
          spellCheck={false}
          placeholder={
            'table ip filter {\n\tchain forward {\n\t\ttype filter hook forward priority filter; policy drop;\n\t\tct state established,related accept\n\t\tiifname "eth0" accept\n\t}\n}'
          }
          className="mt-1 block w-full rounded border border-(--nf-hw-edge) bg-(--nf-term-bg) px-2 py-1 font-mono text-xs text-(--nf-term-text)"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={draft === null}
          onClick={() => {
            const error = runNft(nf, `flush ruleset\n${draft ?? ''}`, () => {});
            setMessage(error ?? 'Ruleset applied.');
            if (!error) setDraft(null);
          }}
        >
          Apply ruleset
        </button>
        {draft !== null && (
          <button type="button" className={SECONDARY} onClick={() => setDraft(null)}>
            Discard changes
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="text-xs text-(--nf-muted)">
          {message}
        </p>
      )}
    </Section>
  );
}
