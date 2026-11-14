import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  completeInput,
  interruptCommand,
  prompt,
  runCommand,
  sendInput,
  session,
  useLab,
} from '../lab.ts';

/** A device's shell. Up/Down browse history, Tab completes, Ctrl+C stops a command. */
export function Terminal({ deviceId }: { deviceId: string }) {
  const { net } = useLab();
  const device = net.devices.get(deviceId);
  const s = session(deviceId);
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const running = s.process !== null;
  // An interactive program (ssh) waiting for a line shows its own prompt.
  const programPrompt = s.process?.input ? (s.process.prompt?.() ?? null) : null;
  const secret = s.process?.secret?.() ?? false;
  const typing = !running || programPrompt !== null;

  // Follow new output. Scrolling the log itself (not scrollIntoView) leaves the page alone.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [deviceId, running, typing]);

  if (!device) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && running) {
      e.preventDefault();
      interruptCommand(deviceId);
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      // Tab belongs to the shell: it must not move focus out of the terminal.
      e.preventDefault();
      if (!running) setInput(completeInput(deviceId, input));
      return;
    }
    if (e.key === 'Enter') {
      // While a command runs, the line is typed ahead and runs when it exits.
      if (running && typing) sendInput(deviceId, input);
      else runCommand(deviceId, input);
      setInput('');
      setHistoryIndex(null);
    } else if (!typing) {
      return;
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
      className="flex h-full min-h-0 flex-col bg-[#05080f]"
      aria-label={`Terminal of ${device.name}`}
      onKeyDown={onKeyDown}
    >
      <p className="border-b border-(--nf-border) px-3 py-1 text-xs text-(--nf-muted)">
        Type “help” for commands{running ? ' · Ctrl+C to stop' : ''}
      </p>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[13px] leading-5 whitespace-pre-wrap text-slate-200"
        ref={logRef}
        onClick={() => inputRef.current?.focus()}
        role="log"
        aria-live="polite"
      >
        {s.lines.map((line, i) => {
          // shortcut: only the shell prompt shape is coloured, not password prompts
          const m = /^root@[\w.-]+:~# /.exec(line);
          return (
            <div key={i}>
              {m ? <span className="text-emerald-400">{m[0]}</span> : null}
              {(m ? line.slice(m[0].length) : line) || ' '}
            </div>
          );
        })}
        <label className="flex">
          {typing && (
            <span className="text-emerald-400">{programPrompt ?? prompt(device.name)}</span>
          )}
          <input
            ref={inputRef}
            value={input}
            type={secret ? 'password' : 'text'}
            onChange={(e) => setInput(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            spellCheck={false}
            autoComplete="off"
            aria-label={secret ? 'Password' : 'Command'}
          />
        </label>
      </div>
    </section>
  );
}
