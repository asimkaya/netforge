import type { Device } from './device.ts';
import { resolve } from './dns.ts';
import type { FileSystem } from './fs.ts';
import type { IpStack } from './ip.ts';
import { TCP_ERROR_TEXT, type TcpConnection, type TcpError } from './tcp.ts';

export const SMTP_PORT = 25;
export const POP3_PORT = 110;
const CRLF = '\r\n';
/** Mailboxes live in /var/mail/USER, one mbox file per local user. */
export const MAIL_DIR = '/var/mail';

/** Mail addresses here: a simple local part, an @ and a host name. */
export function isEmail(text: string): boolean {
  return /^[a-z0-9._-]{1,64}@[a-z0-9.-]{1,253}$/i.test(text);
}

/** "Mon Jan  1 00:00:05 2026"-style dates from virtual time (the lab starts on 2026-01-01). */
function mboxDate(ms: number): string {
  const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(ms));
  const day = d.toUTCString().slice(0, 3);
  const month = d.toUTCString().slice(8, 11);
  const time = d.toISOString().slice(11, 19);
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2)} ${time} ${d.getUTCFullYear()}`;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/** Splits an mbox file into messages (separated by "From " lines). */
export function parseMbox(text: string): MailMessage[] {
  return text
    .split(/^From \S+ .*\n/m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => parseMessage(chunk));
}

export function parseMessage(raw: string): MailMessage {
  const text = raw.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 2).replace(/\n+$/, '');
  const header = (name: string) =>
    head.match(new RegExp(`^${name}: (.*)$`, 'im'))?.[1]?.trim() ?? '';
  return {
    from: header('From'),
    to: header('To'),
    subject: header('Subject'),
    date: header('Date'),
    body,
  };
}

// ------------------------------------------------------------------ servers

/** `postfix start`: an SMTP server that delivers to local mailboxes by user name. */
export function startSmtp(device: Device, stack: IpStack, fs: FileSystem): (() => void) | string {
  let queued = 0;
  const stop = stack.tcp.listen(SMTP_PORT, (conn) => {
    conn.send(`220 ${device.name} ESMTP Postfix${CRLF}`);
    let from = '';
    let to: string[] = [];
    let data = false;
    const reply = (line: string) => conn.send(`${line}${CRLF}`);
    return {
      onData: (text) => {
        if (data) {
          data = false;
          // Strip the end marker and undo dot-stuffing (".." at a line start means ".").
          const message = text
            .replace(/\r\n\.\r\n$/, '')
            .replace(/\r\n/g, '\n')
            .replace(/^\.\./gm, '.');
          for (const rcpt of to) {
            const user = rcpt.split('@')[0] ?? rcpt;
            const box = `${MAIL_DIR}/${user}`;
            const entry = `From ${from} ${mboxDate(device.fabric.scheduler.now)}\n${message}\n\n`;
            const error = fs.write(box, entry, true);
            if (error) {
              reply('452 4.3.1 Insufficient system storage');
              return;
            }
          }
          reply(
            `250 2.0.0 Ok: queued as ${(++queued).toString(16).toUpperCase().padStart(10, '0')}`,
          );
          return;
        }
        const line = text.replace(/\r?\n$/, '');
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'HELO' || verb === 'EHLO') reply(`250 ${device.name}`);
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply(isEmail(from) ? '250 2.1.0 Ok' : '501 5.1.7 Bad sender address syntax');
        } else if (verb === 'RCPT') {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (!isEmail(rcpt)) reply('501 5.1.3 Bad recipient address syntax');
          else {
            to.push(rcpt);
            reply('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          if (!from || to.length === 0) reply('503 5.5.1 Error: need RCPT command');
          else {
            data = true;
            reply('354 End data with <CR><LF>.<CR><LF>');
          }
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 Bye');
          conn.close();
        } else reply('502 5.5.2 Error: command not recognized');
      },
    };
  });
  return typeof stop === 'string' ? `postfix: fatal: bind 0.0.0.0 port 25: ${stop}` : stop;
}

/** `dovecot`: a POP3 server for the same mailboxes. Any password is accepted. */
export function startPop3(stack: IpStack, fs: FileSystem): (() => void) | string {
  const stop = stack.tcp.listen(POP3_PORT, (conn) => {
    conn.send(`+OK Dovecot ready.${CRLF}`);
    let user = '';
    let messages: string[] | null = null;
    const deleted = new Set<number>();
    const reply = (line: string) => conn.send(`${line}${CRLF}`);
    const box = () => `${MAIL_DIR}/${user}`;
    return {
      onData: (text) => {
        const [verb = '', arg = ''] = text.trim().split(/\s+/);
        const cmd = verb.toUpperCase();
        if (cmd === 'USER') {
          user = arg.split('@')[0] ?? '';
          reply('+OK');
        } else if (cmd === 'PASS') {
          if (!user) reply('-ERR No username given.');
          else {
            // shortcut: no user database, so every password is accepted.
            messages = (fs.read(box()) ?? '').split(/^(?=From \S+ )/m).filter((m) => m.trim());
            reply('+OK Logged in.');
          }
        } else if (cmd === 'QUIT') {
          if (messages && deleted.size > 0) {
            const kept = messages.filter((_, i) => !deleted.has(i + 1));
            if (kept.length) fs.write(box(), kept.join(''));
            else fs.remove(box());
          }
          reply('+OK Logging out.');
          conn.close();
        } else if (!messages) {
          reply('-ERR Unknown command.');
        } else if (cmd === 'STAT') {
          const size = messages.reduce((n, m) => n + m.length, 0);
          reply(`+OK ${messages.length} ${size}`);
        } else if (cmd === 'LIST') {
          const lines = messages.map((m, i) => `${i + 1} ${m.length}`);
          conn.send([`+OK ${messages.length} messages:`, ...lines, '.', ''].join(CRLF));
        } else if (cmd === 'RETR' || cmd === 'DELE') {
          const n = Number(arg);
          const message = messages[n - 1];
          if (!message || deleted.has(n)) reply("-ERR There's no message " + arg + '.');
          else if (cmd === 'DELE') {
            deleted.add(n);
            reply('+OK Marked to be deleted.');
          } else {
            const body = message
              .replace(/^From .*\n/, '')
              .replace(/^\./gm, '..')
              .replace(/\n/g, CRLF);
            conn.send(`+OK ${body.length} octets${CRLF}${body}${CRLF}.${CRLF}`);
          }
        } else reply('-ERR Unknown command.');
      },
    };
  });
  return typeof stop === 'string' ? `dovecot: Fatal: bind(0.0.0.0, 110) failed: ${stop}` : stop;
}

// ------------------------------------------------------------------ clients

type Step = { send: string | null; expect: string };

/**
 * Talks a line-based protocol over TCP: sends each step and checks the reply starts with
 * the expected code. Calls `done` with all replies, or an error message.
 */
function converse(
  device: Device,
  server: string,
  port: number,
  greeting: string,
  steps: Step[],
  done: (result: { ok: true; replies: string[] } | { ok: false; error: string }) => void,
): () => void {
  const stack = device.ip;
  if (!stack) {
    done({ ok: false, error: 'This device has no network stack.' });
    return () => {};
  }
  let conn: TcpConnection | null = null;
  let finished = false;
  const finish = (result: Parameters<typeof done>[0]) => {
    if (finished) return;
    finished = true;
    done(result);
  };
  const cancelLookup = resolve(device, server, (r) => {
    if (!r.ok) {
      finish({ ok: false, error: `Could not resolve the mail server ${server}.` });
      return;
    }
    const replies: string[] = [];
    let step = -1;
    const next = (c: TcpConnection) => {
      step++;
      const current = steps[step];
      if (!current) return;
      if (current.send !== null) c.send(current.send);
    };
    const opened = stack.tcp.connect(r.ip, port, {
      onData: (text, c) => {
        replies.push(text);
        const want = step < 0 ? greeting : (steps[step]?.expect ?? '');
        if (!text.startsWith(want)) {
          finish({ ok: false, error: `The server said: ${text.trim().split(CRLF)[0] ?? ''}` });
          c.close();
          return;
        }
        if (step >= steps.length - 1) {
          finish({ ok: true, replies });
          if (c.state === 'established') c.close();
          return;
        }
        next(c);
      },
      onClose: () => finish({ ok: false, error: 'The server closed the connection.' }),
      onError: (error: TcpError) =>
        finish({
          ok: false,
          error: `Could not connect to ${server} port ${port}: ${TCP_ERROR_TEXT[error]}.`,
        }),
    });
    if (typeof opened === 'string')
      finish({ ok: false, error: `Could not connect to ${server}: ${opened}.` });
    else conn = opened;
  });
  return () => {
    finished = true;
    cancelLookup();
    conn?.close();
  };
}

export interface Outgoing {
  server: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}

/** Sends one message with SMTP. */
export function sendMail(
  device: Device,
  mail: Outgoing,
  done: (result: { ok: true } | { ok: false; error: string }) => void,
): () => void {
  const date = mboxDate(device.fabric.scheduler.now);
  const message = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${date}`,
    '',
    // A line with a single dot would end the message early; SMTP doubles it.
    ...mail.body.split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)),
    '.',
    '',
  ].join(CRLF);
  return converse(
    device,
    mail.server,
    SMTP_PORT,
    '220',
    [
      { send: `HELO ${device.name}${CRLF}`, expect: '250' },
      { send: `MAIL FROM:<${mail.from}>${CRLF}`, expect: '250' },
      { send: `RCPT TO:<${mail.to}>${CRLF}`, expect: '250' },
      { send: `DATA${CRLF}`, expect: '354' },
      { send: message, expect: '250' },
      { send: `QUIT${CRLF}`, expect: '221' },
    ],
    (r) => done(r.ok ? { ok: true } : r),
  );
}

/** Downloads every message of `user` with POP3 (they stay on the server). */
export function fetchMail(
  device: Device,
  server: string,
  user: string,
  password: string,
  done: (result: { ok: true; messages: MailMessage[] } | { ok: false; error: string }) => void,
): () => void {
  let cancel = () => {};
  cancel = converse(
    device,
    server,
    POP3_PORT,
    '+OK',
    [
      { send: `USER ${user}${CRLF}`, expect: '+OK' },
      { send: `PASS ${password}${CRLF}`, expect: '+OK' },
      { send: `STAT${CRLF}`, expect: '+OK' },
      { send: `QUIT${CRLF}`, expect: '+OK' },
    ],
    (r) => {
      if (!r.ok) {
        done(r);
        return;
      }
      const count = Number(r.replies[3]?.split(' ')[1] ?? 0);
      const steps: Step[] = [
        { send: `USER ${user}${CRLF}`, expect: '+OK' },
        { send: `PASS ${password}${CRLF}`, expect: '+OK' },
        ...Array.from({ length: count }, (_, i) => ({
          send: `RETR ${i + 1}${CRLF}`,
          expect: '+OK',
        })),
        { send: `QUIT${CRLF}`, expect: '+OK' },
      ];
      cancel = converse(device, server, POP3_PORT, '+OK', steps, (all) => {
        if (!all.ok) {
          done(all);
          return;
        }
        const messages = all.replies.slice(3, 3 + count).map((reply) =>
          parseMessage(
            reply
              .replace(/^\+OK.*\r\n/, '')
              .replace(/\r\n\.\r\n$/, '')
              .replace(/^\.\./gm, '.'),
          ),
        );
        done({ ok: true, messages });
      });
    },
  );
  return () => cancel();
}
