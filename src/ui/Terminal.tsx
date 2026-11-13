import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { interruptCommand, openTerminal, prompt, runCommand, session, useLab } from './lab.ts';

/** Bottom terminal for one device. Up/Down browse history, Ctrl+C stops a command. */
export function Terminal({ deviceId }: { deviceId: string }) {
  const { net } = useLab();
  const device = net.devices.get(deviceId);
  const s = session(deviceId);
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const running = s.process !== null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [deviceId, running]);

  if (!device) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && running) {
      e.preventDefault();
      interruptCommand(deviceId);
      return;
    }
    if (running) return;
    if (e.key === 'Enter') {
      runCommand(deviceId, input);
      setInput('');
      setHistoryIndex(null);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const { history } = s;
      if (history.length === 0) return;
      const current = historyIndex ?? history.length;
      const next = Math.min(history.length, Math.max(0, current + (e.key === 'ArrowUp' ? -1 : 1)));
      setHistoryIndex(next === history.length ? null : next);
      setInput(history[next] ?? '');
    }
  };

  return (
    <section
      className="flex h-64 shrink-0 flex-col border-t border-(--nf-border) bg-[#05080f]"
      aria-label={`Terminal of ${device.name}`}
      onKeyDown={onKeyDown}
    >
      <header className="flex items-center justify-between border-b border-(--nf-border) px-3 py-1 text-xs text-(--nf-muted)">
        <span>
          Terminal: <strong className="text-(--nf-text)">{device.name}</strong>
          <span className="ml-2">Type “help” for commands{running ? ' · Ctrl+C to stop' : ''}</span>
        </span>
        <button
          type="button"
          onClick={() => openTerminal(null)}
          className="rounded px-2 hover:bg-(--nf-border)"
          aria-label="Close terminal"
        >
          ✕
        </button>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-5 whitespace-pre-wrap text-slate-200"
        onClick={() => inputRef.current?.focus()}
        role="log"
        aria-live="polite"
      >
        {s.lines.map((line, i) => (
          <div key={i}>{line || ' '}</div>
        ))}
        {running ? (
          // Keeps keyboard focus inside the terminal so Ctrl+C reaches it.
          <input
            ref={inputRef}
            className="h-0 w-0 opacity-0"
            aria-label="Running command"
            readOnly
          />
        ) : (
          <label className="flex">
            <span className="text-emerald-400">{prompt(device.name)}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none"
              spellCheck={false}
              autoComplete="off"
              aria-label="Command"
            />
          </label>
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
