import { useRef, type PointerEvent } from 'react';
import { SpecArt } from '../icons.tsx';
import {
  closeWindow,
  focusWindow,
  hasCli,
  hasDesktop,
  minimizeWindow,
  moveWindow,
  setWindowView,
  useLab,
  type DeviceWindow,
  type WindowTab,
} from '../lab.ts';
import { ConfigTab, DesktopTab, PhysicalTab } from './tabs.tsx';
import { Terminal } from '../apps/Terminal.tsx';

const TAB_LABEL: Record<WindowTab, string> = {
  physical: 'Physical',
  config: 'Config',
  desktop: 'Desktop',
  cli: 'CLI',
};

/** Keeps at least this much of a dragged window inside the canvas. */
const GRAB_MARGIN = 80;

function Window({ win, bounds }: { win: DeviceWindow; bounds: () => DOMRect | undefined }) {
  const { net } = useLab();
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const device = net.devices.get(win.device);
  if (!device || win.minimized) return null;
  const tabs: WindowTab[] = hasDesktop(device.spec.id)
    ? ['physical', 'config', 'desktop']
    : hasCli(device.spec.id)
      ? ['physical', 'config', 'cli']
      : ['physical', 'config'];

  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
  };
  const onPointerMove = (e: PointerEvent) => {
    const box = bounds();
    if (!drag.current || !box) return;
    const x = Math.min(
      Math.max(e.clientX - drag.current.dx, GRAB_MARGIN - 560),
      box.width - GRAB_MARGIN,
    );
    const y = Math.min(Math.max(e.clientY - drag.current.dy, 0), box.height - 40);
    moveWindow(win.device, x, y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <section
      role="dialog"
      aria-label={device.name}
      aria-modal={false}
      onPointerDownCapture={() => focusWindow(win.device)}
      style={{ left: win.x, top: win.y, zIndex: win.z }}
      className="pointer-events-auto absolute flex h-[440px] min-h-[260px] w-[600px] min-w-[360px] resize flex-col overflow-hidden rounded-md border border-(--nf-border) bg-(--nf-surface) shadow-lg max-md:!inset-0 max-md:!h-full max-md:!w-full max-md:resize-none max-md:rounded-none"
    >
      <header
        className="flex cursor-move items-center gap-2 border-b border-(--nf-border) bg-(--nf-raised) px-3 py-1.5 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <SpecArt spec={device.spec.id} className="h-5 w-6" />
        <h2 className="font-label text-base font-semibold">{device.name}</h2>
        <span className="text-xs text-(--nf-muted)">{device.spec.label}</span>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={() => minimizeWindow(win.device)}
            className="grid h-6 w-6 place-items-center rounded hover:bg-(--nf-border)"
            aria-label={`Minimize ${device.name}`}
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M2 6h8" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => closeWindow(win.device)}
            className="grid h-6 w-6 place-items-center rounded hover:bg-(--nf-bad) hover:text-(--nf-hw-text)"
            aria-label={`Close ${device.name}`}
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="m2.5 2.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
      </header>
      <div
        role="tablist"
        aria-label={`${device.name} sections`}
        className="flex gap-1 border-b border-(--nf-border) px-2"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={win.tab === tab}
            onClick={() => setWindowView(win.device, { tab })}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              win.tab === tab
                ? 'border-(--nf-accent) text-(--nf-text)'
                : 'border-transparent text-(--nf-muted) hover:text-(--nf-text)'
            }`}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TAB_LABEL[win.tab]} className="min-h-0 flex-1 overflow-auto">
        {win.tab === 'physical' && <PhysicalTab device={device} />}
        {win.tab === 'config' && <ConfigTab device={device} />}
        {win.tab === 'desktop' && <DesktopTab device={device} app={win.app} />}
        {win.tab === 'cli' && <Terminal deviceId={device.id} />}
      </div>
    </section>
  );
}

/** All open device windows, plus a taskbar for the minimized ones. */
export function Windows() {
  const { net, windows } = useLab();
  const layer = useRef<HTMLDivElement>(null);
  const minimized = windows.filter((w) => w.minimized);
  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {windows.map((w) => (
        <Window key={w.device} win={w} bounds={() => layer.current?.getBoundingClientRect()} />
      ))}
      {minimized.length > 0 && (
        <nav
          aria-label="Minimized windows"
          className="pointer-events-auto absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-md border border-(--nf-border) bg-(--nf-surface) p-1 shadow-lg"
        >
          {minimized.map((w) => {
            const device = net.devices.get(w.device);
            return (
              device && (
                <button
                  key={w.device}
                  type="button"
                  onClick={() => minimizeWindow(w.device, false)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-(--nf-raised)"
                >
                  <SpecArt spec={device.spec.id} className="h-4 w-5" />
                  {device.name}
                </button>
              )
            );
          })}
        </nav>
      )}
    </div>
  );
}
