import { formatIp, type Ip } from './addr.ts';
import type { IpStack, UdpSocket } from './ip.ts';
import type { Scheduler } from './scheduler.ts';
import type { TcpConnection } from './tcp.ts';

/** Single-purpose network devices: a printer and an IP camera. Their services start with them. */

export const PRINTER_PORT = 9100;
export const CAMERA_PORT = 554;
/** Where a viewer listens for the stream; real cameras negotiate this over RTSP. */
export const STREAM_PORT = 5004;
const STREAM_INTERVAL_MS = 1000;
const CRLF = '\r\n';

function reply(code: number, text: string, body: string, head: boolean): string {
  return [
    `HTTP/1.1 ${code} ${text}`,
    'Content-Type: text/html',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    head ? '' : body,
  ].join(CRLF);
}

/** Serves one page at `/` (and `/index.html`) on port 80; everything else is a 404. */
function serveStatus(stack: IpStack, page: () => string): () => void {
  const stop = stack.tcp.listen(80, () => ({
    onData: (request, conn) => {
      const [method = '', target = ''] = (request.split(CRLF)[0] ?? '').split(' ');
      const path = target.split('?')[0];
      const found =
        (method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html');
      const head = method === 'HEAD';
      conn.send(
        found
          ? reply(200, 'OK', page(), head)
          : reply(404, 'Not Found', '<h1>404 Not Found</h1>\n', head),
      );
      conn.close();
    },
  }));
  // A new device has no listeners yet, so this cannot fail.
  return typeof stop === 'string' ? () => {} : stop;
}

const html = (title: string, lines: string[]) =>
  `<!doctype html>\n<html>\n  <head><title>${title}</title></head>\n  <body>\n    <h1>${title}</h1>\n${lines
    .map((l) => `    <p>${l}</p>\n`)
    .join('')}  </body>\n</html>\n`;

const addressOf = (stack: IpStack): string => {
  const first = stack.allAddrs()[0];
  return first ? formatIp(first.ip) : 'no address';
};

/** A network printer: status page on port 80, print jobs on TCP 9100 (raw, JetDirect style). */
export class Printer {
  /** Print jobs received since the last reset. Not saved with the lab. */
  pages = 0;

  constructor(
    private readonly name: () => string,
    stack: IpStack,
    private readonly changed: () => void,
  ) {
    serveStatus(stack, () =>
      html('Printer ready', [
        `Name: ${this.name()}`,
        `Address: ${addressOf(stack)}`,
        `Pages printed: ${this.pages}`,
      ]),
    );
    stack.tcp.listen(PRINTER_PORT, () => ({
      onData: (_data, conn) => {
        // shortcut: one connection that sends data is one job; the printer hangs up after
        // it, which real ones leave to the client.
        this.pages++;
        this.changed();
        conn.close();
      },
    }));
  }

  reset(): void {
    this.pages = 0;
    this.changed();
  }
}

/**
 * An IP camera: a "Live view" page on port 80, and a stream to every viewer connected to
 * TCP 554: one small UDP packet per second to the viewer, until it disconnects.
 */
export class Camera {
  readonly #viewers = new Map<TcpConnection, number>();
  /** Addresses that were sent a frame since the last clear (guided tasks check it). */
  readonly watchers = new Set<Ip>();
  #timer: number | null = null;
  #socket: UdpSocket | null = null;

  constructor(
    private readonly name: () => string,
    private readonly stack: IpStack,
    private readonly scheduler: Scheduler,
    private readonly changed: () => void,
  ) {
    serveStatus(stack, () =>
      html('Live view', [
        `Camera: ${this.name()}`,
        `Address: ${addressOf(stack)}`,
        '[ image placeholder: the picture is not simulated ]',
        `Viewers: ${this.#viewers.size}`,
      ]),
    );
    stack.tcp.listen(CAMERA_PORT, (conn) => {
      this.#viewers.set(conn, 0);
      this.#schedule();
      this.changed();
      return {
        onData: () => {},
        onClose: () => this.#drop(conn),
      };
    });
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  #drop(conn: TcpConnection): void {
    if (!this.#viewers.delete(conn)) return;
    if (this.#viewers.size === 0) this.#cancel();
    this.changed();
  }

  #schedule(): void {
    if (this.#timer === null) this.#timer = this.scheduler.schedule(STREAM_INTERVAL_MS, this.#tick);
  }

  #cancel(): void {
    if (this.#timer !== null) this.scheduler.cancel(this.#timer);
    this.#timer = null;
  }

  readonly #tick = (): void => {
    this.#timer = null;
    if (!this.#socket) {
      const opened = this.stack.openUdp(() => {});
      if (typeof opened === 'string') return;
      this.#socket = opened;
    }
    const socket = this.#socket;
    for (const [conn, sent] of [...this.#viewers]) {
      const frame = sent + 1;
      this.#viewers.set(conn, frame);
      this.watchers.add(conn.remoteIp);
      // No route to the viewer any more (cable pulled): it is gone.
      if (socket.send(conn.remoteIp, STREAM_PORT, { app: 'stream', frame }) !== null) {
        this.#viewers.delete(conn);
        conn.close();
      }
    }
    if (this.#viewers.size > 0) this.#schedule();
    this.changed();
  };

  /** Stops streaming and frees the socket (the device was removed or lost its link). */
  stop(): void {
    this.#cancel();
    this.#viewers.clear();
    this.#socket?.close();
    this.#socket = null;
  }
}
