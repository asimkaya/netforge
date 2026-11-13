import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Canvas.tsx';
import { useRealtimeClock } from './clock.ts';
import { Inspector } from './Inspector.tsx';
import { LabMenu } from './LabMenu.tsx';
import { setMode, useLab, type Mode } from './lab.ts';
import { Palette } from './Palette.tsx';
import { SimPanel } from './SimPanel.tsx';
import { Sidebar } from './TaskPanel.tsx';
import { useTaskProgress } from './taskProgress.ts';
import { Terminal } from './Terminal.tsx';

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'realtime', label: 'Realtime', hint: 'Time runs like a real network' },
  { mode: 'simulation', label: 'Simulation', hint: 'Pause time and step through every frame' },
];

function ModeSwitch({ mode }: { mode: Mode }) {
  const { net } = useLab();
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      className="flex rounded border border-(--nf-border) p-0.5 text-xs"
    >
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
          className={`rounded px-3 py-0.5 ${
            mode === m.mode ? 'bg-(--nf-accent) font-semibold text-slate-950' : 'text-(--nf-muted)'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { net, mode, terminal, notice } = useLab();
  useRealtimeClock(net, mode);
  useTaskProgress();

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--nf-border) bg-(--nf-surface) px-4">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <h1 className="text-base font-semibold tracking-tight">NetForge</h1>
          <div className="ml-6">
            <ModeSwitch mode={mode} />
          </div>
          <div className="ml-auto">
            <LabMenu />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <Palette />
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <Canvas />
              {notice && (
                <div
                  role="status"
                  className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-amber-500/50 bg-(--nf-surface) px-4 py-2 text-sm shadow-lg"
                >
                  {notice}
                </div>
              )}
            </div>
            {mode === 'simulation' && <SimPanel />}
            {terminal && <Terminal key={terminal} deviceId={terminal} />}
          </main>
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-(--nf-border) bg-(--nf-surface)">
            <Sidebar>
              <Inspector />
            </Sidebar>
          </aside>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
