import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Canvas.tsx';
import { useRealtimeClock } from './clock.ts';
import { Inspector } from './Inspector.tsx';
import { useLab } from './lab.ts';
import { Palette } from './Palette.tsx';
import { Terminal } from './Terminal.tsx';

export function App() {
  const { net, mode, terminal, notice } = useLab();
  useRealtimeClock(net, mode);

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--nf-border) bg-(--nf-surface) px-4">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <h1 className="text-base font-semibold tracking-tight">NetForge</h1>
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
            {terminal && <Terminal key={terminal} deviceId={terminal} />}
          </main>
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-(--nf-border) bg-(--nf-surface)">
            <Inspector />
          </aside>
        </div>
      </div>
    </ReactFlowProvider>
  );
}
