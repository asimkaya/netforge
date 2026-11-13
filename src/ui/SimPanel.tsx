import { useEffect, useState } from 'react';
import { formatIp } from '../engine/addr.ts';
import type { Network, TraceEntry } from '../engine/network.ts';
import { describeFrame, protocolOf, type EthernetFrame } from '../engine/packet.ts';
import { stepToNextFrame } from './clock.ts';
import { useLab } from './lab.ts';
import { PROTOCOL_COLORS } from './theme.ts';

const PLAY_INTERVAL_MS = 700;

const button =
  'rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent) disabled:opacity-40 disabled:hover:border-(--nf-border)';

type Field = [string, string];

/** Header fields per layer, like a packet analyzer. */
function layers(frame: EthernetFrame): { name: string; fields: Field[] }[] {
  const p = frame.payload;
  const ethernet = {
    name: 'Ethernet II',
    fields: [
      ['Destination', frame.dst],
      ['Source', frame.src],
      ['Type', p.kind === 'arp' ? 'ARP (0x0806)' : 'IPv4 (0x0800)'],
    ] satisfies Field[],
  };
  if (p.kind === 'arp') {
    return [
      ethernet,
      {
        name: 'Address Resolution Protocol',
        fields: [
          ['Opcode', p.op === 'request' ? 'request (1)' : 'reply (2)'],
          ['Sender MAC', p.senderMac],
          ['Sender IP', formatIp(p.senderIp)],
          ['Target MAC', p.targetMac],
          ['Target IP', formatIp(p.targetIp)],
        ],
      },
    ];
  }
  const icmp = p.payload;
  return [
    ethernet,
    {
      name: 'Internet Protocol version 4',
      fields: [
        ['Source', formatIp(p.src)],
        ['Destination', formatIp(p.dst)],
        ['Time to live', String(p.ttl)],
        ['Protocol', 'ICMP (1)'],
      ],
    },
    {
      name: 'Internet Control Message Protocol',
      fields: [
        ['Type', icmp.type === 'echo-request' ? '8 (Echo request)' : '0 (Echo reply)'],
        ['Identifier', String(icmp.id)],
        ['Sequence', String(icmp.seq)],
      ],
    },
  ];
}

function deviceName(net: Network, id: string): string {
  return net.devices.get(id)?.name ?? '(removed)';
}

function Details({ entry }: { entry: TraceEntry }) {
  return (
    <div className="space-y-2 text-xs">
      {layers(entry.frame).map((layer) => (
        <section key={layer.name}>
          <h4 className="font-semibold">{layer.name}</h4>
          <dl className="grid grid-cols-[8rem_1fr] font-mono text-(--nf-muted)">
            {layer.fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="text-(--nf-text)">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Event list and controls for stepping through the simulation frame by frame. */
export function SimPanel() {
  const { net } = useLab();
  const [playing, setPlaying] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const pending = net.scheduler.pending > 0;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (!stepToNextFrame(net)) setPlaying(false);
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, net]);

  const entries = net.trace;
  const shown = entries.find((e) => e.seq === chosen) ?? entries.at(-1);

  return (
    <section
      className="flex h-56 shrink-0 border-t border-(--nf-border) bg-(--nf-surface)"
      aria-label="Simulation events"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-(--nf-border) px-3 py-1.5">
          <button
            type="button"
            className={button}
            onClick={() => setPlaying(!playing)}
            disabled={!pending && !playing}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => stepToNextFrame(net)}
            disabled={!pending || playing}
          >
            Step
          </button>
          <button type="button" className={button} onClick={() => net.clearTrace()}>
            Clear list
          </button>
          <span className="ml-2 text-xs text-(--nf-muted)">
            Time {net.scheduler.now.toFixed(2)} ms ·{' '}
            {pending ? 'events waiting' : 'nothing to do: run a command, e.g. ping'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-(--nf-surface) text-(--nf-muted)">
              <tr>
                <th className="px-3 py-1 font-medium">Time (ms)</th>
                <th className="px-3 py-1 font-medium">From → To</th>
                <th className="px-3 py-1 font-medium">Info</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {entries.map((e) => (
                <tr
                  key={e.seq}
                  onClick={() => setChosen(e.seq)}
                  className={`cursor-pointer hover:bg-(--nf-border) ${e === shown ? 'bg-(--nf-border)' : ''}`}
                  aria-selected={e === shown}
                >
                  <td className="px-3 py-0.5">{e.time.toFixed(2)}</td>
                  <td className="px-3 py-0.5 whitespace-nowrap">
                    {deviceName(net, e.from.device)} → {deviceName(net, e.to.device)}
                  </td>
                  <td className="px-3 py-0.5">
                    <span
                      className="mr-2 inline-block h-2 w-2 rounded-full"
                      style={{ background: PROTOCOL_COLORS[protocolOf(e.frame)] }}
                      aria-hidden
                    />
                    {describeFrame(e.frame)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-(--nf-border) p-3">
        {shown ? (
          <Details entry={shown} />
        ) : (
          <p className="text-xs text-(--nf-muted)">
            Frames appear here one hop at a time. Open a terminal, run a ping, then press Step.
          </p>
        )}
      </aside>
    </section>
  );
}
