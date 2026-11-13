import { formatCidr, formatIp, networkOf } from './addr.ts';
import { DEAD_MS, type Bird } from './bird.ts';
import { hasCarrier } from './port.ts';
import type { Command, ShellIO } from './shell.ts';

const BANNER = 'BIRD 2.15 ready.';

/** Virtual time as BIRD prints it: hours, minutes and seconds since the lab started. */
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** `bird [-c FILE]`: starts the routing daemon in the background. */
export const bird: Command = (_net, device, args, io) => {
  const error = device.startBird(args);
  if (error) io.out(error);
};

function protocols(b: Bird, io: ShellIO): void {
  const since = clock(b.started);
  io.out('Name       Proto      Table      State  Since         Info');
  io.out(`device1    Device     ---        up     ${since}`);
  io.out(`kernel1    Kernel     master4    up     ${since}`);
  if (b.config.ospf) {
    const info = b.neighbors.some((n) => n.full) ? 'Running' : 'Alone';
    io.out(`ospf1      OSPF       master4    up     ${since}      ${info}`);
  }
}

function neighbors(b: Bird, now: number, io: ShellIO): void {
  io.out('ospf1:');
  io.out('Router ID       Pri          State      DTime   Interface  Router IP');
  for (const n of b.neighbors) {
    const state = n.full ? 'Full/PtP' : 'Init/PtP';
    const dead = (Math.max(0, DEAD_MS - (now - n.lastSeen)) / 1000).toFixed(3);
    io.out(
      `${formatIp(n.routerId).padEnd(15)} ${'1'.padStart(3)} ${state.padStart(14)} ${dead.padStart(9)}  ${n.port.name.padEnd(10)} ${formatIp(n.addr)}`,
    );
  }
}

function routes(b: Bird, io: ShellIO): void {
  io.out('Table master4:');
  const lines: { ip: number; text: string[] }[] = [];
  // Our own OSPF networks, then what other routers advertise.
  for (const { port, cost, addr } of b.ospfPorts()) {
    if (!hasCarrier(port)) continue;
    const dst = formatCidr({ ip: networkOf(addr), prefix: addr.prefix });
    lines.push({
      ip: networkOf(addr),
      text: [
        `${dst.padEnd(20)} unicast [ospf1 ${clock(b.started)}] * I (150/${cost}) [${formatIp(b.routerId)}]`,
        `\tdev ${port.name}`,
      ],
    });
  }
  for (const r of b.routes) {
    lines.push({
      ip: r.dst.ip,
      text: [
        `${formatCidr(r.dst).padEnd(20)} unicast [ospf1 ${clock(r.since)}] * I (150/${r.cost}) [${formatIp(r.origin)}]`,
        `\tvia ${formatIp(r.via)} on ${r.dev.name}`,
      ],
    });
  }
  lines.sort((a, b) => a.ip - b.ip).forEach((l) => l.text.forEach(io.out));
}

/** `birdc COMMAND`: talks to the running BIRD. */
export const birdc: Command = (net, device, args, io) => {
  const b = device.bird;
  if (!b) {
    io.out(
      'Unable to connect to server control socket (/run/bird/bird.ctl): No such file or directory',
    );
    return;
  }
  const line = args.join(' ');
  if (line === '') {
    io.out(BANNER);
    io.out('Usage: birdc show protocols | show ospf neighbors | show route | configure | down');
    return;
  }
  io.out(BANNER);
  if (line === 'show protocols' || line === 'show protocol') protocols(b, io);
  else if (line === 'show ospf neighbors' || line === 'show ospf neighbor') {
    if (!b.config.ospf) io.out('ospf1: no such protocol');
    else neighbors(b, net.scheduler.now, io);
  } else if (line === 'show route' || line === 'show routes') routes(b, io);
  else if (line === 'configure') {
    const config = device.bird?.args ?? [];
    device.stopBird();
    io.out('Reading configuration from /etc/bird.conf');
    const error = device.startBird(config);
    io.out(error ?? 'Reconfigured');
  } else if (line === 'down') {
    device.stopBird();
    io.out('Shutdown requested');
  } else io.out(`syntax error, unexpected ${args[args.length - 1] ?? ''}`);
};
