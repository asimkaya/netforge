import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Device } from '../../engine/device.ts';
import { watchCamera } from '../../engine/appliance-clients.ts';
import { FIELD, PRIMARY, SECONDARY } from '../styles.ts';

type View =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; ip: string; frame: number | null }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

/** Watches an IP camera: TCP 554 plus the UDP 5004 stream, like `nc HOST 554`. */
export function CameraViewer({ device }: { device: Device }) {
  const [camera, setCamera] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const stop = useRef<() => void>(() => {});

  useEffect(() => () => stop.current(), []);

  const connect = (e?: FormEvent) => {
    e?.preventDefault();
    const host = camera.trim();
    if (!host) return;
    stop.current();
    setView({ kind: 'connecting' });
    stop.current = watchCamera(device, host, (ev) =>
      setView((v) => {
        if (ev.kind === 'connected') return { kind: 'connected', ip: ev.ip, frame: null };
        if (ev.kind === 'frame') return v.kind === 'connected' ? { ...v, frame: ev.frame } : v;
        return ev.kind === 'closed' ? { kind: 'closed' } : ev;
      }),
    );
  };

  const disconnect = () => {
    stop.current();
    setView({ kind: 'idle' });
  };

  const live = view.kind === 'connecting' || view.kind === 'connected';
  const frame = view.kind === 'connected' ? view.frame : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={connect} className="flex gap-2 border-b border-(--nf-border) p-2">
        <input
          value={camera}
          onChange={(e) => setCamera(e.target.value)}
          placeholder="cam1 or 192.168.1.101"
          aria-label="Camera"
          className={`${FIELD} min-w-0 flex-1`}
        />
        {live ? (
          <button key="disconnect" type="button" onClick={disconnect} className={SECONDARY}>
            Disconnect
          </button>
        ) : (
          <button key="connect" type="submit" className={PRIMARY}>
            Connect
          </button>
        )}
      </form>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-xs">
        <div className="relative flex min-h-24 flex-1 items-center justify-center rounded bg-black font-mono text-(--nf-muted)">
          {view.kind === 'connected' && frame !== null ? (
            <>
              <span className="absolute top-2 left-2 text-white">
                {view.ip} · frame {frame}
              </span>
              <span className="absolute right-2 bottom-2 text-[10px]">
                placeholder: the picture is not simulated
              </span>
            </>
          ) : (
            'no signal'
          )}
        </div>
        <p role={view.kind === 'error' ? 'alert' : 'status'} className="text-(--nf-muted)">
          {view.kind === 'idle' && 'Type the name or address of a camera and press Connect.'}
          {view.kind === 'connecting' && 'Connecting…'}
          {view.kind === 'connected' &&
            frame === null &&
            `Connected to ${view.ip}, waiting for video… (a firewall may drop UDP 5004)`}
          {frame !== null && `Streaming: frame ${frame}`}
          {view.kind === 'closed' && 'The camera hung up.'}
          {view.kind === 'error' && view.message}
        </p>
      </div>
    </div>
  );
}
