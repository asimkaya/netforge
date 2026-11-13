import { useEffect, useRef } from 'react';
import type { Device } from '../engine/device.ts';
import { MEDIUM_OF, PORT_TYPE_LABEL, peerOf, type Port } from '../engine/port.ts';
import { cable } from './lab.ts';

export interface PortMenuState {
  from: Port;
  target: Device;
  /** Position inside the canvas, in px. */
  x: number;
  y: number;
}

function why(port: Port, from: Port): string | null {
  const peer = peerOf(port);
  if (peer) return `in use: ${peer.device.name} ${peer.name}`;
  if (MEDIUM_OF[port.type] !== MEDIUM_OF[from.type]) return 'different cable';
  return null;
}

/** Asks which port of `target` the new cable goes into. */
export function PortMenu({ menu, onClose }: { menu: PortMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Choose a port on ${menu.target.name}`}
      className="absolute z-20 max-h-72 w-60 overflow-y-auto rounded-lg border border-(--nf-border) bg-(--nf-surface) p-1 text-xs shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      <p className="px-2 py-1 text-(--nf-muted)">
        Cable from {menu.from.device.name} {menu.from.name} to {menu.target.name}:
      </p>
      {menu.target.ports.map((port) => {
        const reason = why(port, menu.from);
        return (
          <button
            key={port.name}
            type="button"
            role="menuitem"
            disabled={reason !== null}
            onClick={() => {
              cable(menu.from, port);
              onClose();
            }}
            className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-(--nf-border) focus-visible:bg-(--nf-border) focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="font-mono">{port.name}</span>
            <span className="text-(--nf-muted)">{reason ?? PORT_TYPE_LABEL[port.type]}</span>
          </button>
        );
      })}
    </div>
  );
}
