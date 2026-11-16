import type { Ip } from './addr.ts';
import type { Device } from './device.ts';
import { resolve } from './dns.ts';
import type { FileSystem } from './fs.ts';
import { normalizePath } from './fs.ts';
import type { IpStack } from './ip.ts';
import { TCP_ERROR_TEXT, type TcpError } from './tcp.ts';

export const HTTP_PORT = 80;
const CRLF = '\r\n';

export interface HttpdConfig {
  port: number;
  home: string;
}

/** Parses busybox httpd options: `-p PORT`, `-h HOME`, `-f` (foreground, ignored). */
export function parseHttpdArgs(args: readonly string[]): HttpdConfig | string {
  const config: HttpdConfig = { port: HTTP_PORT, home: '/var/www/html' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '-p') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return `httpd: bad port '${value ?? ''}'`;
      config.port = port;
      i++;
    } else if (arg === '-h') {
      const home = value === undefined ? null : normalizePath(value);
      if (home === null) return `httpd: bad home directory '${value ?? ''}'`;
      config.home = home;
      i++;
    } else if (arg !== '-f') {
      return `httpd: invalid option -- '${arg ?? ''}'`;
    }
  }
  return config;
}

const STATUS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  404: 'Not Found',
  501: 'Not Implemented',
};

function contentType(path: string): string {
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  return 'text/plain';
}

/** Builds the response to one HTTP request, served from `home` on `fs`. */
export function respond(fs: FileSystem, home: string, request: string): string {
  const [line = ''] = request.split(CRLF);
  const [method, target] = line.split(' ');
  const reply = (code: number, body: string, type = 'text/html', head = false) =>
    [
      `HTTP/1.1 ${code} ${STATUS[code] ?? ''}`,
      'Server: busybox-httpd',
      `Content-Type: ${type}`,
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      head ? '' : body,
    ].join(CRLF);
  const page = (code: number) =>
    `<HTML><HEAD><TITLE>${code} ${STATUS[code]}</TITLE></HEAD>\n<BODY><H1>${code} ${STATUS[code]}</H1></BODY></HTML>\n`;
  if (!method || !target?.startsWith('/')) return reply(400, page(400));
  if (method !== 'GET' && method !== 'HEAD') return reply(501, page(501));
  let relative: string;
  try {
    relative = decodeURIComponent(target.split('?')[0] ?? '/').replace(/^\/+/, '');
  } catch {
    return reply(400, page(400)); // a broken escape such as `/%`
  }
  let path = normalizePath(relative || '.', home);
  if (path !== null && fs.isDir(path)) path = `${path === '/' ? '' : path}/index.html`;
  // Inside `home` only: `/var/www/html2` is not inside `/var/www/html`.
  const inside = (p: string) => home === '/' || p === home || p.startsWith(`${home}/`);
  const body = path !== null && inside(path) ? fs.read(path) : undefined;
  if (body === undefined) return reply(404, page(404), 'text/html', method === 'HEAD');
  return reply(200, body, contentType(path ?? ''), method === 'HEAD');
}

/** A busybox-style web server: serves files from a directory over HTTP/1.1. */
export class Httpd {
  private constructor(
    readonly config: HttpdConfig,
    readonly args: readonly string[],
    readonly stop: () => void,
  ) {}

  static start(stack: IpStack, fs: FileSystem, args: readonly string[]): Httpd | string {
    const config = parseHttpdArgs(args);
    if (typeof config === 'string') return config;
    const stop = stack.tcp.listen(config.port, () => ({
      onData: (request, conn) => {
        conn.send(respond(fs, config.home, request));
        conn.close();
      },
    }));
    if (typeof stop === 'string') return `httpd: bind: ${stop}`;
    return new Httpd(config, [...args], stop);
  }
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** The raw response text, for `curl -i`. */
  raw: string;
}

export type HttpResult =
  { ok: true; ip: Ip; response: HttpResponse } | { ok: false; error: string; code: number };

export interface ParsedUrl {
  host: string;
  port: number;
  path: string;
}

export function parseUrl(text: string): ParsedUrl | null {
  const m = /^(?:http:\/\/)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[^\s]*)?$/.exec(text.trim());
  if (!m?.[1]) return null;
  const port = m[2] === undefined ? HTTP_PORT : Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port, path: m[3] ?? '/' };
}

function parseResponse(raw: string): HttpResponse {
  const split = raw.indexOf(CRLF + CRLF);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split + 4);
  const [status = '', ...lines] = head.split(CRLF);
  const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(status);
  return {
    status: Number(m?.[1] ?? 0),
    statusText: m?.[2] ?? '',
    headers: lines.map((l): [string, string] => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
    body,
    raw,
  };
}

/**
 * GETs `url` (resolving the host name with DNS) and calls `done` once with the response or a
 * curl-style error. Returns a cancel function.
 */
export function httpGet(
  device: Device,
  url: string,
  done: (result: HttpResult) => void,
  method: 'GET' | 'HEAD' = 'GET',
): () => void {
  const stack = device.ip;
  const parsed = parseUrl(url);
  if (!stack || !parsed) {
    done({ ok: false, error: `URL rejected: Bad hostname`, code: 3 });
    return () => {};
  }
  const { host, port, path } = parsed;
  let cancelled = false;
  let close = () => {};
  const startedAt = device.fabric.scheduler.now;
  const cancelLookup = resolve(device, host, (r) => {
    if (cancelled) return;
    if (!r.ok) {
      done({ ok: false, error: `Could not resolve host: ${host}`, code: 6 });
      return;
    }
    let raw = '';
    let failed = false;
    const fail = (error: TcpError | string) => {
      failed = true;
      const ms = Math.round(device.fabric.scheduler.now - startedAt);
      const why = Object.hasOwn(TCP_ERROR_TEXT, error) ? TCP_ERROR_TEXT[error as TcpError] : error;
      const timeout = error === 'timeout';
      done({
        ok: false,
        error: `Failed to connect to ${host} port ${port} after ${ms} ms: ${why}`,
        code: timeout ? 28 : 7,
      });
    };
    const conn = stack.tcp.connect(r.ip, port, {
      onOpen: (c) => {
        c.send(
          [
            `${method} ${path} HTTP/1.1`,
            `Host: ${host}`,
            'User-Agent: curl/8.5.0',
            'Accept: */*',
            '',
            '',
          ].join(CRLF),
        );
      },
      onData: (text) => {
        raw += text;
      },
      onClose: () => {
        if (!failed && !cancelled) done({ ok: true, ip: r.ip, response: parseResponse(raw) });
      },
      onError: (error) => {
        if (!cancelled) fail(error);
      },
    });
    if (typeof conn === 'string') {
      fail(conn);
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
