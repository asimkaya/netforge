import { Canvas } from './Canvas.tsx';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-(--nf-border) bg-(--nf-surface) px-4">
        <img src="/favicon.svg" alt="" className="h-6 w-6" />
        <h1 className="text-base font-semibold tracking-tight">NetForge</h1>
      </header>
      <main className="min-h-0 flex-1">
        <Canvas />
      </main>
    </div>
  );
}
