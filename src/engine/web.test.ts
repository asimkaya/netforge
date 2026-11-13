import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { MAX_FILE_BYTES } from './fs.ts';
import { respond } from './http.ts';
import { Network } from './network.ts';
import { parseLine } from './shell-files.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

function lab() {
  const net = new Network();
  const pc = net.addDevice('pc');
  const srv = net.addDevice('server');
  net.connect(pc, srv);
  sh(net, pc, 'ip addr add 10.0.0.1/24 dev eth0');
  sh(net, srv, 'ip addr add 10.0.0.80/24 dev eth0');
  return { net, pc, srv };
}

describe('shell words and files', () => {
  it('parses quotes and redirection like a shell', () => {
    expect(parseLine(`echo "a  b" 'c "d"' e\\ >out.txt`)).toEqual({
      words: ['echo', 'a  b', 'c "d"', 'e\\'],
      redirect: { path: 'out.txt', append: false },
    });
    expect(parseLine('echo hi >> log')).toEqual({
      words: ['echo', 'hi'],
      redirect: { path: 'log', append: true },
    });
    expect(parseLine('echo "oops')).toBe('bash: unexpected EOF while looking for matching `"\'');
    expect(parseLine('echo >')).toBe("bash: syntax error near unexpected token `newline'");
  });

  it('writes, lists, reads and removes files', () => {
    const { net, pc } = lab();
    expect(sh(net, pc, 'pwd')).toEqual(['/root']);
    sh(net, pc, 'echo "first line" > notes.txt');
    sh(net, pc, 'echo second >> /root/notes.txt');
    expect(sh(net, pc, 'cat notes.txt')).toEqual(['first line', 'second']);
    sh(net, pc, 'mkdir /srv/data');
    sh(net, pc, 'touch /srv/data/empty');
    expect(sh(net, pc, 'ls /srv')).toEqual(['data']);
    expect(sh(net, pc, 'ls -l /srv/data')).toEqual(['-rw-r--r-- 1 root root      0 empty']);
    expect(sh(net, pc, 'ip -c addr > /root/x')).toEqual([]);
    expect(sh(net, pc, 'rm notes.txt')).toEqual([]);
    expect(sh(net, pc, 'cat notes.txt')).toEqual(['cat: notes.txt: No such file or directory']);
    expect(sh(net, pc, 'rm /srv')).toEqual(["rm: cannot remove '/srv': Is a directory"]);
    expect(sh(net, pc, 'cat ../../etc/passwd')).toEqual([
      'cat: ../../etc/passwd: No such file or directory',
    ]);
  });

  it('refuses files that are too big', () => {
    const { pc } = lab();
    expect(pc.fs?.write('/root/big', 'x'.repeat(MAX_FILE_BYTES + 1))).toBe(
      '/root/big: File too large',
    );
  });
});

describe('HTTP', () => {
  it('serves the sample page with httpd and fetches it with curl', () => {
    const { net, pc, srv } = lab();
    expect(sh(net, pc, 'curl 10.0.0.80')).toEqual([
      'curl: (7) Failed to connect to 10.0.0.80 port 80 after 1 ms: Connection refused',
    ]);
    expect(sh(net, srv, 'httpd')).toEqual([]);
    expect(sh(net, srv, 'httpd')).toEqual(['httpd: bind: Address already in use']);
    const page = sh(net, pc, 'curl http://10.0.0.80/');
    expect(page[0]).toBe('<!doctype html>');
    expect(page).toContain('    <h1>It works!</h1>');
    expect(sh(net, pc, 'curl -I 10.0.0.80/index.html').slice(0, 3)).toEqual([
      'HTTP/1.1 200 OK',
      'Server: busybox-httpd',
      'Content-Type: text/html',
    ]);
    expect(sh(net, pc, 'curl -i 10.0.0.80/nope.html')[0]).toBe('HTTP/1.1 404 Not Found');
    expect(net.scheduler.pending).toBe(0);
  });

  it('serves files written from the shell and other ports and folders', () => {
    const { net, pc, srv } = lab();
    sh(net, srv, 'echo "<h1>Hello from srv1</h1>" > /var/www/html/index.html');
    sh(net, srv, 'echo plain > /srv/www/a.txt');
    sh(net, srv, 'httpd -p 8080 -h /srv/www');
    expect(sh(net, pc, 'curl 10.0.0.80:8080/a.txt')).toEqual(['plain']);
    sh(net, srv, 'killall httpd');
    sh(net, srv, 'httpd');
    expect(sh(net, pc, 'curl 10.0.0.80')).toEqual(['<h1>Hello from srv1</h1>']);
    expect(sh(net, srv, 'killall httpd')).toEqual([]);
    expect(sh(net, srv, 'killall httpd')).toEqual(['httpd: no process found']);
  });

  it('never serves files outside its folder', () => {
    const { srv } = lab();
    srv.fs?.write('/root/secret', 'top secret');
    const res = respond(
      srv.fs ?? (undefined as never),
      '/var/www/html',
      'GET /../../root/secret HTTP/1.1\r\n\r\n',
    );
    expect(res.startsWith('HTTP/1.1 404 Not Found')).toBe(true);
    expect(
      respond(srv.fs ?? (undefined as never), '/var/www/html', 'POST / HTTP/1.1\r\n\r\n'),
    ).toMatch(/^HTTP\/1.1 501/);
    expect(respond(srv.fs ?? (undefined as never), '/var/www/html', 'nonsense')).toMatch(
      /^HTTP\/1.1 400/,
    );
  });

  it('resolves names and reports curl errors', () => {
    const { net, pc, srv } = lab();
    sh(net, srv, 'httpd');
    sh(net, srv, 'dnsmasq --address=/www.lab/10.0.0.80');
    sh(net, pc, 'resolvectl dns eth0 10.0.0.80');
    expect(sh(net, pc, 'curl www.lab')).toContain('    <h1>It works!</h1>');
    expect(sh(net, pc, 'curl nope.lab')).toEqual(['curl: (6) Could not resolve host: nope.lab']);
    expect(sh(net, pc, 'curl https://www.lab')).toEqual([
      'curl: (1) Protocol "https" not supported',
    ]);
  });

  it('keeps files and the web server across a save and load', () => {
    const { net, pc, srv } = lab();
    sh(net, srv, 'echo saved > /var/www/html/index.html');
    sh(net, srv, 'httpd -p 80');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    const copyPc = copy.devices.get(pc.id);
    if (!copyPc) throw new Error('missing');
    expect(sh(copy, copyPc, 'curl 10.0.0.80')).toEqual(['saved']);
  });
});
