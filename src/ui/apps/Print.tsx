import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Device } from '../../engine/device.ts';
import { printJob } from '../../engine/appliance-clients.ts';
import { useLab } from '../lab.ts';
import { FIELD, PRIMARY } from '../styles.ts';

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; message: string }
  | { kind: 'error'; message: string };

/** Sends a document to a network printer: raw text to TCP 9100, like `nc HOST 9100 < FILE`. */
export function Print({ device }: { device: Device }) {
  useLab();
  const [printer, setPrinter] = useState('');
  const [file, setFile] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const cancel = useRef<() => void>(() => {});

  useEffect(() => () => cancel.current(), []);

  const files = device.fs ? [...device.fs.files.keys()].sort() : [];
  const pick = (path: string) => {
    setFile(path);
    if (path) setText(device.fs?.read(path) ?? '');
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    const host = printer.trim();
    if (!host || !text.trim()) {
      setStatus({ kind: 'error', message: 'Enter a printer and something to print.' });
      return;
    }
    cancel.current();
    setStatus({ kind: 'sending' });
    cancel.current = printJob(device, host, text, (r) =>
      setStatus(
        r.ok
          ? { kind: 'sent', message: `Sent to ${host} (${r.ip})` }
          : { kind: 'error', message: r.error },
      ),
    );
  };

  return (
    <form onSubmit={send} className="flex h-full min-h-0 flex-col gap-2 p-3 text-xs">
      <label className="flex items-center gap-2">
        <span className="w-16">Printer</span>
        <input
          value={printer}
          onChange={(e) => setPrinter(e.target.value)}
          placeholder="printer1 or 192.168.1.100"
          aria-label="Printer"
          className={`${FIELD} min-w-0 flex-1`}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16">File</span>
        <select
          value={file}
          onChange={(e) => pick(e.target.value)}
          aria-label="File"
          className={`${FIELD} min-w-0 flex-1`}
        >
          <option value="">(type below)</option>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Text to print"
        aria-label="Document"
        className={`${FIELD} min-h-20 flex-1 font-mono`}
      />
      <div className="flex items-center gap-3">
        <button type="submit" className={PRIMARY} disabled={status.kind === 'sending'}>
          Print
        </button>
        {status.kind === 'sending' && (
          <span role="status" className="text-(--nf-muted)">
            Sending…
          </span>
        )}
        {status.kind === 'sent' && (
          <span role="status" className="text-(--nf-ok)">
            {status.message}
          </span>
        )}
        {status.kind === 'error' && (
          <span role="alert" className="text-(--nf-bad)">
            {status.message}
          </span>
        )}
      </div>
    </form>
  );
}
