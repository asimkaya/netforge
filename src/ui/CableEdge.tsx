import { BaseEdge, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import type { TraceEntry } from '../engine/network.ts';
import { protocolOf } from '../engine/packet.ts';
import { PROTOCOL_COLORS } from './theme.ts';

export type CableEdgeType = Edge<
  { up: boolean; packets: TraceEntry[]; labelA: string; labelB: string },
  'cable'
>;

function center(node: ReturnType<typeof useInternalNode>) {
  const { x, y } = node?.internals.positionAbsolute ?? { x: 0, y: 0 };
  return { x: x + (node?.measured.width ?? 0) / 2, y: y + (node?.measured.height ?? 0) / 2 };
}

/** Straight cable between device centers, with packets animated along it. */
export function CableEdge({ id, source, target, data, selected }: EdgeProps<CableEdgeType>) {
  const a = center(useInternalNode(source));
  const b = center(useInternalNode(target));
  const path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const up = data?.up ?? false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Port labels sit 70px from each end, offset to the side of the line.
  const label = (from: { x: number; y: number }, dir: number) => ({
    x: from.x + (dx / len) * 70 * dir - (dy / len) * 10,
    y: from.y + (dy / len) * 70 * dir + (dx / len) * 10,
  });
  const la = label(a, 1);
  const lb = label(b, -1);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? 'var(--nf-accent)' : up ? '#64748b' : '#ef4444',
          strokeWidth: selected ? 3 : 2,
          strokeDasharray: up ? undefined : '6 4',
        }}
      />
      <text
        x={la.x}
        y={la.y}
        className="fill-(--nf-muted) font-mono text-[10px]"
        textAnchor="middle"
      >
        {data?.labelA}
      </text>
      <text
        x={lb.x}
        y={lb.y}
        className="fill-(--nf-muted) font-mono text-[10px]"
        textAnchor="middle"
      >
        {data?.labelB}
      </text>
      {data?.packets.map((p) => {
        const forward = p.from.device === source;
        const motion = forward ? path : `M ${b.x} ${b.y} L ${a.x} ${a.y}`;
        return (
          <g key={p.seq}>
            <circle
              r={7}
              fill={PROTOCOL_COLORS[protocolOf(p.frame)]}
              stroke="#0b1120"
              strokeWidth={2}
            >
              <animateMotion dur="0.6s" path={motion} fill="freeze" />
            </circle>
          </g>
        );
      })}
    </>
  );
}
