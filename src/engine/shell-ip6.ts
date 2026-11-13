import {
  formatCidr6,
  formatIp6,
  isLinkLocal,
  parseCidr6,
  parseIp6,
  type Cidr6,
  type Ip6,
} from './addr6.ts';
import type { Device } from './device.ts';
import { type Icmp6Event, type Ip6Stack } from './ip6.ts';
import type { Network } from './network.ts';
import { hasCarrier, type Port } from './port.ts';
import type { Command, Process, ShellIO } from './shell.ts';

/** Parses `ADDR` or `ADDR%IF` (a zone for link-local addresses). */
export function parseTarget6(
  device: Device,
  text: string,
): { ip: Ip6; dev: Port | undefined } | null {
  const [addr, zone] = text.split('%');
  const ip = addr === undefined ? null : parseIp6(addr);
  if (ip === null) return null;
  return { ip, dev: zone === undefined ? undefined : device.port(zone) };
}

/** `inet6` lines of `ip addr` for one interface. */
export function inet6Lines(v6: Ip6Stack, port: Port): string[] {
  if (!port.adminUp) return [];
  return v6.addrsOn(port).map((a) => {
    const scope = a.origin === 'link' ? 'link' : 'global';
    const dynamic = a.origin === 'ra' ? ' dynamic mngtmpaddr' : '';
    return `    inet6 ${formatCidr6(a.cidr)} scope ${scope}${dynamic}`;
  });
}

/** `ip addr add|del ADDR6 dev IF`. */
export function ip6AddrChange(
  v6: Ip6Stack,
  port: Port,
  add: boolean,
  text: string,
  io: ShellIO,
): void {
  const cidr = parseCidr6(text);
  if (!cidr) {
    io.out(`Error: inet6 prefix is expected rather than "${text}".`);
    return;
  }
  const error = add ? v6.addAddress(port, cidr) : v6.removeAddress(port, cidr);
  if (error) io.out(error);
}

function routeLine(r: { dst: Cidr6; via: Ip6 | null; port: Port; proto: string }): string {
  const dst = r.dst.prefix === 0 ? 'default' : formatCidr6(r.dst);
  const via = r.via === null ? '' : ` via ${formatIp6(r.via)}`;
  const down = hasCarrier(r.port) ? '' : ' linkdown';
  const proto = r.proto === 'static' ? '' : ` proto ${r.proto}`;
  const metric = r.proto === 'kernel' ? 256 : 1024;
  return `${dst}${via} dev ${r.port.name}${proto} metric ${metric}${down} pref medium`;
}

/** `ip -6 route [show] | add DST [via GW] [dev IF] | del DST`. */
export function ip6Route(device: Device, args: string[], io: ShellIO): void {
  const v6 = device.ip?.v6;
  if (!v6) return;
  const [verb, ...rest] = args;
  if (verb === undefined || verb === 'show' || verb === 'list') {
    const kernel = v6.routes().filter((r) => r.proto === 'kernel');
    const statics = v6.staticRoutes.map((r) => ({ ...r, port: r.dev, proto: 'static' }));
    const ra = v6.routes().filter((r) => r.proto === 'ra');
    [...kernel, ...statics, ...ra].forEach((r) => io.out(routeLine(r)));
    return;
  }
  const add = verb === 'add';
  if (!add && verb !== 'del' && verb !== 'delete') {
    io.out(`Command "${verb}" is unknown, try "ip route help".`);
    return;
  }
  const [dstText, ...opts] = rest;
  const dst: Cidr6 | null =
    dstText === 'default' ? { ip: 0n, prefix: 0 } : dstText ? parseCidr6(dstText) : null;
  if (!dst) {
    io.out(`Error: inet6 prefix is expected rather than "${dstText ?? ''}".`);
    return;
  }
  if (!add) {
    const error = v6.removeRoute(dst);
    if (error) io.out(error);
    return;
  }
  const at = (key: string) => {
    const i = opts.indexOf(key);
    return i >= 0 ? opts[i + 1] : undefined;
  };
  const viaText = at('via');
  const devText = at('dev');
  const via = viaText === undefined ? null : parseIp6(viaText);
  if (viaText !== undefined && via === null) {
    io.out(`Error: inet6 address is expected rather than "${viaText}".`);
    return;
  }
  const dev = devText === undefined ? null : (device.port(devText) ?? null);
  if (devText !== undefined && !dev) {
    io.out(`Cannot find device "${devText}"`);
    return;
  }
  if (via !== null && isLinkLocal(via) && !dev) {
    io.out('Error: Nexthop has invalid gateway.');
    return;
  }
  const error = v6.addRoute(dst, via, dev);
  if (error) io.out(error);
}

/** `ip -6 neigh`. */
export function ip6Neigh(device: Device, io: ShellIO): void {
  for (const n of device.ip?.v6.neighbors.values() ?? []) {
    const ll = n.mac ? ` lladdr ${n.mac}` : '';
    io.out(`${formatIp6(n.ip)} dev ${n.port.name}${ll}${n.router ? ' router' : ''} ${n.state}`);
  }
}

/** `ping` to an IPv6 address, like iputils ping. */
export function ping6(
  net: Network,
  device: Device,
  target: string,
  opts: { count: number; hopLimit: number },
  io: ShellIO,
): Process | undefined {
  const v6 = device.ip?.v6;
  const parsed = parseTarget6(device, target);
  if (!v6 || !parsed) {
    io.out(`ping: ${target}: Name or service not known`);
    return;
  }
  const { ip, dev } = parsed;
  if (target.includes('%') && !dev) {
    io.out(`ping: ${target}: Name or service not known`);
    return;
  }
  // iputils connects the socket first: no route means no PING line at all.
  const unreachable = v6.check(ip, dev);
  if (unreachable) {
    io.out(`ping: connect: ${unreachable}`);
    return;
  }
  const { scheduler } = net;
  const shown = formatIp6(ip);
  const start = scheduler.now;
  const sentAt = new Map<number, number>();
  const rtts: number[] = [];
  let sent = 0;
  let errors = 0;
  let done = false;
  let timer: number | null = null;

  const id = v6.openIcmp((event: Icmp6Event) => {
    if (done) return;
    if (event.kind === 'reply') {
      const rtt = scheduler.now - (sentAt.get(event.seq) ?? scheduler.now);
      rtts.push(rtt);
      const from =
        isLinkLocal(event.from) && dev
          ? `${formatIp6(event.from)}%${dev.name}`
          : formatIp6(event.from);
      io.out(
        `64 bytes from ${from}: icmp_seq=${event.seq} ttl=${event.hopLimit} time=${rtt.toFixed(2)} ms`,
      );
    } else {
      errors++;
      const what =
        event.kind === 'ttl-exceeded'
          ? 'Time exceeded: Hop limit'
          : {
              route: 'Destination unreachable: No route',
              address: 'Destination unreachable: Address unreachable',
              port: 'Destination unreachable: Port unreachable',
            }[event.code];
      io.out(`From ${formatIp6(event.from)} icmp_seq=${event.seq} ${what}`);
    }
    if (sent === opts.count && rtts.length + errors >= opts.count) finish();
  });

  const finish = () => {
    if (done) return;
    done = true;
    v6.closeIcmp(id);
    if (timer !== null) scheduler.cancel(timer);
    const received = rtts.length;
    const loss = sent === 0 ? 0 : Math.round(((sent - received) / sent) * 100);
    const errorText = errors > 0 ? `, +${errors} errors` : '';
    io.out('');
    io.out(`--- ${target} ping statistics ---`);
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
    const error = v6.send(
      ip,
      { kind: 'icmp6', type: 'echo-request', id, seq },
      { ...(dev ? { dev } : {}), hopLimit: opts.hopLimit },
    );
    if (error) {
      done = true;
      v6.closeIcmp(id);
      io.out(`ping: connect: ${error}`);
      io.exit();
      return;
    }
    timer = scheduler.schedule(
      sent < opts.count ? 1000 : 10_000,
      sent < opts.count ? sendNext : finish,
    );
  };

  io.out(`PING ${target}(${shown}${dev ? `%${dev.name}` : ''}) 56 data bytes`);
  sendNext();
  return { interrupt: finish };
}

/** `radvd [-C FILE]`: sends router advertisements so hosts configure themselves (SLAAC). */
export const radvd: Command = (_net, device, args, io) => {
  const error = device.startRadvd(args);
  if (error) io.out(error);
};
