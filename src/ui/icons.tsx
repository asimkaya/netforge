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

export function RouterArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect x="4" y="16" width="40" height="14" rx="3" fill="#1e293b" />
      <path d="M12 16V8M36 16V8" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={9 + i * 8} y={21} width="5" height="5" rx="0.8" fill="#05080f" />
      ))}
      <circle cx="40" cy="23" r="1.2" fill="#22c55e" />
    </svg>
  );
}

export function ServerArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect x="12" y="2" width="24" height="36" rx="3" fill="#1e293b" />
      {[8, 16, 24].map((y) => (
        <g key={y}>
          <rect x="15" y={y} width="18" height="5" rx="1" fill="#0b1f36" />
          <circle cx="30" cy={y + 2.5} r="1" fill="#22c55e" />
        </g>
      ))}
    </svg>
  );
}

export function CloudArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <path
        d="M14 30h22a8 8 0 0 0 0-16 11 11 0 0 0-21-2 8 8 0 0 0-1 18z"
        fill="#1e293b"
        stroke="#38bdf8"
        strokeWidth="1.5"
      />
      <path d="M18 22h12M24 16v12" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SpecArt({ spec, className }: { spec: SpecId; className?: string | undefined }) {
  if (spec === 'pc') return <PcArt className={className} />;
  if (spec === 'router') return <RouterArt className={className} />;
  if (spec === 'server') return <ServerArt className={className} />;
  if (spec === 'internet') return <CloudArt className={className} />;
  return <SwitchArt className={className} />;
}
