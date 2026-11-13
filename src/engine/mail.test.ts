import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { fetchMail, parseMbox, sendMail, type MailMessage } from './mail.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string): string[] {
  const lines: string[] = [];
  run(net, device, line, { out: (l) => lines.push(l), exit: () => {} });
  net.scheduler.runUntil(net.scheduler.now + 10);
  return lines;
}

function lab() {
  const net = new Network();
  const alice = net.addDevice('pc', 'alice');
  const bob = net.addDevice('pc', 'bob');
  const mx = net.addDevice('server', 'mail');
  const sw = net.addDevice('switch');
  [alice, bob, mx].forEach((d) => net.connect(d, sw));
  sh(net, alice, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, bob, 'ip addr add 10.0.0.2/24 dev eth0');
  sh(net, mx, 'ip addr add 10.0.0.25/24 dev eth0');
  return { net, alice, bob, mx };
}

function send(net: Network, from: Device, to: string, subject: string, body: string) {
  let result: { ok: boolean; error?: string } | null = null;
  sendMail(
    from,
    { server: '10.0.0.25', from: `${from.name}@lab`, to, subject, body },
    (r) => (result = r),
  );
  net.scheduler.runUntil(net.scheduler.now + 20_000);
  return result;
}

type Fetched = { ok: true; messages: MailMessage[] } | { ok: false; error: string };

function fetch(net: Network, who: Device, user: string): Fetched | null {
  // A box, because TypeScript can't see the callback assign a plain variable.
  const box: { result: Fetched | null } = { result: null };
  fetchMail(who, '10.0.0.25', user, 'secret', (r) => (box.result = r));
  net.scheduler.runUntil(net.scheduler.now + 20_000);
  return box.result;
}

describe('mail', () => {
  it('starts and stops postfix and dovecot', () => {
    const { net, mx } = lab();
    expect(sh(net, mx, 'postfix status')).toEqual([
      'postfix/postfix-script: the Postfix mail system is not running',
    ]);
    expect(sh(net, mx, 'postfix start')).toEqual([
      'postfix/postfix-script: starting the Postfix mail system',
    ]);
    expect(sh(net, mx, 'postfix start')).toEqual([
      'postfix: fatal: the Postfix mail system is already running',
    ]);
    expect(sh(net, mx, 'dovecot')).toEqual([]);
    expect(sh(net, mx, 'ss -tln')).toContain('LISTEN     0.0.0.0:110             0.0.0.0:*');
    expect(sh(net, mx, 'killall dovecot')).toEqual([]);
    expect(sh(net, mx, 'postfix stop')).toEqual([
      'postfix/postfix-script: stopping the Postfix mail system',
    ]);
  });

  it('delivers with SMTP into an mbox and fetches with POP3', () => {
    const { net, alice, bob, mx } = lab();
    sh(net, mx, 'postfix start');
    sh(net, mx, 'dovecot');
    expect(send(net, alice, 'bob@lab', 'Lunch?', 'At noon.\n.hidden dot line')).toEqual({
      ok: true,
    });
    expect(send(net, alice, 'bob@lab', 'Second', 'Two')).toEqual({ ok: true });
    const box = mx.fs?.read('/var/mail/bob') ?? '';
    expect(box.startsWith('From alice@lab ')).toBe(true);
    expect(parseMbox(box).map((m) => m.subject)).toEqual(['Lunch?', 'Second']);
    expect(sh(net, mx, 'cat /var/mail/bob')).toContain('Subject: Lunch?');

    const got = fetch(net, bob, 'bob');
    expect(got).toMatchObject({ ok: true });
    if (!got?.ok) throw new Error('fetch failed');
    expect(got.messages.map((m) => [m.from, m.to, m.subject, m.body])).toEqual([
      ['alice@lab', 'bob@lab', 'Lunch?', 'At noon.\n.hidden dot line'],
      ['alice@lab', 'bob@lab', 'Second', 'Two'],
    ]);
    expect(fetch(net, alice, 'alice')).toEqual({ ok: true, messages: [] });
    // SMTP commands travel as readable TCP data.
    const smtp = net.trace.flatMap((t) => {
      if (t.to.device !== mx.id) return [];
      const p = t.frame.payload;
      return p.kind === 'ipv4' &&
        p.payload.kind === 'tcp' &&
        p.payload.dstPort === 25 &&
        p.payload.data
        ? [p.payload.data.split('\r\n')[0]]
        : [];
    });
    expect(smtp.slice(0, 4)).toEqual([
      'HELO alice',
      'MAIL FROM:<alice@lab>',
      'RCPT TO:<bob@lab>',
      'DATA',
    ]);
    expect(net.scheduler.pending).toBe(0);
  });

  it('explains failures', () => {
    const { net, alice, mx } = lab();
    expect(send(net, alice, 'bob@lab', 'x', 'y')).toEqual({
      ok: false,
      error: 'Could not connect to 10.0.0.25 port 25: Connection refused.',
    });
    sh(net, mx, 'postfix start');
    expect(send(net, alice, 'not an address', 'x', 'y')).toEqual({
      ok: false,
      error: 'The server said: 501 5.1.3 Bad recipient address syntax',
    });
    expect(fetch(net, alice, 'alice')).toEqual({
      ok: false,
      error: 'Could not connect to 10.0.0.25 port 110: Connection refused.',
    });
  });

  it('keeps mailboxes and running mail servers across a save and load', () => {
    const { net, alice, bob, mx } = lab();
    sh(net, mx, 'postfix start');
    sh(net, mx, 'dovecot');
    send(net, alice, 'bob@lab', 'Saved', 'in the file');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    const copyBob = copy.devices.get(bob.id);
    if (!copyBob) throw new Error('missing');
    const got = fetch(copy, copyBob, 'bob');
    expect(got?.ok && got.messages[0]?.subject).toBe('Saved');
  });
});
