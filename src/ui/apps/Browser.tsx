import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Device } from '../../engine/device.ts';
import { httpGet, type HttpResponse } from '../../engine/http.ts';
import { FIELD, PRIMARY } from './IpConfig.tsx';

/**
 * Pages come from lab files anyone can share, so they are shown in a sandboxed frame: no
 * scripts, no forms, no navigation, and a CSP that blocks every outside request.
 */
const CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">';

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; url: string }
  | { kind: 'page'; url: string; response: HttpResponse }
  | { kind: 'error'; url: string; message: string };

function pageDocument(response: HttpResponse): string {
  const type = response.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const body = type.startsWith('text/html')
    ? response.body
    : `<pre>${response.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`;
  return `<!doctype html><html><head>${CSP}<style>body{font-family:system-ui,sans-serif;margin:16px;color:#111;background:#fff}</style></head><body>${body}</body></html>`;
}

/** A small web browser: fetches pages over the simulated network with HTTP. */
export function Browser({ device }: { device: Device }) {
  const [address, setAddress] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const cancel = useRef<() => void>(() => {});

  useEffect(() => () => cancel.current(), []);

  const go = (e?: FormEvent) => {
    e?.preventDefault();
    const url = address.trim();
    if (!url) return;
    cancel.current();
    setView({ kind: 'loading', url });
    cancel.current = httpGet(device, url, (result) => {
      if (result.ok) setView({ kind: 'page', url, response: result.response });
      else setView({ kind: 'error', url, message: result.error });
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={go} className="flex gap-2 border-b border-(--nf-border) p-2">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="http://10.0.0.80/ or www.example.lab"
          aria-label="Address"
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button type="submit" className={PRIMARY}>
          Go
        </button>
      </form>
      <div className="min-h-0 flex-1 overflow-auto bg-white">
        {view.kind === 'idle' && (
          <p className="p-4 text-sm text-slate-600">
            Type the address of a web server, like <code>http://10.0.0.80/</code>, and press Go.
          </p>
        )}
        {view.kind === 'loading' && (
          <p className="p-4 text-sm text-slate-600" role="status">
            Connecting to {view.url}…
          </p>
        )}
        {view.kind === 'error' && (
          <div className="space-y-2 p-4 text-sm text-slate-800" role="alert">
            <h3 className="text-lg font-semibold">This site can’t be reached</h3>
            <p>{view.message}</p>
            <p className="text-slate-500">
              Check the address, the server’s web service, your gateway and DNS settings.
            </p>
          </div>
        )}
        {view.kind === 'page' && (
          <iframe
            title={`Page ${view.url}`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={pageDocument(view.response)}
            className="h-full w-full border-0"
          />
        )}
      </div>
      {view.kind === 'page' && (
        <p
          className="border-t border-(--nf-border) px-2 py-1 font-mono text-[11px] text-(--nf-muted)"
          aria-label="Response status"
        >
          HTTP {view.response.status} {view.response.statusText} · {view.response.body.length} bytes
        </p>
      )}
    </div>
  );
}
