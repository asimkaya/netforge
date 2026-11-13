import { broadcastOf, formatCidr, formatIp, networkOf, parseCidr, parseIp } from './addr.ts';
import type { Device } from './device.ts';
import type { Network } from './network.ts';
import { hasCarrier, type Port } from './port.ts';

export interface ShellIO {
  /** Writes one line of output. */
  out(line: string): void;
  /** Signals that a long-running command finished. */
  exit(): void;
}

/** A running command (e.g. `ping`). */
export interface Process {
  /** Stops the command, like Ctrl+C. */
  interrupt(): void;
}

type Command = (net: Network, device: Device, args: string[], io: ShellIO) => Process | undefined;

const HELP = [
  'Available commands:',
  '  ip addr [show [dev IF]]            show addresses',
  '  ip addr add|del ADDR/LEN dev IF    add or remove an IPv4 address',
  '  ip addr flush dev IF               remove all addresses from IF',
  '  ip link [show [dev IF]]            show interfaces',
  '  ip link set [dev] IF up|down       enable or disable an interface',
  '  ip neigh [show] | flush all|dev IF show or clear the ARP table',
  '  ip route [show]                    show the routing table',
  '  ping [-c COUNT] ADDR               send ICMP echo requests (Ctrl+C stops)',
  '  bridge fdb [show]                  show learned MAC addresses (switches)',
  '  hostname [NAME]                    show or set the device name',
  '  clear                              clear the screen',
];

/** `ip` accepts any unambiguous prefix of an object or verb, e.g. `ip a`, `ip n`. */
function matches(word: string | undefined, full: string): boolean {
  return word !== undefined && word.length > 0 && full.startsWith(word);
}

function findPort(device: Device, name: string | undefined, io: ShellIO): Port | null {
  const port = name === undefined ? undefined : device.port(name);
  if (!port) io.out(`Cannot find device "${name ?? ''}"`);
  return port ?? null;
}

/** Reads `[dev] IF` style arguments: returns the value after `dev`, or the first bare word. */
function devArg(args: string[]): string | undefined {
  const i = args.indexOf('dev');
  return i >= 0 ? args[i + 1] : args[0];
}

function linkLines(device: Device, port: Port, index: number): string[] {
  const carrier = hasCarrier(port);
  const flags = [
    'BROADCAST',
    'MULTICAST',
    ...(port.adminUp ? ['UP'] : []),
    ...(carrier ? ['LOWER_UP'] : []),
  ];
  const noCarrier = port.adminUp && !carrier ? 'NO-CARRIER,' : '';
  const state = carrier ? 'UP' : 'DOWN';
  const master = device.bridge?.owns(port) ? ' master br0' : '';
  return [
    `${index + 1}: ${port.name}: <${noCarrier}${flags.join(',')}> mtu 1500${master} state ${state}`,
    `    link/ether ${port.mac} brd ff:ff:ff:ff:ff:ff`,
  ];
}

function ipLink(net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    const name = devArg(rest);
    const ports = name === undefined ? device.ports : [findPort(device, name, io)];
    ports.forEach((p) => p && linkLines(device, p, device.ports.indexOf(p)).forEach(io.out));
    return;
  }
  if (matches(verb, 'set')) {
    const name = rest[0] === 'dev' ? rest[1] : rest[0];
    const state = rest[rest[0] === 'dev' ? 2 : 1];
    const port = findPort(device, name, io);
    if (!port) return;
    if (state !== 'up' && state !== 'down') {
      io.out('Usage: ip link set [dev] IF up|down');
      return;
    }
    net.setPortUp(port, state === 'up');
    return;
  }
  io.out(`Command "${verb}" is unknown, try "ip link help".`);
}

function ipAddr(_net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    const name = devArg(rest);
    const ports = name === undefined ? device.ports : [findPort(device, name, io)];
    for (const port of ports) {
      if (!port) continue;
      linkLines(device, port, device.ports.indexOf(port)).forEach(io.out);
      if (!device.ip?.ports.includes(port)) continue;
      for (const a of device.ip.addrsOn(port)) {
        const brd = a.prefix < 31 ? ` brd ${formatIp(broadcastOf(a))}` : '';
        io.out(`    inet ${formatCidr(a)}${brd} scope global ${port.name}`);
      }
    }
    return;
  }
  const isAdd = matches(verb, 'add');
  const isDel = matches(verb, 'delete');
  const isFlush = matches(verb, 'flush');
  if (!isAdd && !isDel && !isFlush) {
    io.out(`Command "${verb}" is unknown, try "ip address help".`);
    return;
  }
  const stack = device.ip;
  if (!stack) {
    io.out('RTNETLINK answers: Operation not supported');
    return;
  }
  const devIndex = rest.indexOf('dev');
  const name = devIndex >= 0 ? rest[devIndex + 1] : undefined;
  if (name === undefined) {
    io.out('Not enough information: "dev" argument is required.');
    return;
  }
  const port = findPort(device, name, io);
  if (!port) return;
  if (!stack.ports.includes(port)) {
    io.out('RTNETLINK answers: Operation not supported');
    return;
  }
  if (isFlush) {
    stack.flushAddresses(port);
    return;
  }
  const text = rest.find((_, i) => i !== devIndex && i !== devIndex + 1);
  const cidr = text === undefined ? null : parseCidr(text);
  if (!cidr) {
    io.out(`Error: any valid prefix is expected rather than "${text ?? ''}".`);
    return;
  }
  const error = isAdd ? stack.addAddress(port, cidr) : stack.removeAddress(port, cidr);
  if (error) io.out(error);
}

function ipNeigh(_net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const stack = device.ip;
  if (!stack) return;
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    for (const n of stack.neighbors.values()) {
      const lladdr = n.mac ? ` lladdr ${n.mac}` : '';
      io.out(`${formatIp(n.ip)} dev ${n.port.name}${lladdr} ${n.state}`);
    }
    return;
  }
  if (matches(verb, 'flush')) {
    const name = devArg(rest);
    if (name === undefined) {
      io.out('Flush requires arguments.');
      return;
    }
    const port = name === 'all' ? null : findPort(device, name, io);
    if (name !== 'all' && !port) return;
    if (port) stack.flushNeighbors(port);
    else stack.flushNeighbors();
    return;
  }
  io.out(`Command "${verb}" is unknown, try "ip neigh help".`);
}

function ipRoute(_net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const [verb] = args;
  if (verb !== undefined && !matches(verb, 'show') && !matches(verb, 'list')) {
    io.out(`Command "${verb}" is unknown, try "ip route help".`);
    return;
  }
  for (const r of device.ip?.routes() ?? []) {
    const net = formatCidr({ ip: networkOf(r.subnet), prefix: r.subnet.prefix });
    io.out(`${net} dev ${r.port.name} proto kernel scope link src ${formatIp(r.src)}`);
  }
}

const ip: Command = (net, device, args, io) => {
  const [object, ...rest] = args;
  if (object === undefined || object === 'help') {
    io.out('Usage: ip OBJECT { COMMAND | help }');
    io.out('where  OBJECT := { address | link | neigh | route }');
    return;
  }
  if (matches(object, 'address')) return ipAddr(net, device, rest, io);
  if (matches(object, 'link')) return ipLink(net, device, rest, io);
  if (matches(object, 'neighbour') || matches(object, 'neighbor')) {
    return ipNeigh(net, device, rest, io);
  }
  if (matches(object, 'route')) return ipRoute(net, device, rest, io);
  io.out(`Object "${object}" is unknown, try "ip help".`);
};

const bridge: Command = (_net, device, args, io) => {
  const [object, verb] = args;
  const br = device.bridge;
  if (!br || object !== 'fdb' || (verb !== undefined && verb !== 'show')) {
    io.out('Usage: bridge fdb [show]');
    return;
  }
  for (const e of br.fdb()) io.out(`${e.mac} dev ${e.port.name} master br0`);
};

const hostname: Command = (net, device, args, io) => {
  const [name] = args;
  if (name === undefined) io.out(device.name);
  else if (/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name)) net.rename(device, name);
  else io.out('hostname: the specified hostname is invalid');
};

const ping: Command = (net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('ping: command not found');
    return;
  }
  let count = 4;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) {
        io.out(`ping: invalid argument: '${args[i] ?? ''}'`);
        return;
      }
      count = value;
    } else if (arg?.startsWith('-')) {
      io.out(`ping: invalid option -- '${arg.slice(1)}'`);
      return;
    } else {
      target = arg;
    }
  }
  if (target === undefined) {
    io.out('ping: usage error: Destination address required');
    return;
  }
  const dst = parseIp(target);
  if (dst === null) {
    io.out(`ping: ${target}: Name or service not known`);
    return;
  }
  if (stack.allAddrs().some((a) => a.prefix < 31 && broadcastOf(a) === dst)) {
    io.out('Do you want to ping broadcast? Then -b. If not, check your local firewall rules');
    return;
  }

  const { scheduler } = net;
  const shown = formatIp(dst);
  const start = scheduler.now;
  const sentAt = new Map<number, number>();
  const rtts: number[] = [];
  let sent = 0;
  let errors = 0;
  let done = false;
  let timer: number | null = null;

  const id = stack.openIcmp((event) => {
    if (done) return;
    if (event.kind === 'reply') {
      const rtt = scheduler.now - (sentAt.get(event.seq) ?? scheduler.now);
      rtts.push(rtt);
      io.out(
        `64 bytes from ${formatIp(event.from)}: icmp_seq=${event.seq} ttl=${event.ttl} time=${rtt.toFixed(2)} ms`,
      );
    } else {
      errors++;
      io.out(`From ${formatIp(event.from)} icmp_seq=${event.seq} Destination Host Unreachable`);
    }
    // Like Linux, stop as soon as every request has been answered.
    if (sent === count && rtts.length + errors >= count) finish();
  });

  const finish = () => {
    if (done) return;
    done = true;
    stack.closeIcmp(id);
    if (timer !== null) scheduler.cancel(timer);
    const received = rtts.length;
    const loss = sent === 0 ? 0 : Math.round(((sent - received) / sent) * 100);
    const errorText = errors > 0 ? `, +${errors} errors` : '';
    io.out('');
    io.out(`--- ${shown} ping statistics ---`);
    io.out(
      `${sent} packets transmitted, ${received} received${errorText}, ${loss}% packet loss, time ${Math.round(scheduler.now - start)}ms`,
    );
    if (received > 0) {
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = rtts.reduce((a, b) => a + b, 0) / received;
      const mdev = Math.sqrt(rtts.reduce((a, b) => a + (b - avg) ** 2, 0) / received);
      io.out(
        `rtt min/avg/max/mdev = ${[min, avg, max, mdev].map((v) => v.toFixed(3)).join('/')} ms`,
      );
    }
    io.exit();
  };

  const sendNext = () => {
    if (done) return;
    const seq = ++sent;
    sentAt.set(seq, scheduler.now);
    const error = stack.sendIcmp(dst, { kind: 'icmp', type: 'echo-request', id, seq });
    if (error) {
      done = true;
      stack.closeIcmp(id);
      io.out(`ping: connect: ${error}`);
      io.exit();
      return;
    }
    // Unanswered requests are given up 10 s after the last one, like Linux's MAXWAIT.
    timer = scheduler.schedule(sent < count ? 1000 : 10_000, sent < count ? sendNext : finish);
  };

  io.out(`PING ${shown} (${shown}) 56(84) bytes of data.`);
  sendNext();
  return { interrupt: finish };
};

const COMMANDS: Record<string, Command> = {
  ip,
  ping,
  bridge,
  hostname,
  help: (_net, _device, _args, io) => {
    HELP.forEach(io.out);
  },
};

/**
 * Runs one command line on a device. Returns a Process for long-running commands, which
 * call `io.exit()` when done; returns undefined when the command already finished.
 * `clear` is handled by the terminal UI.
 */
export function run(net: Network, device: Device, line: string, io: ShellIO): Process | undefined {
  const [name, ...args] = line.trim().split(/\s+/);
  if (!name) return undefined;
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    io.out(`${name}: command not found`);
    return undefined;
  }
  return command(net, device, args, io);
}
