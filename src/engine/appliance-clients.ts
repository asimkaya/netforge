import { formatIp } from './addr.ts';
import { CAMERA_PORT, PRINTER_PORT, STREAM_PORT } from './appliances.ts';
import type { Device } from './device.ts';
import { resolve } from './dns.ts';
import type { UdpSocket } from './ip.ts';
import { TCP_ERROR_TEXT } from './tcp.ts';

/** What the Print and Camera apps do, with the same traffic as `nc HOST 9100` and `nc HOST 554`. */

export type PrintResult = { ok: true; ip: string } | { ok: false; error: string };

/** Sends `text` as one print job. Returns a function that cancels it. */
export function printJob(
  device: Device,
  host: string,
  text: string,
  done: (result: PrintResult) => void,
): () => void {
  const stack = device.ip;
  if (!stack) {
    done({ ok: false, error: 'This device has no network stack.' });
    return () => {};
  }
  let cancelled = false;
  let close = () => {};
  const finish = (result: PrintResult) => {
    if (!cancelled) done(result);
  };
  const cancelLookup = resolve(device, host, (r) => {
    if (cancelled) return;
    if (!r.ok) {
      finish({ ok: false, error: `Could not resolve "${host}": Name or service not known` });
      return;
    }
    const ip = formatIp(r.ip);
    const conn = stack.tcp.connect(r.ip, PRINTER_PORT, {
      // An empty job sends nothing, and the printer only counts a job that carries data.
      onData: () => {},
      onOpen: (c) => c.send(text.endsWith('\n') ? text : `${text}\n`),
      onClose: () => finish({ ok: true, ip }),
      onError: (error) =>
        finish({
          ok: false,
          error: `Connection to ${host} (${ip}) port ${PRINTER_PORT} failed: ${TCP_ERROR_TEXT[error]}`,
        }),
    });
    if (typeof conn === 'string') {
      finish({ ok: false, error: `Connection to ${host} port ${PRINTER_PORT} failed: ${conn}` });
      return;
    }
    close = () => conn.close();
  });
  return () => {
    cancelled = true;
    cancelLookup();
    close();
  };
}

export type CameraEvent =
  | { kind: 'connected'; ip: string }
  | { kind: 'frame'; frame: number }
  | { kind: 'closed' }
  | { kind: 'error'; message: string };

/** Connects to a camera and listens for its stream. Returns a function that disconnects. */
export function watchCamera(
  device: Device,
  host: string,
  on: (event: CameraEvent) => void,
): () => void {
  const stack = device.ip;
  if (!stack) {
    on({ kind: 'error', message: 'This device has no network stack.' });
    return () => {};
  }
  let cancelled = false;
  let close = () => {};
  const emit = (event: CameraEvent) => {
    if (!cancelled) on(event);
  };
  const cancelLookup = resolve(device, host, (r) => {
    if (cancelled) return;
    if (!r.ok) {
      emit({ kind: 'error', message: `Could not resolve "${host}": Name or service not known` });
      return;
    }
    const ip = formatIp(r.ip);
    let stream: UdpSocket | null = null;
    const conn = stack.tcp.connect(r.ip, CAMERA_PORT, {
      onData: () => {},
      onOpen: (c) => {
        const opened = stack.openUdp(
          (d) => {
            if (d.data.app === 'stream') emit({ kind: 'frame', frame: d.data.frame });
          },
          undefined,
          STREAM_PORT,
        );
        if (typeof opened === 'string') {
          c.close();
          emit({ kind: 'error', message: `Cannot listen on UDP ${STREAM_PORT}: ${opened}` });
          return;
        }
        stream = opened;
        emit({ kind: 'connected', ip });
      },
      onClose: () => {
        stream?.close();
        stream = null;
        emit({ kind: 'closed' });
      },
      onError: (error) =>
        emit({
          kind: 'error',
          message: `Connection to ${host} (${ip}) port ${CAMERA_PORT} failed: ${TCP_ERROR_TEXT[error]}`,
        }),
    });
    if (typeof conn === 'string') {
      emit({ kind: 'error', message: `Connection to ${host} port ${CAMERA_PORT} failed: ${conn}` });
      return;
    }
    close = () => {
      conn.close();
      stream?.close();
      stream = null;
    };
  });
  return () => {
    cancelled = true;
    cancelLookup();
    close();
  };
}
