import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import type { TraceEntry } from '../engine/network.ts';
import { protocolOf } from '../engine/packet.ts';
import type { Medium } from '../engine/port.ts';
import { PROTOCOL_COLORS } from './theme.ts';

export type CableEdgeType = Edge<
  {
    up: boolean;
    medium: Medium;
    packets: TraceEntry[];
    /** VLAN colour of a copper cable whose switch end is an access port. */
    vlanColor: string | null;
  },
  'cable'
>;

const MEDIUM_STYLE: Record<Medium, { color: string; width: number }> = {
  copper: { color: 'var(--nf-cable-copper)', width: 2.5 },
  fiber: { color: 'var(--nf-cable-fiber)', width: 3.5 },
  wireless: { color: 'var(--nf-accent)', width: 1.5 },
};

/** A straight cable from port to port, with packets animated along it. */
export function CableEdge(props: EdgeProps<CableEdgeType>) {
  const { id, source, data, selected } = props;
  const { sourceX: x1, sourceY: y1, targetX: x2, targetY: y2 } = props;
  // Straight cables read best on a busy canvas, like a patch diagram.
  const path = `M ${x1} ${y1} L ${x2} ${y2}`;
  const reverse = `M ${x2} ${y2} L ${x1} ${y1}`;
  const up = data?.up ?? false;
  const medium = data?.medium ?? 'copper';
  const style = MEDIUM_STYLE[medium];
  const color = !up ? 'var(--nf-bad)' : (data?.vlanColor ?? style.color);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? 'var(--nf-accent)' : color,
          strokeWidth: selected ? style.width + 1.5 : style.width,
          strokeDasharray: !up ? '6 4' : medium === 'wireless' ? '4 5' : undefined,
        }}
      />
      {data?.packets.map((p) => (
        <circle
          key={p.seq}
          r={7}
          fill={PROTOCOL_COLORS[protocolOf(p.frame)]}
          stroke="var(--nf-bg)"
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
