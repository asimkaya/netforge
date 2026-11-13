import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import type { TraceEntry } from '../engine/network.ts';
import { protocolOf } from '../engine/packet.ts';
import type { Medium } from '../engine/port.ts';
import { PROTOCOL_COLORS } from './theme.ts';

export type CableEdgeType = Edge<{ up: boolean; medium: Medium; packets: TraceEntry[] }, 'cable'>;

const MEDIUM_COLOR: Record<Medium, string> = {
  copper: '#64748b',
  fiber: '#f59e0b',
  wireless: '#38bdf8',
};

/** A straight cable from port to port, with packets animated along it. */
export function CableEdge(props: EdgeProps<CableEdgeType>) {
  const { id, source, data, selected } = props;
  const { sourceX: x1, sourceY: y1, targetX: x2, targetY: y2 } = props;
  // Straight cables read best on a busy canvas, like a patch diagram.
  const path = `M ${x1} ${y1} L ${x2} ${y2}`;
  const reverse = `M ${x2} ${y2} L ${x1} ${y1}`;
  const up = data?.up ?? false;
  const color = up ? MEDIUM_COLOR[data?.medium ?? 'copper'] : '#ef4444';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? 'var(--nf-accent)' : color,
          strokeWidth: selected ? 3.5 : 2.5,
          strokeDasharray: !up ? '6 4' : data?.medium === 'wireless' ? '2 6' : undefined,
        }}
      />
      {data?.packets.map((p) => (
        <circle
          key={p.seq}
          r={7}
          fill={PROTOCOL_COLORS[protocolOf(p.frame)]}
          stroke="#0b1120"
          strokeWidth={2}
        >
          <animateMotion
            dur="0.6s"
            path={p.from.device === source ? path : reverse}
            fill="freeze"
          />
        </circle>
      ))}
    </>
  );
}
