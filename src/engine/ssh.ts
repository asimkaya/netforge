import { formatIp, type Ip } from './addr.ts';
import type { Device } from './device.ts';
import type { FileSystem } from './fs.ts';
import type { IpStack } from './ip.ts';
import type { Network } from './network.ts';
import type { Process, ShellIO } from './shell.ts';
import { TCP_ERROR_TEXT, type TcpConnection } from './tcp.ts';

/**
 * SSH: `sshd` on TCP port 22 and an interactive `ssh` client. After the version banners
 * everything is sealed, so captures show "Encrypted packet". Simplified: no host key
 * check or known_hosts, password login only, one session per connection, and the
 * "encryption" is a reversible scramble (it hides the text, it does not protect it).
 */

export const SSH_PORT = 22;
export const BANNER = 'SSH-2.0-OpenSSH_9.6';
export const SHADOW = '/etc/shadow';
/** Root's password until it is changed with chpasswd (documented in FEATURES.md). */
export const DEFAULT_PASSWORD = 'netforge';

type Message =
  | { t: 'auth'; user: string; password: string }
  | { t: 'ok'; host: string }
  | { t: 'denied' }
  | { t: 'cmd'; line: string }
  | { t: 'out'; line: string }
  | { t: 'done' }
  | { t: 'int' }
  | { t: 'exit' };

/** Seals a message (a stand-in for encryption: the bytes no longer read as text). */
export function seal(m: Message): string {
  return [...JSON.stringify(m)].map((c) => String.fromCharCode(c.charCodeAt(0) ^ 0x2a)).join('');
}

function open(text: string): Message | null {
  try {
    const json = [...text].map((c) => String.fromCharCode(c.charCodeAt(0) ^ 0x2a)).join('');
    return JSON.parse(json) as Message;
  } catch {
    return null;
  }
}

/** A stand-in for crypt(3): a salted, non-reversible digest in shadow format. */
export function hashPassword(password: string): string {
  let h = 0x811c9dc5;
  for (const c of `netforge:${password}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `$6$netforge$${h.toString(16).padStart(8, '0')}`;
}

function checkPassword(fs: FileSystem, user: string, password: string): boolean {
  const shadow = fs.read(SHADOW);
  const line = shadow?.split('\n').find((l) => l.startsWith(`${user}:`));
  if (!line) return user === 'root' && password === DEFAULT_PASSWORD;
  return line.split(':')[1] === hashPassword(password);
}

/** Sets passwords from `user:password` lines (chpasswd). */
export function setPasswords(fs: FileSystem, lines: readonly string[]): string | null {
  const shadow = (fs.read(SHADOW) ?? '').split('\n').filter(Boolean);
  for (const line of lines) {
    const [user, password] = line.split(':');
    if (!user || password === undefined) return `chpasswd: line 1: missing new password`;
    const entry = `${user}:${hashPassword(password)}:19723:0:99999:7:::`;
    const i = shadow.findIndex((l) => l.startsWith(`${user}:`));
    if (i >= 0) shadow[i] = entry;
    else shadow.push(entry);
  }
  return fs.write(SHADOW, `${shadow.join('\n')}\n`);
}

/**
 * Starts sshd on a device. `runLine` runs a command line in the device's shell. Returns a
 * stop function, or an error message.
 */
export function startSshd(
  device: Device,
  stack: IpStack,
  fs: FileSystem,
  runLine: (line: string, io: ShellIO) => Process | undefined,
): (() => void) | string {
  const stop = stack.tcp.listen(SSH_PORT, (conn) => {
    let user: string | null = null;
    let tries = 0;
    let running: Process | null = null;
    conn.send(BANNER);
    return {
      onData: (text) => {
        if (text.startsWith('SSH-')) return;
        const m = open(text);
        if (!m) return;
        if (m.t === 'auth') {
          if (checkPassword(fs, m.user, m.password)) {
            user = m.user;
            conn.send(seal({ t: 'ok', host: device.name }));
          } else {
            conn.send(seal({ t: 'denied' }));
            if (++tries >= 3) conn.close();
          }
        } else if (m.t === 'cmd' && user) {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            running = null;
            conn.send(seal({ t: 'done' }));
          };
          const proc = runLine(m.line, {
            out: (line) => conn.send(seal({ t: 'out', line })),
            exit: finish,
          });
          if (proc) running = proc;
          else finish();
        } else if (m.t === 'int') {
          running?.interrupt();
        } else if (m.t === 'exit') {
          running?.interrupt();
          conn.close();
        }
      },
      onClose: () => running?.interrupt(),
    };
  });
  return typeof stop === 'string' ? `sshd: error: Bind to port 22 failed: ${stop}.` : stop;
}

/** `ssh [-p PORT] [user@]host [command]`: an interactive remote shell. */
export function sshClient(
  net: Network,
  device: Device,
  target: { user: string; host: string; ip: Ip; port: number; command: string | null },
  io: ShellIO,
): Process | undefined {
  const stack = device.ip;
  if (!stack) {
    io.out('ssh: command not found');
    return undefined;
  }
  type Phase = 'connecting' | 'password' | 'authenticating' | 'shell' | 'running' | 'closed';
  let phase: Phase = 'connecting';
  let remoteHost = target.host;
  let tries = 0;
  const shown = `${target.user}@${target.host}`;
  let conn: TcpConnection | null = null;

  const end = (line?: string) => {
    if (phase === 'closed') return;
    phase = 'closed';
    if (line) io.out(line);
    io.exit();
  };

  const opened = stack.tcp.connect(target.ip, target.port, {
    onData: (text) => {
      if (text.startsWith('SSH-')) {
        // Banners exchanged; the server now waits for credentials.
        conn?.send(BANNER);
        phase = 'password';
        net.changed();
        return;
      }
      const m = open(text);
      if (!m) return;
      if (m.t === 'denied') {
        tries++;
        io.out(
          tries >= 3
            ? `${shown}: Permission denied (publickey,password).`
            : 'Permission denied, please try again.',
        );
        phase = tries >= 3 ? 'closed' : 'password';
        if (tries >= 3) io.exit();
        net.changed();
      } else if (m.t === 'ok') {
        remoteHost = m.host;
        if (target.command !== null) {
          phase = 'running';
          conn?.send(seal({ t: 'cmd', line: target.command }));
        } else {
          io.out('Welcome to NetForge (a simulated Linux system).');
          io.out(`Last login: from ${formatIp(conn?.localIp ?? 0)}`);
          phase = 'shell';
        }
        net.changed();
      } else if (m.t === 'out') {
        io.out(m.line);
      } else if (m.t === 'done') {
        if (target.command !== null) {
          conn?.close();
          end();
        } else {
          phase = 'shell';
          net.changed();
        }
      }
    },
    onClose: () => {
      if (phase === 'closed') return;
      const loggedIn = phase === 'shell' || phase === 'running';
      if (target.command === null && loggedIn) io.out('logout');
      end(`Connection to ${target.host} closed${loggedIn ? '' : ' by remote host'}.`);
    },
    onError: (error) =>
      end(`ssh: connect to host ${target.host} port ${target.port}: ${TCP_ERROR_TEXT[error]}`),
  });
  if (typeof opened === 'string') {
    io.out(`ssh: connect to host ${target.host} port ${target.port}: ${opened}`);
    return undefined;
  }
  conn = opened;

  return {
    interrupt: () => {
      conn?.close();
      end();
    },
    signal: () => {
      if (phase === 'running') conn?.send(seal({ t: 'int' }));
    },
    prompt: () => {
      if (phase === 'password') return `${shown}'s password: `;
      if (phase === 'shell') return `${target.user}@${remoteHost}:~# `;
      return null;
    },
    secret: () => phase === 'password',
    input: (line) => {
      if (phase === 'password') {
        phase = 'authenticating';
        conn?.send(seal({ t: 'auth', user: target.user, password: line }));
      } else if (phase === 'shell') {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed === 'exit' || trimmed === 'logout') {
          conn?.send(seal({ t: 'exit' }));
          return;
        }
        phase = 'running';
        conn?.send(seal({ t: 'cmd', line: trimmed }));
      }
      net.changed();
    },
  };
}
