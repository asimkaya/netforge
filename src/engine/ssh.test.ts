import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { describeFrame } from './packet.ts';
import { run, type Process } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

const wait = (net: Network, ms = 100) => net.scheduler.runUntil(net.scheduler.now + ms);

/** Starts an interactive command and returns a handle to type into it. */
function session(net: Network, device: Device, line: string) {
  const lines: string[] = [];
  const state = { exited: false };
  const proc = run(net, device, line, {
    out: (l) => lines.push(l),
    exit: () => (state.exited = true),
  }) as Process;
  wait(net);
  return {
    lines,
    state,
    proc,
    type(text: string) {
      proc.input?.(text);
      wait(net, 3000);
    },
  };
}

function lab() {
  const net = new Network();
  const [pc, srv] = [net.addDevice('pc'), net.addDevice('server')];
  net.connect(pc, srv);
  sh(net, pc, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, srv, 'ip addr add 10.0.0.2/24 dev eth0');
  return { net, pc, srv };
}

describe('SSH', () => {
  it('is refused until sshd runs', () => {
    const { net, pc } = lab();
    expect(sh(net, pc, 'ssh root@10.0.0.2')).toEqual([
      'ssh: connect to host 10.0.0.2 port 22: Connection refused',
    ]);
    expect(sh(net, pc, 'ssh root@nowhere')).toEqual([
      'ssh: Could not resolve hostname nowhere: Temporary failure in name resolution',
    ]);
  });

  it('logs in with a password and runs commands on the other device', () => {
    const { net, pc, srv } = lab();
    expect(sh(net, srv, 'sshd')).toEqual([]);
    const s = session(net, pc, 'ssh root@10.0.0.2');
    expect(s.proc.prompt?.()).toBe("root@10.0.0.2's password: ");
    expect(s.proc.secret?.()).toBe(true);
    s.type('wrong');
    expect(s.lines).toEqual(['Permission denied, please try again.']);
    s.type('netforge');
    expect(s.lines.slice(1)).toEqual([
      'Welcome to NetForge (a simulated Linux system).',
      'Last login: from 10.0.0.1',
    ]);
    expect(s.proc.prompt?.()).toBe('root@srv1:~# ');
    s.type('hostname');
    expect(s.lines.at(-1)).toBe('srv1');
    s.type('ping -c 1 10.0.0.1');
    expect(s.lines.at(-1)).toMatch(/^rtt min/);
    // What crosses the wire is sealed after the version banners.
    const ssh = net.trace.filter((e) => describeFrame(e.frame).includes(': SSH: '));
    expect(ssh.slice(0, 2).map((e) => describeFrame(e.frame).split(': SSH: ')[1])).toEqual([
      'SSH-2.0-OpenSSH_9.6',
      'SSH-2.0-OpenSSH_9.6',
    ]);
    expect(ssh.slice(2).every((e) => describeFrame(e.frame).includes('Encrypted packet'))).toBe(
      true,
    );
    s.type('exit');
    expect(s.lines.slice(-2)).toEqual(['logout', 'Connection to 10.0.0.2 closed.']);
    expect(s.state.exited).toBe(true);
  });

  it('runs one command, passes Ctrl+C on, and follows a changed password', () => {
    const { net, pc, srv } = lab();
    sh(net, srv, 'sshd');
    sh(net, srv, 'echo root:s3cret | chpasswd');
    expect(srv.fs?.read('/etc/shadow')).toMatch(/^root:\$6\$netforge\$[0-9a-f]{8}:/);
    const one = session(net, pc, 'ssh 10.0.0.2 ip -4 addr');
    one.type('s3cret');
    expect(one.lines).toContain('    inet 10.0.0.2/24 brd 10.0.0.255 scope global eth0');
    expect(one.state.exited).toBe(true);
    const s = session(net, pc, 'ssh root@10.0.0.2');
    s.type('s3cret');
    s.proc.input?.('ping 10.0.0.1');
    wait(net, 2500);
    s.proc.signal?.();
    wait(net);
    expect(s.lines.some((l) => l.includes('packets transmitted'))).toBe(true);
    expect(s.proc.prompt?.()).toBe('root@srv1:~# ');
    s.proc.interrupt();
    expect(s.state.exited).toBe(true);
    const locked = session(net, pc, 'ssh root@10.0.0.2');
    for (const pw of ['a', 'b', 'c']) locked.type(pw);
    expect(locked.lines.at(-1)).toBe('root@10.0.0.2: Permission denied (publickey,password).');
  });

  it('keeps sshd running across a save and load', () => {
    const { net, pc, srv } = lab();
    sh(net, srv, 'sshd');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    expect(copy.devices.get(srv.id)?.sshd).not.toBeNull();
    const s = session(copy, copy.devices.get(pc.id) ?? pc, 'ssh root@10.0.0.2');
    expect(s.proc.prompt?.()).toBe("root@10.0.0.2's password: ");
    expect(sh(copy, copy.devices.get(srv.id) ?? srv, 'killall sshd')).toEqual([]);
  });
});
