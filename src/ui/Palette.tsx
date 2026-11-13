import { useReactFlow } from '@xyflow/react';
import type { DeviceKind } from '../engine/device.ts';
import { DRAG_MIME } from './Canvas.tsx';
import { DeviceIcon } from './icons.tsx';
import { addDevice, getLab } from './lab.ts';

const ITEMS: { kind: DeviceKind; label: string; hint: string }[] = [
  { kind: 'host', label: 'PC', hint: 'A computer with one network port' },
  { kind: 'switch', label: 'Switch', hint: 'Connects up to 8 devices in one network' },
];

/** Device palette: drag onto the canvas, or click to add near the center. */
export function Palette() {
  const flow = useReactFlow();

  const addAtCenter = (kind: DeviceKind) => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane
      ? flow.screenToFlowPosition({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
      : { x: 0, y: 0 };
    // Lay new devices out on a 4x3 grid around the center so they don't overlap.
    const n = getLab().net.devices.size;
    const col = (n % 4) - 1.5;
    const row = (Math.floor(n / 4) % 3) - 1;
    addDevice(kind, { x: center.x - 56 + col * 170, y: center.y - 45 + row * 140 });
  };

  return (
    <aside className="flex w-24 shrink-0 flex-col gap-2 border-r border-(--nf-border) bg-(--nf-surface) p-2">
      <h2 className="px-1 text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
        Devices
      </h2>
      {ITEMS.map((item) => (
        <button
          key={item.kind}
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_MIME, item.kind);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => addAtCenter(item.kind)}
          title={`${item.hint}. Drag onto the canvas or click to add.`}
          className="flex cursor-grab flex-col items-center gap-1 rounded-lg border border-(--nf-border) p-2 text-xs hover:border-(--nf-accent) focus-visible:outline-2 focus-visible:outline-(--nf-accent)"
        >
          <DeviceIcon kind={item.kind} className="h-7 w-7 text-(--nf-accent)" />
          Add {item.label}
        </button>
      ))}
    </aside>
  );
}
