import {
  broadcastOf,
  formatCidr,
  formatIp,
  parseCidr,
  parseIp,
  type Cidr,
  type Ip,
} from './addr.ts';
import type { Device } from './device.ts';
import { isHostname, resolve } from './dns.ts';
import { normalizePath } from './fs.ts';
import { DEFAULT_TTL } from './ip.ts';
import type { Network } from './network.ts';
import { hasCarrier, type Port } from './port.ts';
import { cat, echo, ls, mkdir, parseLine, pwd, rm, touch } from './shell-files.ts';
import { conntrack, nft } from './shell-firewall.ts';
import { pathCost } from './stp.ts';
import {
  curl,
  dhclientCommand,
  dig,
  dnsmasq,
  dovecot,
  hostapd,
  httpd,
  killall,
  nc,
  nmcli,
  postfix,
  resolvectl,
  ss,
  tcpdump,
} from './shell-services.ts';

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

export type Command = (
  net: Network,
  device: Device,
  args: string[],
  io: ShellIO,
) => Process | undefined;

const HELP = [
  'Available commands:',
  '  ip addr [show [dev IF]]            show addresses',
  '  ip addr add|del ADDR/LEN dev IF    add or remove an IPv4 address',
  '  ip addr flush dev IF               remove all addresses from IF',
  '  ip link [show [dev IF]]            show interfaces',
  '  ip link set [dev] IF up|down       enable or disable an interface',
  '  ip link add link IF name IF.VID type vlan id VID   add a VLAN interface',
  '  ip link del IF.VID                 delete a VLAN interface',
  '  ip link set br0 type bridge vlan_filtering 1   turn on VLANs (switches)',
  '  ip neigh [show] | flush all|dev IF show or clear the ARP table',
  '  ip route [show]                    show the routing table',
  '  ip route add DST [via GW] [dev IF] add a route; DST is ADDR/LEN or default',
  '  ip route del DST                   remove a route',
  '  ip route get ADDR                  show which route a packet would take',
  '  sysctl -w net.ipv4.ip_forward=1    let the device forward packets (router)',
  '  ping [-c COUNT] [-t TTL] ADDR      send ICMP echo requests (Ctrl+C stops)',
  '  traceroute [-m MAX_TTL] ADDR       show the routers on the way to ADDR',
  '  bridge fdb [show]                  show learned MAC addresses (switches)',
  '  bridge vlan [show]                 show the VLANs of each port (switches)',
  '  bridge link [show]                 show the Spanning Tree state of ports (switches)',
  '  ip link set br0 type bridge stp_state 1 [priority N]   turn on Spanning Tree',
  '  ip -d link show br0                show bridge settings, root bridge and root port',
  '  bridge vlan add|del dev IF vid VID [pvid] [untagged]   set port VLANs',
  '  dhclient [-r] IF                   get (or release) an address with DHCP',
  '  dnsmasq --dhcp-range=START,END ... start a DHCP/DNS server (see dnsmasq --help)',
  '  killall dnsmasq                    stop the DHCP/DNS server',
  '  dig [@SERVER] [+short] NAME        ask a DNS server for the address of NAME',
  '  resolvectl [status]                show the DNS servers this device asks',
  '  resolvectl dns IF SERVER...        set the DNS servers',
  '  httpd [-p PORT] [-h DIR]           start a web server (killall httpd stops it)',
  '  curl [-i|-I] URL                   fetch a web page over HTTP',
  '  postfix start|stop, dovecot        start the mail servers (SMTP 25, POP3 110)',
  '  nc -z HOST PORT                    check whether a TCP port is open',
  '  tcpdump [-i IF] [-c COUNT]         show the packets this device sends and receives',
  '  nmcli dev wifi list                list Wi-Fi networks in range',
  '  nmcli dev wifi connect SSID password PASS   join a Wi-Fi network',
  '  hostapd -B /etc/hostapd/hostapd.conf        start an access point (APs)',
  '  nft list ruleset | nft add ...     firewall and NAT (see nft with no arguments)',
  '  conntrack -L                       list tracked connections (firewall, NAT)',
  '  ss -t                              list TCP sockets',
  '  hostname [NAME]                    show or set the device name',
  '  ls, cat, echo TEXT > FILE, rm, touch, mkdir, pwd   work with files',
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
  const name = port.parent ? `${port.name}@${port.parent.name}` : port.name;
  const vlan = port.parent ? [`    vlan protocol 802.1Q id ${port.vid ?? 0}`] : [];
  return [
    `${index + 1}: ${name}: <${noCarrier}${flags.join(',')}> mtu 1500${master} state ${state}`,
    `    link/ether ${port.mac} brd ff:ff:ff:ff:ff:ff`,
    ...vlan,
  ];
}

/** Every interface of a device for `ip link`/`ip addr`, or just the one named. */
function listed(device: Device, name: string | undefined, io: ShellIO): Port[] {
  if (name === undefined) return device.interfaces();
  const port = findPort(device, name, io);
  return port ? [port] : [];
}

function bridgeLines(device: Device, index: number, details = false): string[] {
  const lines = [
    `${index + 1}: br0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP`,
    `    link/ether ${device.ports[0]?.mac ?? ''} brd ff:ff:ff:ff:ff:ff`,
  ];
  const br = device.bridge;
  if (details && br) {
    const s = br.stp;
    const rootPort = s.rootPort ? br.ports.indexOf(s.rootPort) + 1 : 0;
    lines.push(
      `    bridge forward_delay 1500 hello_time 200 max_age 2000 ageing_time 30000 stp_state ${s.enabled ? 1 : 0} priority ${s.priority} vlan_filtering ${br.vlanFiltering ? 1 : 0} bridge_id ${s.bridgeId} root_id ${s.enabled ? s.rootId : s.bridgeId} root_port ${rootPort} root_path_cost ${s.rootCost}`,
    );
  }
  return lines;
}

/** Reads `key VALUE` pairs from command arguments. */
function option(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A VLAN id 1-4094, or null. */
function vlanId(text: string): number | null {
  const vid = /^\d+$/.test(text) ? Number(text) : 0;
  return vid >= 1 && vid <= 4094 ? vid : null;
}

/** `ip link set br0 type bridge vlan_filtering 0|1`. */
/** `ip link set br0 type bridge [vlan_filtering 0|1] [stp_state 0|1] [priority N]`. */
function setBridge(net: Network, device: Device, args: string[], io: ShellIO): void {
  const br = device.bridge;
  if (!br) {
    io.out('Cannot find device "br0"');
    return;
  }
  const vlan = option(args, 'vlan_filtering');
  const stp = option(args, 'stp_state');
  const priority = option(args, 'priority');
  const flag = (v: string | undefined) => v === undefined || v === '0' || v === '1';
  const prio = priority === undefined ? null : /^\d+$/.test(priority) ? Number(priority) : -1;
  const known = new Set(['bridge', 'vlan_filtering', 'stp_state', 'priority', vlan, stp, priority]);
  if (
    args[0] !== 'bridge' ||
    args.some((a) => !known.has(a)) ||
    (vlan === undefined && stp === undefined && priority === undefined) ||
    !flag(vlan) ||
    !flag(stp) ||
    (prio !== null && !(prio >= 0 && prio <= 65535))
  ) {
    io.out('Usage: ip link set br0 type bridge [vlan_filtering 0|1] [stp_state 0|1] [priority N]');
    return;
  }
  if (stp === '0' && br.stp.enabled && net.hasL2Loop(device)) {
    // A simulator guard: Linux would let the frames circle forever.
    io.out('Error: br0 is part of a switching loop; turning STP off would flood the network.');
    return;
  }
  if (vlan !== undefined) br.setVlanFiltering(vlan === '1');
  if (prio !== null) br.stp.setPriority(prio);
  if (stp !== undefined) br.stp.setEnabled(stp === '1');
}

/** `ip link add link IF name NAME type vlan id VID`. */
function addLink(device: Device, args: string[], io: ShellIO): void {
  const parentName = option(args, 'link');
  const name = option(args, 'name');
  const idText = option(args, 'id');
  if (option(args, 'type') !== 'vlan' || !parentName || !name || idText === undefined) {
    io.out('Usage: ip link add link IF name NAME type vlan id VID');
    return;
  }
  const vid = vlanId(idText);
  if (vid === null) {
    io.out(`Error: argument "${idText}" is wrong: id is invalid`);
    return;
  }
  const parent = findPort(device, parentName, io);
  if (!parent) return;
  const error = device.addVlanPort(parent, name, vid);
  if (error) io.out(error);
}

function ipLink(
  net: Network,
  device: Device,
  args: string[],
  io: ShellIO,
  details = false,
): undefined {
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    const name = devArg(rest);
    const all = device.interfaces();
    if (name === 'br0' && device.bridge) {
      bridgeLines(device, all.length, details).forEach(io.out);
      return;
    }
    listed(device, name, io).forEach((p) => linkLines(device, p, all.indexOf(p)).forEach(io.out));
    if (name === undefined && device.bridge) bridgeLines(device, all.length).forEach(io.out);
    return;
  }
  if (matches(verb, 'set')) {
    const at = rest[0] === 'dev' ? 1 : 0;
    const name = rest[at];
    const state = rest[at + 1];
    if (name === 'br0' && state === 'type') {
      setBridge(net, device, rest.slice(at + 2), io);
      return;
    }
    const port = findPort(device, name, io);
    if (!port) return;
    if (state !== 'up' && state !== 'down') {
      io.out('Usage: ip link set [dev] IF up|down');
      return;
    }
    net.setPortUp(port, state === 'up');
    return;
  }
  if (matches(verb, 'add')) {
    addLink(device, rest, io);
    return;
  }
  if (matches(verb, 'delete')) {
    const port = findPort(device, devArg(rest), io);
    if (!port) return;
    if (port.parent) device.removeVlanPort(port);
    else io.out('RTNETLINK answers: Operation not supported');
    return;
  }
  io.out(`Command "${verb}" is unknown, try "ip link help".`);
}

function ipAddr(_net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    const all = device.interfaces();
    for (const port of listed(device, devArg(rest), io)) {
      linkLines(device, port, all.indexOf(port)).forEach(io.out);
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

function routeLine(r: { dst: Cidr; via: Ip | null; port: Port; src?: Ip; proto: string }): string {
  const dst = r.dst.prefix === 0 ? 'default' : formatCidr(r.dst);
  const down = hasCarrier(r.port) ? '' : ' linkdown';
  if (r.proto === 'kernel') {
    return `${dst} dev ${r.port.name} proto kernel scope link src ${formatIp(r.src ?? 0)}${down}`;
  }
  return r.via === null
    ? `${dst} dev ${r.port.name} scope link${down}`
    : `${dst} via ${formatIp(r.via)} dev ${r.port.name}${down}`;
}

/** Parses `default` or `a.b.c.d[/n]` into a network. */
function parseDst(text: string | undefined): Cidr | null {
  if (text === 'default') return { ip: 0, prefix: 0 };
  return text === undefined ? null : parseCidr(text);
}

function ipRoute(_net: Network, device: Device, args: string[], io: ShellIO): undefined {
  const [verb, ...rest] = args;
  const stack = device.ip;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    if (!stack) return;
    const kernel = stack.routes().filter((r) => r.proto === 'kernel');
    const statics = stack.staticRoutes.map((r) => ({ ...r, port: r.dev, proto: 'static' }));
    const all = [...kernel, ...statics].sort((a, b) =>
      a.dst.prefix === 0
        ? -1
        : b.dst.prefix === 0
          ? 1
          : a.dst.ip - b.dst.ip || a.dst.prefix - b.dst.prefix,
    );
    all.forEach((r) => io.out(routeLine(r)));
    return;
  }
  const isAdd = matches(verb, 'add');
  const isDel = matches(verb, 'delete');
  const isGet = matches(verb, 'get');
  if (!isAdd && !isDel && !isGet) {
    io.out(`Command "${verb}" is unknown, try "ip route help".`);
    return;
  }
  if (!stack) {
    io.out('RTNETLINK answers: Operation not supported');
    return;
  }
  if (isGet) {
    const dst = rest[0] === undefined ? null : parseIp(rest[0]);
    if (dst === null) {
      io.out(`Error: any valid address is expected rather than "${rest[0] ?? ''}".`);
      return;
    }
    const r = stack.ownsIp(dst) ? null : stack.routeTo(dst);
    if (stack.ownsIp(dst)) io.out(`local ${formatIp(dst)} dev lo src ${formatIp(dst)}`);
    else if (!r) io.out('RTNETLINK answers: Network is unreachable');
    else {
      const via = r.via === null ? '' : ` via ${formatIp(r.via)}`;
      io.out(`${formatIp(dst)}${via} dev ${r.port.name} src ${formatIp(r.src)}`);
    }
    return;
  }
  const dst = parseDst(rest[0]);
  if (!dst) {
    io.out(`Error: any valid prefix is expected rather than "${rest[0] ?? ''}".`);
    return;
  }
  if (isDel) {
    const error = stack.removeRoute(dst);
    if (error) io.out(error);
    return;
  }
  let via: Ip | null = null;
  let dev: Port | null = null;
  for (let i = 1; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === 'via') {
      via = value === undefined ? null : parseIp(value);
      if (via === null) {
        io.out(`Error: inet address is expected rather than "${value ?? ''}".`);
        return;
      }
    } else if (key === 'dev') {
      dev = findPort(device, value, io);
      if (!dev) return;
    } else {
      io.out(`Error: either "to" is duplicate, or "${key ?? ''}" is a garbage.`);
      return;
    }
  }
  const error = stack.addRoute(dst, via, dev);
  if (error) io.out(error);
}

const ip: Command = (net, device, allArgs, io) => {
  // `ip -d ...` shows details (bridge settings for `ip -d link show br0`).
  const details = allArgs[0] === '-d' || allArgs[0] === '-details';
  const args = details ? allArgs.slice(1) : allArgs;
  const [object, ...rest] = args;
  if (object === undefined || object === 'help') {
    io.out('Usage: ip OBJECT { COMMAND | help }');
    io.out('where  OBJECT := { address | link | neigh | route }');
    return;
  }
  if (matches(object, 'address')) return ipAddr(net, device, rest, io);
  if (matches(object, 'link')) return ipLink(net, device, rest, io, details);
  if (matches(object, 'neighbour') || matches(object, 'neighbor')) {
    return ipNeigh(net, device, rest, io);
  }
  if (matches(object, 'route')) return ipRoute(net, device, rest, io);
  io.out(`Object "${object}" is unknown, try "ip help".`);
};

function bridgeVlan(device: Device, args: string[], io: ShellIO): void {
  const br = device.bridge;
  const [verb, ...rest] = args;
  if (verb === undefined || matches(verb, 'show') || matches(verb, 'list')) {
    if (!br) return;
    io.out('port              vlan-id');
    for (const port of br.ports) {
      const v = br.vlans.get(port);
      const vids = [...(v?.vids ?? [])].sort((a, b) => a - b);
      vids.forEach((vid, i) => {
        const flags = [
          ...(v?.pvid === vid ? ['PVID'] : []),
          ...(v?.untagged.has(vid) ? ['Egress Untagged'] : []),
        ];
        io.out(`${(i === 0 ? port.name : '').padEnd(18)}${[vid, ...flags].join(' ')}`);
      });
    }
    return;
  }
  const add = matches(verb, 'add');
  if (!add && !matches(verb, 'delete')) {
    io.out(`Command "${verb}" is unknown, try "bridge vlan help".`);
    return;
  }
  const name = option(rest, 'dev');
  const vidText = option(rest, 'vid');
  if (name === undefined || vidText === undefined) {
    io.out('Device and VLAN ID are required arguments.');
    return;
  }
  const vid = vlanId(vidText);
  if (vid === null) {
    io.out(`Invalid VLAN ID "${vidText}"`);
    return;
  }
  const port = findPort(device, name, io);
  if (!port) return;
  if (!br?.owns(port)) {
    io.out('RTNETLINK answers: Operation not supported');
    return;
  }
  if (add) {
    br.addVlan(port, vid, { pvid: rest.includes('pvid'), untagged: rest.includes('untagged') });
  } else if (!br.delVlan(port, vid)) {
    io.out('RTNETLINK answers: No such file or directory');
  }
}

/** `bridge link`: each bridge port with its Spanning Tree state and path cost. */
function bridgeLink(device: Device, io: ShellIO): void {
  const br = device.bridge;
  if (!br) return;
  br.ports.forEach((port, i) => {
    const carrier = hasCarrier(port);
    const flags = [
      'BROADCAST',
      'MULTICAST',
      ...(port.adminUp ? ['UP'] : []),
      ...(carrier ? ['LOWER_UP'] : []),
    ];
    const noCarrier = port.adminUp && !carrier ? 'NO-CARRIER,' : '';
    io.out(
      `${i + 1}: ${port.name}: <${noCarrier}${flags.join(',')}> mtu 1500 master br0 state ${br.stp.stateOf(port)} priority 32 cost ${pathCost(port)}`,
    );
  });
}

const bridge: Command = (_net, device, args, io) => {
  const [object, ...rest] = args;
  if (object !== undefined && matches(object, 'vlan')) {
    bridgeVlan(device, rest, io);
    return;
  }
  if (object !== undefined && matches(object, 'link')) {
    bridgeLink(device, io);
    return;
  }
  const br = device.bridge;
  if (!br || object !== 'fdb' || (rest[0] !== undefined && rest[0] !== 'show')) {
    io.out('Usage: bridge fdb [show] | bridge link [show] | bridge vlan [show|add|del]');
    return;
  }
  for (const e of br.fdb()) {
    const vlan = br.vlanFiltering ? ` vlan ${e.vlan}` : '';
    io.out(`${e.mac} dev ${e.port.name}${vlan} master br0`);
  }
};

const hostname: Command = (net, device, args, io) => {
  const [name] = args;
  if (name === undefined) io.out(device.name);
  else if (/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(name)) net.rename(device, name);
  else io.out('hostname: the specified hostname is invalid');
};

const UNREACHABLE = { net: 'Net', host: 'Host', port: 'Port' } as const;

const sysctl: Command = (_net, device, args, io) => {
  const words = args.filter((a) => a !== '-w');
  if (words.length === 0) {
    io.out('sysctl: no variables specified');
    return;
  }
  for (const word of words) {
    const [key, value] = word.split('=');
    if (key !== 'net.ipv4.ip_forward' || !device.ip) {
      io.out(
        `sysctl: cannot stat /proc/sys/${(key ?? '').replaceAll('.', '/')}: No such file or directory`,
      );
      continue;
    }
    if (value !== undefined) {
      if (value !== '0' && value !== '1') {
        io.out(`sysctl: setting key "${key}": Invalid argument`);
        continue;
      }
      device.ip.setForwarding(value === '1');
    }
    io.out(`${key} = ${device.ip.forwarding ? 1 : 0}`);
  }
};

/**
 * Runs `start` with `target` resolved to an address: right away for an IP address, after a
 * DNS lookup for a name. `failure` words the error for a name that can't be resolved.
 */
function withName(
  device: Device,
  target: string,
  io: ShellIO,
  failure: (kind: 'unknown' | 'temporary') => string[],
  start: (dst: Ip, label: string) => Process | undefined,
): Process | undefined {
  const literal = parseIp(target);
  if (literal !== null) return start(literal, formatIp(literal));
  if (!isHostname(target)) {
    failure('unknown').forEach((line) => io.out(line));
    return undefined;
  }
  let sync = true;
  let finished = false;
  let proc: Process | undefined;
  const cancel = resolve(device, target, (result) => {
    finished = true;
    if (result.ok) proc = start(result.ip, target);
    else failure(result.error === 'nxdomain' ? 'unknown' : 'temporary').forEach((l) => io.out(l));
    if (!sync && !proc) io.exit();
  });
  sync = false;
  if (finished) return proc;
  return {
    interrupt: () => {
      if (proc) proc.interrupt();
      else {
        cancel();
        io.exit();
      }
    },
  };
}

/** Linux traceroute's first UDP destination port. */
const TRACE_PORT = 33434;
const TRACE_PROBES = 3;
const TRACE_WAIT_MS = 5000;

const traceroute: Command = (net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('traceroute: command not found');
    return;
  }
  let maxHops = 30;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 255) {
        io.out(`first hop out of range`);
        return;
      }
      maxHops = value;
    } else if (arg?.startsWith('-')) {
      io.out(`Bad option \`${arg}' (argc ${i + 1})`);
      return;
    } else {
      target = arg;
    }
  }
  if (target === undefined) {
    io.out('Usage: traceroute [-m max_ttl] host');
    return;
  }
  const name = target;
  const failure = (kind: 'unknown' | 'temporary') => [
    `${name}: ${kind === 'unknown' ? 'Name or service not known' : 'Temporary failure in name resolution'}`,
    `Cannot handle "host" cmdline arg \`${name}' on position 1 (argc 1)`,
  ];
  return withName(device, target, io, failure, (dst, label) => {
    const { scheduler } = net;
    type Probe = { port: number; sentAt: number; from?: Ip; rtt?: number; mark?: string };
    let probes: Probe[] = [];
    let ttl = 0;
    let timer: number | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) scheduler.cancel(timer);
      if (typeof socket !== 'string') socket.close();
      io.exit();
    };

    const hopDone = () => {
      if (done) return;
      if (timer !== null) scheduler.cancel(timer);
      let line = String(ttl).padStart(2);
      let last: Ip | undefined;
      for (const p of probes) {
        if (p.from === undefined) {
          line += line.endsWith('*') ? ' *' : '  *';
          continue;
        }
        if (p.from !== last) line += `  ${formatIp(p.from)} (${formatIp(p.from)})`;
        last = p.from;
        line += `  ${(p.rtt ?? 0).toFixed(3)} ms${p.mark ?? ''}`;
      }
      io.out(line);
      const stop = probes.some((p) => p.from === dst || p.mark === ' !N' || p.mark === ' !H');
      if (stop || ttl >= maxHops) finish();
      else sendHop();
    };

    const socket = stack.openUdp(
      () => {},
      (error, original) => {
        if (done || original.payload.kind !== 'udp') return;
        const port = original.payload.dstPort;
        const probe = probes.find((p) => p.port === port && p.from === undefined);
        if (!probe) return;
        probe.from = error.from;
        probe.rtt = scheduler.now - probe.sentAt;
        if (error.kind === 'unreachable' && error.code !== 'port') {
          probe.mark = error.code === 'net' ? ' !N' : ' !H';
        }
        if (probes.every((p) => p.from !== undefined)) hopDone();
      },
    );
    if (typeof socket === 'string') {
      io.out(`traceroute: ${socket}`);
      return;
    }

    const sendHop = () => {
      ttl++;
      probes = [];
      for (let i = 0; i < TRACE_PROBES; i++) {
        const port = TRACE_PORT + (ttl - 1) * TRACE_PROBES + i;
        probes.push({ port, sentAt: scheduler.now });
        const error = socket.send(dst, port, { app: 'probe' }, ttl);
        if (error) {
          io.out(`connect: ${error}`);
          finish();
          return;
        }
      }
      timer = scheduler.schedule(TRACE_WAIT_MS, hopDone);
    };

    const shown = formatIp(dst);
    io.out(`traceroute to ${label} (${shown}), ${maxHops} hops max, 60 byte packets`);
    sendHop();
    return { interrupt: finish };
  });
};

const ping: Command = (net, device, args, io) => {
  const stack = device.ip;
  if (!stack) {
    io.out('ping: command not found');
    return;
  }
  let count = 4;
  let ttl = DEFAULT_TTL;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '-t') {
      const value = Number(args[++i]);
      const max = arg === '-c' ? Infinity : 255;
      if (!Number.isInteger(value) || value < 1 || value > max) {
        io.out(`ping: invalid argument: '${args[i] ?? ''}'`);
        return;
      }
      if (arg === '-c') count = value;
      else ttl = value;
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
  const name = target;
  const failure = (kind: 'unknown' | 'temporary') => [
    `ping: ${name}: ${kind === 'unknown' ? 'Name or service not known' : 'Temporary failure in name resolution'}`,
  ];
  return withName(device, target, io, failure, (dst, label) => {
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
        const what =
          event.kind === 'ttl-exceeded'
            ? 'Time to live exceeded'
            : `Destination ${UNREACHABLE[event.code]} Unreachable`;
        io.out(`From ${formatIp(event.from)} icmp_seq=${event.seq} ${what}`);
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
      io.out(`--- ${label} ping statistics ---`);
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
      const error = stack.sendIcmp(dst, { kind: 'icmp', type: 'echo-request', id, seq }, ttl);
      if (error === 'Operation not permitted') {
        // Dropped by the firewall's output chain: Linux ping reports it and keeps going.
        io.out(`ping: sendmsg: ${error}`);
      } else if (error) {
        done = true;
        stack.closeIcmp(id);
        io.out(`ping: connect: ${error}`);
        io.exit();
        return;
      }
      // Unanswered requests are given up 10 s after the last one, like Linux's MAXWAIT.
      timer = scheduler.schedule(sent < count ? 1000 : 10_000, sent < count ? sendNext : finish);
    };

    io.out(`PING ${label} (${shown}) 56(84) bytes of data.`);
    sendNext();
    return { interrupt: finish };
  });
};

const COMMANDS: Record<string, Command> = {
  ip,
  nft,
  conntrack,
  cat,
  curl,
  echo,
  httpd,
  ls,
  mkdir,
  pwd,
  rm,
  touch,
  dhclient: dhclientCommand,
  dig,
  dnsmasq,
  dovecot,
  hostapd,
  nc,
  nmcli,
  postfix,
  resolvectl,
  ss,
  tcpdump,
  killall,
  ping,
  traceroute,
  sysctl,
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
  const parsed = parseLine(line);
  if (typeof parsed === 'string') {
    io.out(parsed);
    return undefined;
  }
  const [name, ...args] = parsed.words;
  if (!name) return undefined;
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    io.out(`${name}: command not found`);
    return undefined;
  }
  const { redirect } = parsed;
  if (!redirect) return command(net, device, args, io);

  // `> FILE`: collect the output and write it when the command finishes.
  const path = normalizePath(redirect.path);
  if (!device.fs || path === null) {
    io.out(`bash: ${redirect.path}: No such file or directory`);
    return undefined;
  }
  const fs = device.fs;
  const lines: string[] = [];
  const save = () => {
    const error = fs.write(path, lines.map((l) => `${l}\n`).join(''), redirect.append);
    if (error) io.out(`bash: ${error}`);
  };
  const proc = command(net, device, args, {
    out: (l) => lines.push(l),
    exit: () => {
      save();
      io.exit();
    },
  });
  if (!proc) save();
  return proc;
}
