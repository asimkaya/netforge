import type { SpecId } from '../engine/specs.ts';

/** Small drawings for the palette and the inspector. Canvas faceplates live in DeviceNode.tsx. */
export function PcArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="2"
        y="2"
        width="36"
        height="26"
        rx="3"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <rect x="5" y="5" width="30" height="20" rx="1.5" fill="var(--nf-term-bg)" />
      <path
        d="M8 10h12M8 14h18M8 18h9"
        stroke="var(--nf-ok)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M17 28h6l1.5 6h-9z" fill="var(--nf-hw-edge)" />
      <rect x="12" y="34" width="16" height="3" rx="1.5" fill="var(--nf-hw-edge)" />
      <rect
        x="40"
        y="10"
        width="7"
        height="27"
        rx="1.5"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <circle cx="43.5" cy="14" r="1.2" fill="var(--nf-ok)" />
    </svg>
  );
}

export function SwitchArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="1"
        y="12"
        width="46"
        height="16"
        rx="2.5"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <rect x={4 + i * 7} y={19} width="5" height="5" rx="0.8" fill="var(--nf-socket)" />
          <circle
            cx={6.5 + i * 7}
            cy={16}
            r="0.9"
            fill={i < 3 ? 'var(--nf-ok)' : 'var(--nf-hw-muted)'}
          />
        </g>
      ))}
      <rect
        x="39"
        y="19"
        width="5"
        height="5"
        rx="0.8"
        fill="var(--nf-socket)"
        stroke="var(--nf-cable-fiber)"
        strokeWidth="0.8"
      />
    </svg>
  );
}

export function RouterArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="4"
        y="16"
        width="40"
        height="14"
        rx="3"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <path
        d="M12 16V8M36 16V8"
        stroke="var(--nf-hw-muted)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={9 + i * 8} y={21} width="5" height="5" rx="0.8" fill="var(--nf-socket)" />
      ))}
      <circle cx="40" cy="23" r="1.2" fill="var(--nf-ok)" />
    </svg>
  );
}

export function ServerArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="12"
        y="2"
        width="24"
        height="36"
        rx="3"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      {[8, 16, 24].map((y) => (
        <g key={y}>
          <rect x="15" y={y} width="18" height="5" rx="1" fill="var(--nf-term-bg)" />
          <circle cx="30" cy={y + 2.5} r="1" fill="var(--nf-ok)" />
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
        fill="var(--nf-hw)"
        stroke="var(--nf-ok)"
        strokeWidth="1.5"
      />
      <path d="M18 22h12M24 16v12" stroke="var(--nf-ok)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function LaptopArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="8"
        y="6"
        width="32"
        height="22"
        rx="2"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <rect x="11" y="9" width="26" height="16" rx="1" fill="var(--nf-term-bg)" />
      <path d="M3 30h42l-3 5H6z" fill="var(--nf-hw-edge)" />
    </svg>
  );
}

export function PhoneArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <rect
        x="16"
        y="3"
        width="16"
        height="34"
        rx="3"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <rect x="18" y="7" width="12" height="24" rx="1" fill="var(--nf-term-bg)" />
      <circle cx="24" cy="34" r="1.2" fill="var(--nf-hw-muted)" />
    </svg>
  );
}

export function ApArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <path d="M16 22V8M32 22V8" stroke="var(--nf-ok)" strokeWidth="2" strokeLinecap="round" />
      <rect
        x="8"
        y="20"
        width="32"
        height="12"
        rx="4"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <circle cx="34" cy="26" r="1.3" fill="var(--nf-ok)" />
    </svg>
  );
}

export function HomeRouterArt({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 48 40" className={className} aria-hidden>
      <path d="M14 20V6M34 20V6" stroke="var(--nf-ok)" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 9a8 8 0 0 1 12 0" stroke="var(--nf-ok)" strokeWidth="1.5" fill="none" />
      <rect
        x="4"
        y="18"
        width="40"
        height="14"
        rx="4"
        fill="var(--nf-hw)"
        stroke="var(--nf-hw-edge)"
        strokeWidth="1"
      />
      <rect x="8" y="23" width="5" height="5" rx="0.8" fill="var(--nf-cable-fiber)" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={17 + i * 6} y={23} width="4" height="5" rx="0.8" fill="var(--nf-socket)" />
      ))}
    </svg>
  );
}

export function SpecArt({ spec, className }: { spec: SpecId; className?: string | undefined }) {
  if (spec === 'pc') return <PcArt className={className} />;
  if (spec === 'router') return <RouterArt className={className} />;
  if (spec === 'server') return <ServerArt className={className} />;
  if (spec === 'internet') return <CloudArt className={className} />;
  if (spec === 'laptop') return <LaptopArt className={className} />;
  if (spec === 'phone') return <PhoneArt className={className} />;
  if (spec === 'ap') return <ApArt className={className} />;
  if (spec === 'homerouter') return <HomeRouterArt className={className} />;
  return <SwitchArt className={className} />;
}
