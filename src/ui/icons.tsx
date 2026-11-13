import type { SpecId } from '../engine/specs.ts';

/** Small drawings for the palette and the inspector. Canvas faceplates live in DeviceNode.tsx. */
export function PcArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect x="2" y="2" width="36" height="26" rx="3" fill="#1e293b" />
      <rect x="5" y="5" width="30" height="20" rx="1.5" fill="#0f2a44" />
      <path d="M8 10h12M8 14h18M8 18h9" stroke="#38bdf8" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17 28h6l1.5 6h-9z" fill="#334155" />
      <rect x="12" y="34" width="16" height="3" rx="1.5" fill="#334155" />
      <rect x="40" y="10" width="7" height="27" rx="1.5" fill="#1e293b" />
      <circle cx="43.5" cy="14" r="1.2" fill="#22c55e" />
    </svg>
  );
}

export function SwitchArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect x="1" y="12" width="46" height="16" rx="2.5" fill="#1e293b" />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <rect x={4 + i * 7} y={19} width="5" height="5" rx="0.8" fill="#05080f" />
          <circle cx={6.5 + i * 7} cy={16} r="0.9" fill={i < 3 ? '#22c55e' : '#475569'} />
        </g>
      ))}
      <rect
        x="39"
        y="19"
        width="5"
        height="5"
        rx="0.8"
        fill="#05080f"
        stroke="#f59e0b"
        strokeWidth="0.8"
      />
    </svg>
  );
}

export function SpecArt({ spec, className }: { spec: SpecId; className?: string | undefined }) {
  return spec === 'pc' ? <PcArt className={className} /> : <SwitchArt className={className} />;
}
