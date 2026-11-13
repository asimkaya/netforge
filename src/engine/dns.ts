import { parseIp, type Ip } from './addr.ts';
import type { Device } from './device.ts';
import { DNS_PORT } from './dnsmasq.ts';

/** How long a query waits for an answer (dig's default +time). */
export const DNS_TIMEOUT_MS = 5000;

export type Resolution =
  | { ok: true; ip: Ip; server: Ip | null; rtt: number }
  | { ok: false; error: 'nxdomain' | 'timeout' | 'refused' | 'no-server'; server: Ip | null };

/** A valid DNS name: labels of letters, digits and dashes, separated by dots. */
export function isHostname(name: string): boolean {
  return /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(
    name,
  );
}

/**
 * Looks `name` up with the device's first name server (or `server`). Calls `done` exactly
 * once, possibly later in virtual time. Returns a function that cancels the lookup.
 */
export function resolve(
  device: Device,
  name: string,
  done: (result: Resolution) => void,
  server?: Ip,
): () => void {
  const literal = parseIp(name);
  if (literal !== null) {
    done({ ok: true, ip: literal, server: null, rtt: 0 });
    return () => {};
  }
  const stack = device.ip;
  const to = server ?? stack?.dns[0];
  if (!stack || to === undefined) {
    done({ ok: false, error: 'no-server', server: null });
    return () => {};
  }
  const { scheduler } = device.fabric;
  const id = stack.nextDnsId();
  const sentAt = scheduler.now;
  let timer: number | null = null;
  let finished = false;
  const finish = (result: Resolution) => {
    if (finished) return;
    finished = true;
    if (timer !== null) scheduler.cancel(timer);
    if (typeof socket !== 'string') socket.close();
    done(result);
  };
  const query = name.replace(/\.$/, '').toLowerCase();
  const socket = stack.openUdp(
    (datagram) => {
      const msg = datagram.data;
      if (msg.app !== 'dns' || msg.qr !== 'response' || msg.id !== id) return;
      finish(
        msg.answer
          ? { ok: true, ip: msg.answer, server: to, rtt: scheduler.now - sentAt }
          : { ok: false, error: 'nxdomain', server: to },
      );
    },
    (error) =>
      finish({
        ok: false,
        error: error.kind === 'unreachable' ? 'refused' : 'timeout',
        server: to,
      }),
  );
  if (typeof socket === 'string') {
    done({ ok: false, error: 'timeout', server: to });
    return () => {};
  }
  const error = socket.send(to, DNS_PORT, { app: 'dns', id, qr: 'query', name: query });
  if (error) {
    finish({ ok: false, error: 'timeout', server: to });
    return () => {};
  }
  timer = scheduler.schedule(DNS_TIMEOUT_MS, () =>
    finish({ ok: false, error: 'timeout', server: to }),
  );
  return () => {
    finished = true;
    if (timer !== null) scheduler.cancel(timer);
    socket.close();
  };
}
