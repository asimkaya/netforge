import { formatCidr, formatIp, networkOf, parseCidr, parseIp, type Cidr } from './addr.ts';
import type { Device } from './device.ts';
import type { Network } from './network.ts';
import type { Port } from './port.ts';
import type { Command, ShellIO } from './shell.ts';
import { genKey, isKey, publicKey, type WgPeer, type WireGuard } from './wireguard.ts';

const generated = new WeakMap<Device, number>();

function bytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(2)} KiB`;
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  const parts: string[] = [];
  const m = Math.floor(s / 60);
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  parts.push(`${s % 60} second${s % 60 === 1 ? '' : 's'}`);
  return `${parts.join(', ')} ago`;
}

function showInterface(net: Network, port: Port, wgIf: WireGuard, io: ShellIO): void {
  io.out(`interface: ${port.name}`);
  if (wgIf.publicKey) {
    io.out(`  public key: ${wgIf.publicKey}`);
    io.out('  private key: (hidden)');
  }
  if (wgIf.listenPort !== null) io.out(`  listening port: ${wgIf.listenPort}`);
  for (const peer of wgIf.peers) {
    io.out('');
    io.out(`peer: ${peer.publicKey}`);
    if (peer.endpoint) io.out(`  endpoint: ${formatIp(peer.endpoint.ip)}:${peer.endpoint.port}`);
    io.out(`  allowed ips: ${peer.allowedIps.map(formatCidr).join(', ') || '(none)'}`);
    if (peer.lastHandshake !== null) {
      io.out(`  latest handshake: ${ago(net.scheduler.now - peer.lastHandshake)}`);
    }
    if (peer.rxBytes || peer.txBytes) {
      io.out(`  transfer: ${bytes(peer.rxBytes)} received, ${bytes(peer.txBytes)} sent`);
    }
    if (peer.keepalive) io.out(`  persistent keepalive: every ${peer.keepalive} seconds`);
  }
}

/** `wg set` style peer options. Returns an error, or null. */
function setPeer(peer: WgPeer, key: string, value: string | undefined): string | null {
  if (value === undefined) return `Unable to parse ${key}`;
  if (key === 'endpoint') {
    const [host, port] = value.split(':');
    const ip = host === undefined ? null : parseIp(host);
    const n = Number(port);
    if (ip === null || !Number.isInteger(n) || n < 1 || n > 65535) {
      return `Unable to parse endpoint: ${value}`;
    }
    peer.endpoint = { ip, port: n };
  } else if (key === 'allowed-ips') {
    const nets: Cidr[] = [];
    for (const text of value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const cidr = parseCidr(text);
      if (!cidr) return `Unable to parse IP address: \`${text}'`;
      nets.push({ ip: networkOf(cidr), prefix: cidr.prefix });
    }
    peer.allowedIps = nets;
  } else if (key === 'persistent-keepalive') {
    const n = value === 'off' ? 0 : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      return `Persistent keepalive interval is neither 0/off nor 1-65535: \`${value}'`;
    }
    peer.keepalive = n || null;
  } else return `Invalid argument: ${key}`;
  return null;
}

function wgSet(device: Device, args: string[], io: ShellIO): void {
  const [name, ...rest] = args;
  const port = name === undefined ? undefined : device.port(name);
  const tunnel = device.wireguard(port);
  if (!tunnel) {
    io.out(`Unable to modify interface: ${port ? 'Protocol not supported' : 'No such device'}`);
    return;
  }
  let peer: WgPeer | null = null;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i] ?? '';
    const value = rest[i + 1];
    if (key === 'peer') {
      if (!value || !isKey(value)) {
        io.out(`Key is not the correct length or format: \`${value ?? ''}'`);
        return;
      }
      peer = tunnel.peer(value);
      i++;
    } else if (key === 'remove' && peer) {
      tunnel.removePeer(peer.publicKey);
      peer = null;
    } else if (peer) {
      const error = setPeer(peer, key, value);
      if (error) {
        io.out(error);
        return;
      }
      i++;
    } else if (key === 'private-key') {
      const text = value === undefined ? undefined : device.fs?.read(value);
      if (text === undefined) {
        io.out('fopen: No such file or directory');
        return;
      }
      if (!isKey(text.trim())) {
        io.out('Key is not the correct length or format');
        return;
      }
      tunnel.setPrivateKey(text.trim());
      i++;
    } else if (key === 'listen-port') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        io.out(`Unable to parse listen port: \`${value ?? ''}'`);
        return;
      }
      const error = tunnel.setListenPort(n);
      if (error) io.out(error);
      i++;
    } else {
      io.out(`Invalid argument: ${key}`);
      return;
    }
  }
  device.fabric.changed();
}

/** `wg`: WireGuard keys and configuration. */
export const wg: Command = (net, device, args, io) => {
  if (!device.ip) {
    io.out('wg: command not found');
    return;
  }
  const [sub, ...rest] = args;
  if (sub === 'genkey') {
    const n = (generated.get(device) ?? 0) + 1;
    generated.set(device, n);
    io.out(genKey(`${device.id}:${net.scheduler.now}:${n}`));
    return;
  }
  if (sub === 'pubkey') {
    const key = (io.stdin ?? []).join('').trim();
    if (!isKey(key)) {
      io.out(`Key is not the correct length or format: \`${key}'`);
      return;
    }
    io.out(publicKey(key));
    return;
  }
  if (sub === 'set') {
    wgSet(device, rest, io);
    return;
  }
  if (sub === undefined || sub === 'show' || sub === 'showconf') {
    const wanted = sub === undefined || rest[0] === undefined || rest[0] === 'all' ? null : rest[0];
    const tunnels = device.vlanPorts.filter(
      (p) => device.wireguard(p) && (wanted === null || p.name === wanted),
    );
    if (wanted !== null && tunnels.length === 0) {
      io.out(
        `Unable to access interface: ${device.port(wanted) ? 'Protocol not supported' : 'No such device'}`,
      );
      return;
    }
    tunnels.forEach((port, i) => {
      const tunnel = device.wireguard(port);
      if (!tunnel) return;
      if (i > 0) io.out('');
      if (sub === 'showconf') showConf(tunnel, io);
      else showInterface(net, port, tunnel, io);
    });
    return;
  }
  io.out(`Invalid subcommand: \`${sub}'`);
  io.out('Usage: wg <cmd> [<args>]  (show, showconf, set, genkey, pubkey)');
};

function showConf(tunnel: WireGuard, io: ShellIO): void {
  io.out('[Interface]');
  if (tunnel.listenPort !== null) io.out(`ListenPort = ${tunnel.listenPort}`);
  if (tunnel.privateKey) io.out(`PrivateKey = ${tunnel.privateKey}`);
  for (const peer of tunnel.peers) {
    io.out('');
    io.out('[Peer]');
    io.out(`PublicKey = ${peer.publicKey}`);
    if (peer.allowedIps.length)
      io.out(`AllowedIPs = ${peer.allowedIps.map(formatCidr).join(', ')}`);
    if (peer.endpoint) io.out(`Endpoint = ${formatIp(peer.endpoint.ip)}:${peer.endpoint.port}`);
    if (peer.keepalive) io.out(`PersistentKeepalive = ${peer.keepalive}`);
  }
}

interface QuickConfig {
  privateKey: string;
  addresses: Cidr[];
  listenPort: number | null;
  peers: { publicKey: string; options: [string, string][] }[];
}

/** Reads a wg-quick file: [Interface] and [Peer] sections of `Key = Value` lines. */
export function parseQuickConfig(text: string): QuickConfig | string {
  const config: QuickConfig = { privateKey: '', addresses: [], listenPort: null, peers: [] };
  let section: 'interface' | 'peer' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (/^\[interface\]$/i.test(line)) section = 'interface';
    else if (/^\[peer\]$/i.test(line)) {
      section = 'peer';
      config.peers.push({ publicKey: '', options: [] });
    } else {
      const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
      if (!m || !section) return `Line unrecognized: \`${line}'`;
      const key = (m[1] ?? '').toLowerCase();
      const value = (m[2] ?? '').trim();
      const peer = config.peers.at(-1);
      if (section === 'interface') {
        if (key === 'privatekey') config.privateKey = value;
        else if (key === 'listenport') config.listenPort = Number(value);
        else if (key === 'address') {
          for (const a of value.split(',').map((x) => x.trim())) {
            const cidr = parseCidr(a);
            if (!cidr) return `Unable to parse IP address: \`${a}'`;
            config.addresses.push(cidr);
          }
        } else if (key !== 'dns' && key !== 'mtu') return `Line unrecognized: \`${line}'`;
      } else if (peer) {
        if (key === 'publickey') peer.publicKey = value;
        else if (key === 'endpoint') peer.options.push(['endpoint', value]);
        else if (key === 'allowedips') peer.options.push(['allowed-ips', value]);
        else if (key === 'persistentkeepalive') peer.options.push(['persistent-keepalive', value]);
        else return `Line unrecognized: \`${line}'`;
      }
    }
  }
  if (!isKey(config.privateKey)) return 'Key is not the correct length or format';
  if (config.peers.some((p) => !isKey(p.publicKey))) {
    return 'Key is not the correct length or format';
  }
  return config;
}

/** `wg-quick up|down IF`: a WireGuard interface from /etc/wireguard/IF.conf. */
export const wgQuick: Command = (net, device, args, io) => {
  const [verb, name] = args;
  const ip = device.ip;
  if (!ip || !device.fs) {
    io.out('wg-quick: command not found');
    return;
  }
  if ((verb !== 'up' && verb !== 'down') || !name) {
    io.out('Usage: wg-quick [ up | down ] [ CONFIG_FILE | INTERFACE ]');
    return;
  }
  const existing = device.port(name);
  if (verb === 'down') {
    if (!device.wireguard(existing) || !existing) {
      io.out(`wg-quick: \`${name}' is not a WireGuard interface`);
      return;
    }
    io.out(`[#] ip link delete dev ${name}`);
    device.removeVlanPort(existing);
    return;
  }
  if (existing) {
    io.out(`wg-quick: \`${name}' already exists`);
    return;
  }
  const path = `/etc/wireguard/${name}.conf`;
  const text = device.fs.read(path);
  if (text === undefined) {
    io.out(`wg-quick: \`${path}' does not exist`);
    return;
  }
  const config = parseQuickConfig(text);
  if (typeof config === 'string') {
    io.out(config);
    io.out(`Configuration parsing error`);
    return;
  }
  io.out(`[#] ip link add ${name} type wireguard`);
  device.addWireguard(name);
  const port = device.port(name);
  const tunnel = device.wireguard(port);
  if (!port || !tunnel) return;
  io.out(`[#] wg setconf ${name} /dev/fd/63`);
  if (config.listenPort !== null) tunnel.setListenPort(config.listenPort);
  tunnel.setPrivateKey(config.privateKey);
  for (const p of config.peers) {
    const peer = tunnel.peer(p.publicKey);
    for (const [key, value] of p.options) {
      const error = setPeer(peer, key, value);
      if (error) io.out(error);
    }
  }
  for (const a of config.addresses) {
    io.out(`[#] ip -4 address add ${formatCidr(a)} dev ${name}`);
    ip.addAddress(port, a);
  }
  io.out(`[#] ip link set mtu 1420 up dev ${name}`);
  net.setPortUp(port, true);
  // Routes for the allowed IPs that the interface's own subnet does not cover already.
  for (const net4 of tunnel.peers.flatMap((p) => p.allowedIps)) {
    const route = ip.routeTo(net4.ip);
    if (route?.port === port && route.dst.prefix <= net4.prefix) continue;
    io.out(`[#] ip -4 route add ${formatCidr(net4)} dev ${name}`);
    ip.addRoute(net4, null, port);
  }
};
