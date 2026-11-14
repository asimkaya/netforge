import { getViewportForBounds, useReactFlow } from '@xyflow/react';
import { SPECS, type SpecId } from '../engine/specs.ts';
import { DRAG_MIME } from './Canvas.tsx';
import { SpecArt } from './icons.tsx';
import { LIMITS } from './annotations.ts';
import { addDevice, addNote, addZone, getLab } from './lab.ts';
import { FOOTPRINT, boundsOfRects, freeRect, freeSpot, type Rect } from './placement.ts';
import { useTaskFocus } from './taskProgress.ts';

/** A note's height follows its text; this is the room kept free for an empty one. */
const NOTE_HEIGHT = 80;

const TILE =
  'flex flex-col items-center gap-0.5 rounded p-1 text-center text-xs leading-tight hover:bg-(--nf-raised)';

const GROUPS: { title: string; specs: SpecId[] }[] = [
  { title: 'End devices', specs: ['pc', 'laptop', 'phone', 'server', 'printer', 'camera'] },
  {
    title: 'Network',
    specs: ['switch', 'switch24', 'l3switch', 'ap', 'router', 'homerouter', 'internet'],
  },
];

/** Device palette: drag onto the canvas, or click to add near the center. */
export function Palette() {
  const flow = useReactFlow();
  const focus = useTaskFocus();

  const viewCenter = () => {
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    const center = pane
      ? flow.screenToFlowPosition({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
      : { x: 0, y: 0 };
    return { pane, center };
  };

  const deviceRects = (): Rect[] => {
    const { layout, net } = getLab();
    return [...net.devices.values()].flatMap((d) => {
      const at = layout[d.id];
      return at ? [{ ...at, ...FOOTPRINT[d.spec.id] }] : [];
    });
  };

  /** The new item can be outside the view: zoom out so it is never lost. */
  const reveal = (pane: DOMRect | undefined, item: Rect, others: readonly Rect[]) => {
    if (!pane) return;
    const from = flow.screenToFlowPosition({ x: pane.x, y: pane.y });
    const to = flow.screenToFlowPosition({ x: pane.right, y: pane.bottom });
    if (item.x >= from.x && item.y >= from.y && item.x + item.w <= to.x && item.y + item.h <= to.y)
      return;
    const bounds = boundsOfRects([...others, item]);
    // No animation: a cable drag may start right after the click.
    void flow.setViewport(getViewportForBounds(bounds, pane.width, pane.height, 0.2, 1, 0.1));
  };

  const addAtCenter = (spec: SpecId) => {
    const { pane, center } = viewCenter();
    const { layout, net } = getLab();
    const placed = [...net.devices.values()].flatMap((d) => {
      const at = layout[d.id];
      return at ? [{ spec: d.spec.id, at }] : [];
    });
    const at = freeSpot(spec, center, placed);
    addDevice(spec, at);
    reveal(pane, { ...at, ...FOOTPRINT[spec] }, deviceRects());
  };

  /** Notes and zones go to the free spot nearest the middle of the view. */
  const addAnnotation = (kind: 'note' | 'zone') => {
    const { pane, center } = viewCenter();
    const { notes, zones } = getLab();
    const taken: Rect[] = [
      ...deviceRects(),
      ...notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: NOTE_HEIGHT })),
      ...zones,
    ];
    const size =
      kind === 'note'
        ? { w: LIMITS.noteWidth.start, h: NOTE_HEIGHT }
        : { w: LIMITS.zoneWidth.start, h: LIMITS.zoneHeight.start };
    const at = freeRect(size, center, taken);
    if (kind === 'note') addNote(at);
    else addZone(at);
    reveal(pane, { ...at, ...size }, taken);
  };

  const deviceButton = (id: SpecId) => {
    const spec = SPECS[id];
    return (
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
        aria-label={`Add ${spec.label}`}
        className={`${TILE} cursor-grab ${focus?.palette.includes(spec.id) ? 'nf-focus' : ''}`}
      >
        <SpecArt spec={spec.id} className="h-7 w-9" />
        {spec.label}
      </button>
    );
  };

  return (
    <aside className="flex w-32 shrink-0 flex-col gap-1 overflow-y-auto border-r border-(--nf-border) bg-(--nf-surface) p-2">
      {GROUPS.map(({ title, specs }) => (
        <section key={title} aria-label={title} className="flex flex-col gap-0.5">
          <h2 className="px-1 pt-1 pb-0.5 text-xs font-semibold text-(--nf-muted)">{title}</h2>
          <div className="grid grid-cols-2 gap-0.5">{specs.map(deviceButton)}</div>
        </section>
      ))}
      <section aria-label="Annotate" className="flex flex-col gap-0.5">
        <h2 className="px-1 pt-1 pb-0.5 text-xs font-semibold text-(--nf-muted)">Annotate</h2>
        <div className="grid grid-cols-2 gap-0.5">
          <button
            type="button"
            onClick={() => addAnnotation('note')}
            title="A text label on the canvas. Double-click it to edit."
            aria-label="Add Note"
            className={TILE}
          >
            <svg viewBox="0 0 36 28" className="h-7 w-9" fill="none" stroke="currentColor">
              <rect x="6" y="4" width="24" height="20" rx="2" strokeWidth="1.5" />
              <path d="M11 10h14M11 14h14M11 18h8" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Note
          </button>
          <button
            type="button"
            onClick={() => addAnnotation('zone')}
            title="A labelled rectangle behind devices, to group them."
            aria-label="Add Zone"
            className={TILE}
          >
            <svg viewBox="0 0 36 28" className="h-7 w-9" fill="none" stroke="currentColor">
              <rect
                x="4"
                y="4"
                width="28"
                height="20"
                rx="3"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
              <path d="M8 9h10" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Zone
          </button>
        </div>
      </section>
    </aside>
  );
}
