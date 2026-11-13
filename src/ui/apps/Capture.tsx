import { useState } from 'react';
import type { Device } from '../../engine/device.ts';
import { describeFrame, protocolOf, type Protocol } from '../../engine/packet.ts';
import { useLab } from '../lab.ts';
import { Details } from '../SimPanel.tsx';
import { PROTOCOL_COLORS } from '../theme.ts';

/** Shows the frames this device sent and received, like a tiny Wireshark. */
export function Capture({ device }: { device: Device }) {
  const { net } = useLab();
  const [filter, setFilter] = useState<Protocol | 'all'>('all');
  const [chosen, setChosen] = useState<number | null>(null);
  const mine = net.trace.filter((t) => t.from.device === device.id || t.to.device === device.id);
  const shown = mine.filter((t) => filter === 'all' || protocolOf(t.frame) === filter);
  const protocols = [...new Set(mine.map((t) => protocolOf(t.frame)))].sort();
  const selected = shown.find((t) => t.seq === chosen) ?? shown.at(-1);
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-(--nf-border) px-2 py-1">
        <label className="flex items-center gap-1">
          Show
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Protocol | 'all')}
            className="rounded border border-(--nf-border) bg-(--nf-bg) px-1"
          >
            <option value="all">all protocols</option>
            {protocols.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <span className="text-(--nf-muted)">
          {shown.length} of {mine.length} frames · same as <code>tcpdump</code>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="p-3 text-(--nf-muted)">No frames yet. Send some traffic, e.g. a ping.</p>
        ) : (
          <table className="w-full text-left font-mono">
            <tbody>
              {shown.map((t) => (
                <tr
                  key={t.seq}
                  onClick={() => setChosen(t.seq)}
                  aria-selected={t === selected}
                  className={`cursor-pointer hover:bg-(--nf-border) ${t === selected ? 'bg-(--nf-border)' : ''}`}
                >
                  <td className="px-2 py-0.5 whitespace-nowrap text-(--nf-muted)">
                    {t.time.toFixed(2)}
                  </td>
                  <td className="px-2 py-0.5">
                    <span
                      className="mr-2 inline-block h-2 w-2 rounded-full"
                      style={{ background: PROTOCOL_COLORS[protocolOf(t.frame)] }}
                      aria-hidden
                    />
                    {t.to.device === device.id ? '←' : '→'} {describeFrame(t.frame)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected && (
        <div className="max-h-48 shrink-0 overflow-y-auto border-t border-(--nf-border) p-2">
          <Details entry={selected} />
        </div>
      )}
    </div>
  );
}
