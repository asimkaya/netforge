import type { DeviceKind } from '../engine/device.ts';

const common = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function HostIcon({ className }: { className?: string | undefined }) {
  return (
    <svg {...common} className={className}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function SwitchIcon({ className }: { className?: string | undefined }) {
  return (
    <svg {...common} className={className}>
      <rect x="2" y="7" width="20" height="10" rx="2" />
      <path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01" strokeWidth={2.4} />
    </svg>
  );
}

export function DeviceIcon({
  kind,
  className,
}: {
  kind: DeviceKind;
  className?: string | undefined;
}) {
  return kind === 'host' ? (
    <HostIcon className={className} />
  ) : (
    <SwitchIcon className={className} />
  );
}
