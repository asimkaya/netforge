import { ReactFlowProvider } from '@xyflow/react';
import { useState } from 'react';
import { Canvas } from './Canvas.tsx';
import { useRealtimeClock } from './clock.ts';
import { LabMenu } from './LabMenu.tsx';
import { setMode, useLab, type Mode } from './lab.ts';
import { Palette } from './Palette.tsx';
import { ReportPanel } from './ReportUi.tsx';
import { SimPanel } from './SimPanel.tsx';
import { Coach, Sidebar, type Tab } from './TaskPanel.tsx';
import { Windows } from './window/Windows.tsx';
import { useTaskProgress } from './taskProgress.ts';

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'realtime', label: 'Realtime', hint: 'Time runs like a real network' },
  { mode: 'simulation', label: 'Simulation', hint: 'Pause time and step through every frame' },
];

function ModeSwitch({ mode }: { mode: Mode }) {
  const { net } = useLab();
  return (
    <div role="radiogroup" aria-label="Mode" className="flex h-8 items-stretch gap-1 text-sm">
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          aria-checked={mode === m.mode}
          title={m.hint}
          onClick={() => {
            if (m.mode === 'simulation' && mode !== 'simulation') net.clearTrace();
            setMode(m.mode);
          }}
          className={`rounded-t border-b-2 px-3 max-sm:px-2 ${
            mode === m.mode
              ? 'border-(--nf-accent) bg-(--nf-raised) font-medium text-(--nf-text)'
              : 'border-transparent text-(--nf-muted) hover:bg-(--nf-raised)'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { net, mode, notice } = useLab();
  useRealtimeClock(net, mode);
  useTaskProgress();
  // The side panel starts closed on narrow screens, where it would cover the canvas.
  const [panel, setPanel] = useState(() => window.matchMedia('(min-width: 768px)').matches);

  const [tab, setTab] = useState<Tab>('tasks');

  return (
    <ReactFlowProvider>
      <div className="relative flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--nf-border) bg-(--nf-surface) px-4 max-sm:px-2">
          <img src="/favicon.svg" alt="" className="h-6 w-6 shrink-0" />
          <h1 className="font-label text-lg font-semibold max-sm:hidden">NetForge</h1>
          <div className="shrink-0 sm:ml-6">
            <ModeSwitch mode={mode} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LabMenu />
            <button
              type="button"
              aria-pressed={panel}
              onClick={() => setPanel(!panel)}
              title={panel ? 'Hide the task panel' : 'Show the task panel'}
              className="h-7 shrink-0 rounded border border-(--nf-border) px-3 text-xs whitespace-nowrap hover:bg-(--nf-raised) max-sm:px-2 aria-pressed:bg-(--nf-raised)"
            >
              Tasks
            </button>
          </div>
        </header>
        <ReportPanel />
        <div className="relative flex min-h-0 flex-1">
          <Palette />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Canvas
                onShowPanel={(to) => {
                  if (to) setTab(to);
                  setPanel(true);
                }}
              />
              <Windows />
              {!panel && <Coach onOpen={() => setPanel(true)} />}
              {notice && (
                <div
                  role="status"
                  className="absolute top-3 left-1/2 z-20 -translate-x-1/2 rounded-md border border-(--nf-border) bg-(--nf-surface) px-4 py-2 text-sm shadow-lg"
                >
                  {notice}
                </div>
              )}
            </div>
            {mode === 'simulation' && <SimPanel />}
          </main>
          {panel && (
            // On narrow screens the panel floats over the canvas instead of squeezing it.
            <aside className="w-72 max-w-full shrink-0 overflow-y-auto border-l border-(--nf-border) bg-(--nf-surface) max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:shadow-lg">
              <Sidebar tab={tab} setTab={setTab} />
            </aside>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
