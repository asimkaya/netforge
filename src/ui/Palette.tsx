import { useReactFlow } from '@xyflow/react';
import { SPECS, type SpecId } from '../engine/specs.ts';
import { DRAG_MIME } from './Canvas.tsx';
import { SpecArt } from './icons.tsx';
import { addDevice, getLab } from './lab.ts';
import { freeSpot } from './placement.ts';

/** Device palette: drag onto the canvas, or click to add near the center. */
export function Palette() {
  const flow = useReactFlow();

  const addAtCenter = (spec: SpecId) => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane
      ? flow.screenToFlowPosition({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
      : { x: 0, y: 0 };
    const { layout, net } = getLab();
    const placed = [...net.devices.values()].flatMap((d) => {
      const at = layout[d.id];
      return at ? [{ spec: d.spec.id, at }] : [];
    });
    const at = freeSpot(spec, center, placed);
    addDevice(spec, at);
  };

  return (
    <aside className="flex w-24 shrink-0 flex-col gap-2 border-r border-(--nf-border) bg-(--nf-surface) p-2">
      <h2 className="px-1 text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
        Devices
      </h2>
      {Object.values(SPECS).map((spec) => (
        <button
          key={spec.id}
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_MIME, spec.id);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => addAtCenter(spec.id)}
          title={`${spec.description}. Drag onto the canvas or click to add.`}
          className="flex cursor-grab flex-col items-center gap-1 rounded-lg border border-(--nf-border) p-2 text-xs hover:border-(--nf-accent) focus-visible:outline-2 focus-visible:outline-(--nf-accent)"
        >
          <SpecArt spec={spec.id} className="h-8 w-10" />
          Add {spec.label}
        </button>
      ))}
    </aside>
  );
}
