import { formatIp, parseIp, type Ip } from './addr.ts';
import { dhclient, dhcpRelease } from './dhcp.ts';
import { isHostname, resolve } from './dns.ts';
import { httpGet } from './http.ts';
import { describeFrame } from './packet.ts';
import { TCP_ERROR_TEXT } from './tcp.ts';
import type { Command } from './shell.ts';

/** `dnsmasq [OPTIONS]`: starts the DHCP and DNS server in the background. */
export const dnsmasq: Command = (_net, device, args, io) => {
  if (args.includes('--help')) {
    io.out('Usage: dnsmasq [options]');
    io.out('  --dhcp-range=START,END[,LEASE]       hand out addresses from START to END');
    io.out('  --dhcp-option=option:router,IP       default gateway for clients');
    io.out('  --dhcp-option=option:dns-server,IP   name server for clients');
    io.out('  --address=/NAME/IP                   answer DNS queries for NAME with IP');
    io.out('  --host-record=NAME,IP                same as --address');
    io.out('Stop it with: killall dnsmasq');
    return;
  }
  const result = device.startDnsmasq(args);
  if (typeof result === 'string') io.out(result);
  else result.forEach((line) => io.out(line));
};

/** `killall NAME`: dnsmasq and httpd are the background services in NetForge. */
export const killall: Command = (_net, device, args, io) => {
  const [name] = args;
  if (name === undefined) {
    io.out('Usage: killall NAME');
    return;
  }
  const stopped =
    name === 'dnsmasq'
      ? device.stopDnsmasq()
      : name === 'httpd'
        ? device.stopHttpd()
        : name === 'dovecot' || name === 'postfix'
          ? device.stopMail(name)
          : false;
  if (!stopped) io.out(`${name}: no process found`);
};

/** `dhclient [-r] [-v] IF`: gets (or releases) an address with DHCP. */
export const dhclientCommand: Command = (_net, device, args, io) => {
  const release = args.includes('-r');
  const names = args.filter((a) => !a.startsWith('-'));
  const name = names[0] ?? device.ip?.ports[0]?.name;
  const port = name === undefined ? undefined : device.port(name);
  if (!device.ip) {
    io.out('dhclient: command not found');
    return;
  }
  if (!port) {
    io.out(`Cannot find device "${name ?? ''}"`);
    return;
  }
  if (release) {
    dhcpRelease(device, port, io);
    return;
  }
  const started = dhclient(device, port, io);
  if (typeof started === 'string') {
    io.out(started);
    return;
  }
  return { interrupt: started };
};

/** `resolvectl [status | dns [IF [SERVER...]] | revert IF | query NAME]`. */
export const resolvectl: Command = (_net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('resolvectl: command not found');
    return;
  }
  const [verb = 'status', ifName, ...servers] = args;
  const list = () => stack.dns.map(formatIp).join(' ');
  if (verb === 'status') {
    io.out('Global');
    io.out(`  DNS Servers: ${list()}`);
    return;
  }
  if (verb === 'dns' || verb === 'revert') {
    if (ifName === undefined) {
      io.out(`Global: ${list()}`);
      return;
    }
    if (!device.port(ifName)) {
      io.out(`Failed to resolve interface "${ifName}": No such device`);
      return;
    }
    if (verb === 'revert') {
      stack.setDns([]);
      return;
    }
    if (servers.length === 0) {
      io.out(`Link (${ifName}): ${list()}`);
      return;
    }
    const parsed = servers.map((text) => parseIp(text));
    const bad = servers.find((_, i) => parsed[i] === null);
    if (bad !== undefined) {
      io.out(`Failed to parse DNS server address: ${bad}`);
      return;
    }
    stack.setDns(parsed.filter((ip): ip is Ip => ip !== null));
    return;
  }
  if (verb === 'query') {
    if (ifName === undefined) {
      io.out('resolvectl: query: missing name');
      return;
    }
    let sync = true;
    let finished = false;
    const cancel = resolve(device, ifName, (r) => {
      finished = true;
      if (r.ok) {
        io.out(`${ifName}: ${formatIp(r.ip)}`);
        io.out('');
        io.out(`-- Information acquired via protocol DNS in ${r.rtt.toFixed(1)}ms.`);
      } else {
        io.out(
          `${ifName}: ${r.error === 'nxdomain' ? `resolve call failed: '${ifName}' not found` : 'resolve call failed: All attempts to contact name servers or networks failed'}`,
        );
      }
      if (!sync) io.exit();
    });
    sync = false;
    if (finished) return;
    return {
      interrupt: () => {
        cancel();
        io.exit();
      },
    };
  }
  io.out(`Unknown command verb '${verb}'.`);
};

/** `dig [@SERVER] [+short] NAME`: asks a name server, prints its answer like dig. */
export const dig: Command = (_net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('dig: command not found');
    return;
  }
  let short = false;
  let server: Ip | undefined;
  let name: string | undefined;
  for (const arg of args) {
    if (arg === '+short') short = true;
    else if (arg.startsWith('@')) {
      const ip = parseIp(arg.slice(1));
      if (ip === null) {
        io.out(`dig: couldn't get address for '${arg.slice(1)}': not found`);
        return;
      }
      server = ip;
    } else if (arg.startsWith('+') || arg.startsWith('-')) {
      io.out(`Invalid option: ${arg}`);
      return;
    } else name = arg;
  }
  if (name === undefined) {
    io.out('Usage: dig [@server] [+short] name');
    return;
  }
  if (!isHostname(name)) {
    io.out(`dig: '${name}' is not a legal name (unexpected end of input)`);
    return;
  }
  const fqdn = `${name.replace(/\.$/, '')}.`;
  const target = server ?? stack.dns[0];
  if (target === undefined) {
    io.out(';; no servers could be reached');
    return;
  }
  let sync = true;
  let finished = false;
  const cancel = resolve(
    device,
    fqdn.slice(0, -1),
    (r) => {
      finished = true;
      const at = `${formatIp(target)}#53`;
      if (!r.ok && (r.error === 'timeout' || r.error === 'refused')) {
        const what = r.error === 'timeout' ? 'timed out' : 'connection refused';
        io.out(`;; communications error to ${at}: ${what}`);
        io.out(';; no servers could be reached');
      } else if (short) {
        if (r.ok) io.out(formatIp(r.ip));
      } else {
        const status = r.ok ? 'NOERROR' : 'NXDOMAIN';
        io.out(`; <<>> DiG 9.18 <<>> ${args.join(' ')}`);
        io.out(';; Got answer:');
        io.out(`;; ->>HEADER<<- opcode: QUERY, status: ${status}`);
        io.out('');
        io.out(';; QUESTION SECTION:');
        io.out(`;${fqdn}\t\t\tIN\tA`);
        if (r.ok) {
          io.out('');
          io.out(';; ANSWER SECTION:');
          io.out(`${fqdn}\t\t0\tIN\tA\t${formatIp(r.ip)}`);
        }
        io.out('');
        io.out(`;; Query time: ${r.ok ? Math.round(r.rtt) : 0} msec`);
        io.out(`;; SERVER: ${at}(${formatIp(target)}) (UDP)`);
      }
      if (!sync) io.exit();
    },
    target,
  );
  sync = false;
  if (finished) return;
  return {
    interrupt: () => {
      cancel();
      io.exit();
    },
  };
};

const SERVICE_NAMES: Record<number, string> = { 22: 'ssh', 25: 'smtp', 80: 'http', 110: 'pop3' };

/** `nc -z HOST PORT`: checks whether a TCP port accepts connections. */
export const nc: Command = (_net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('nc: command not found');
    return;
  }
  const words = args.filter((a) => !a.startsWith('-'));
  const [host, portText] = words;
  const port = Number(portText);
  if (
    !args.includes('-z') ||
    host === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    io.out('usage: nc -z [-v] HOST PORT');
    return;
  }
  let finished = false;
  let sync = true;
  let cancel = () => {};
  const done = () => {
    finished = true;
    if (!sync) io.exit();
  };
  cancel = resolve(device, host, (r) => {
    if (!r.ok) {
      io.out(`nc: getaddrinfo for host "${host}" port ${port}: Name or service not known`);
      done();
      return;
    }
    const name = SERVICE_NAMES[port] ?? '*';
    const conn = stack.tcp.connect(r.ip, port, {
      onOpen: (c) => {
        io.out(`Connection to ${host} (${formatIp(r.ip)}) ${port} port [tcp/${name}] succeeded!`);
        c.close();
        done();
      },
      onData: () => {},
      onError: (error) => {
        io.out(
          `nc: connect to ${host} (${formatIp(r.ip)}) port ${port} (tcp) failed: ${TCP_ERROR_TEXT[error]}`,
        );
        done();
      },
    });
    if (typeof conn === 'string') {
      io.out(`nc: connect to ${host} port ${port} (tcp) failed: ${conn}`);
      done();
      return;
    }
    cancel = () => conn.close();
  });
  sync = false;
  if (finished) return;
  return {
    interrupt: () => {
      cancel();
      io.exit();
    },
  };
};

/** `ss -t[ln]`: TCP sockets, listening and connected. */
export const ss: Command = (_net, device, _args, io) => {
  const stack = device.ip;
  if (!stack) return;
  io.out('State      Local Address:Port      Peer Address:Port');
  for (const port of stack.tcp.listeningPorts()) {
    io.out(`LISTEN     ${`0.0.0.0:${port}`.padEnd(24)}0.0.0.0:*`);
  }
  for (const c of stack.tcp.connections()) {
    const state =
      c.state === 'established' ? 'ESTAB' : c.state === 'syn-sent' ? 'SYN-SENT' : 'FIN-WAIT';
    const local = `${formatIp(c.localIp)}:${c.localPort}`;
    io.out(`${state.padEnd(11)}${local.padEnd(24)}${formatIp(c.remoteIp)}:${c.remotePort}`);
  }
};

/** `httpd [-p PORT] [-h HOME] [-f]`: starts the web server in the background. */
export const httpd: Command = (_net, device, args, io) => {
  const error = device.startHttpd(args);
  if (error) io.out(error);
};

/** `curl [-i] [-I] [-s] URL`: fetches a page over HTTP and prints it. */
export const curl: Command = (_net, device, args, io) => {
  if (!device.ip) {
    io.out('curl: command not found');
    return;
  }
  const include = args.includes('-i');
  const head = args.includes('-I');
  const url = args.find((a) => !a.startsWith('-'));
  if (url === undefined) {
    io.out("curl: try 'curl --help' for more information");
    return;
  }
  if (/^[a-z]+:\/\//i.test(url) && !url.toLowerCase().startsWith('http://')) {
    io.out(`curl: (1) Protocol "${url.split(':')[0] ?? ''}" not supported`);
    return;
  }
  let sync = true;
  let finished = false;
  const cancel = httpGet(
    device,
    url,
    (result) => {
      finished = true;
      if (!result.ok) io.out(`curl: (${result.code}) ${result.error}`);
      else {
        const text = include || head ? result.response.raw : result.response.body;
        text
          .replace(/\r/g, '')
          .replace(/\n$/, '')
          .split('\n')
          .forEach((line) => io.out(line));
      }
      if (!sync) io.exit();
    },
    head ? 'HEAD' : 'GET',
  );
  sync = false;
  if (finished) return;
  return {
    interrupt: () => {
      cancel();
      io.exit();
    },
  };
};

/** `postfix start|stop|status`: the SMTP server (port 25). */
export const postfix: Command = (_net, device, args, io) => {
  const [verb] = args;
  if (verb === 'start') {
    const error = device.startMail('postfix');
    io.out(error ?? 'postfix/postfix-script: starting the Postfix mail system');
  } else if (verb === 'stop') {
    if (device.stopMail('postfix'))
      io.out('postfix/postfix-script: stopping the Postfix mail system');
    else io.out('postfix/postfix-script: fatal: the Postfix mail system is not running');
  } else if (verb === 'status') {
    io.out(
      device.postfix
        ? 'postfix/postfix-script: the Postfix mail system is running'
        : 'postfix/postfix-script: the Postfix mail system is not running',
    );
  } else io.out('usage: postfix start|stop|status');
};

/** `dovecot`: the POP3 server (port 110); `killall dovecot` stops it. */
export const dovecot: Command = (_net, device, _args, io) => {
  const error = device.startMail('dovecot');
  if (error) io.out(error);
};

/** Virtual time as tcpdump prints it: HH:MM:SS.microseconds. */
function stamp(ms: number): string {
  const us = Math.round(ms * 1000);
  const s = Math.floor(us / 1_000_000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${String(us % 1_000_000).padStart(6, '0')}`;
}

/** `tcpdump [-i IF] [-c COUNT] [-n]`: prints frames this device sends and receives. */
export const tcpdump: Command = (net, device, args, io) => {
  let iface: string | undefined;
  let count = Infinity;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i') iface = args[++i];
    else if (arg === '-c') {
      count = Number(args[++i]);
      if (!Number.isInteger(count) || count < 1) {
        io.out(`tcpdump: invalid packet count ${args[i] ?? ''}`);
        return;
      }
    } else if (arg !== '-n' && arg !== '-nn' && arg !== '-v') {
      io.out(`tcpdump: unsupported option or filter '${arg ?? ''}'`);
      return;
    }
  }
  if (iface !== undefined && iface !== 'any' && !device.port(iface)) {
    io.out(`tcpdump: ${iface}: No such device exists`);
    return;
  }
  const name = iface ?? device.ports[0]?.name ?? 'any';
  io.out('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode');
  io.out(`listening on ${name}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`);
  let last = net.trace.at(-1)?.seq ?? 0;
  let captured = 0;
  let done = false;
  const matches = (end: { device: string; port: string }) =>
    end.device === device.id && (iface === undefined || iface === 'any' || end.port === iface);
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    io.out('');
    io.out(`${captured} packet${captured === 1 ? '' : 's'} captured`);
    io.out(`${captured} packet${captured === 1 ? '' : 's'} received by filter`);
    io.out('0 packets dropped by kernel');
    io.exit();
  };
  const unsubscribe = net.subscribe(() => {
    if (done) return;
    for (const entry of net.trace) {
      if (entry.seq <= last) continue;
      last = entry.seq;
      if (!matches(entry.from) && !matches(entry.to)) continue;
      captured++;
      io.out(`${stamp(entry.time)} ${describeFrame(entry.frame)}`);
      if (captured >= count) {
        finish();
        return;
      }
    }
  });
  return { interrupt: finish };
};
