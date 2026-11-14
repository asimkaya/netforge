import { formatCidr, formatIp, inSubnet, networkOf, parseIp } from './addr.ts';
import { parseIp6 } from './addr6.ts';
import type { Device } from './device.ts';
import type { Drop, PacketSummary } from './drops.ts';
import type { Network } from './network.ts';
import { formatRule } from './nft.ts';
import { hasCarrier, peerOf } from './port.ts';
import { scan } from './wifi.ts';

/**
 * "Why did this fail?": picks the drops (drops.ts) that belong to one command's conversation
 * and turns the first point of failure into a short explanation with a fix. It only reads;
 * the decisions were made, and recorded, where the packets died.
 */

export interface CommandRun {
  /** The command line as typed. */
  line: string;
  /** What it printed. */
  output: string[];
  /**
   * Which drops belong to the command: those after `after` up to `until`, both values of
   * `net.dropSeq` (taken when it started and when it finished). Virtual time cannot tell
   * commands apart: in simulation mode two of them can run at the same instant.
   */
  after: number;
  until: number;
}

export interface Explanation {
  /** `dropped`: a packet died; `config`: the device cannot even send; `ok`; `unknown`. */
  kind: 'dropped' | 'config' | 'ok' | 'unknown';
  text: string;
  /** A command that fixes it, when there is an obvious one. */
  fix: string | null;
  /** The device to type `fix` on, when that is not the one the command ran on. */
  fixDevice?: string;
  /** The device where it went wrong, for pointing at it on the canvas. */
  deviceId: string | null;
}

interface Parsed {
  name: 'ping' | 'traceroute' | 'curl' | 'dig' | 'nc' | 'ssh';
  target: string | null;
  port: number | null;
  /** `dig @server`. */
  server: string | null;
  v6: boolean;
}

/** Words that are not options or the values of the given options. */
function positional(args: string[], withValue: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (withValue.includes(a)) i++;
    else if (!a.startsWith('-') && !a.startsWith('+') && !a.startsWith('@')) words.push(a);
  }
  return words;
}

function parseCommand(line: string): Parsed | null {
  const first = line.split(/\s*(?:\|\||\||;|&&|>)\s*/)[0] ?? '';
  const [cmd, ...args] = first.trim().split(/\s+/);
  const base = { target: null, port: null, server: null, v6: false };
  switch (cmd) {
    case 'ping':
    case 'ping6': {
      const target = positional(args, ['-c', '-t']).at(-1) ?? null;
      const v6 = cmd === 'ping6' || args.includes('-6') || (target?.includes(':') ?? false);
      return { ...base, name: 'ping', target, v6 };
    }
    case 'traceroute':
      return { ...base, name: 'traceroute', target: positional(args, ['-m'])[0] ?? null };
    case 'curl': {
      const url = positional(args, [])[0] ?? '';
      const m = /^(?:http:\/\/)?([^/:]+)(?::(\d+))?/i.exec(url);
      return { ...base, name: 'curl', target: m?.[1] ?? null, port: m?.[2] ? Number(m[2]) : 80 };
    }
    case 'dig':
      return {
        ...base,
        name: 'dig',
        target: positional(args, [])[0] ?? null,
        server: args.find((a) => a.startsWith('@'))?.slice(1) ?? null,
      };
    case 'nc': {
      const [host, port] = positional(args, []);
      return { ...base, name: 'nc', target: host ?? null, port: port ? Number(port) : null };
    }
    case 'ssh': {
      const dest = positional(args, ['-p', '-l'])[0] ?? '';
      const p = args.indexOf('-p');
      return {
        ...base,
        name: 'ssh',
        target: dest.slice(dest.lastIndexOf('@') + 1) || null,
        port: p >= 0 ? Number(args[p + 1]) : 22,
      };
    }
    default:
      return null;
  }
}

/** Whether a finished command failed, from what it printed. False for other commands. */
export function commandFailed(line: string, output: string[]): boolean {
  const cmd = parseCommand(line);
  if (!cmd) return false;
  const has = (re: RegExp) => output.some((l) => re.test(l));
  switch (cmd.name) {
    case 'ping': {
      const stats = output.map((l) => /(\d+) received/.exec(l)).find((m) => m);
      return stats ? stats[1] === '0' : has(/^ping: /);
    }
    case 'traceroute': {
      if (output.length === 0) return false;
      const last = output.at(-1) ?? '';
      return (
        !output[0]?.startsWith('traceroute to') ||
        /^\s*\d+(\s+\*)+\s*$/.test(last) ||
        has(/ !N| !H|^connect:/)
      );
    }
    case 'curl':
      return has(/^curl: \(\d+\)/);
    case 'dig':
      return has(/no servers could be reached|status: (NXDOMAIN|SERVFAIL)/);
    case 'nc':
      return has(/^nc: /);
    case 'ssh':
      return has(/^ssh: /);
  }
}

// ----------------------------------------------------------------- lookups

function owns(device: Device, ip: string): boolean {
  const v4 = parseIp(ip);
  if (v4 !== null) return device.ip?.ownsIp(v4) ?? false;
  const v6 = parseIp6(ip);
  return v6 !== null && (device.ip?.v6.ownsIp(v6) ?? false);
}

const ownerOf = (net: Network, ip: string) => [...net.devices.values()].find((d) => owns(d, ip));

/** A router sharing a network with `device`: the obvious default gateway. */
function gatewayFor(net: Network, device: Device): string | null {
  const stack = device.ip;
  if (!stack) return null;
  for (const port of stack.ports.filter(hasCarrier)) {
    for (const mine of stack.addrsOn(port)) {
      for (const other of net.devices.values()) {
        if (other === device || !other.ip?.forwarding) continue;
        const theirs = other.ip.allAddrs().find((a) => inSubnet(a.ip, mine));
        if (theirs) return formatIp(theirs.ip);
      }
    }
  }
  return null;
}

/** `ip route add NET via ROUTER` for a router that knows no way to `dst`, when it is clear. */
function routeFix(net: Network, device: Device, dst: string): string | null {
  const ip = parseIp(dst);
  const stack = device.ip;
  const there =
    ip === null
      ? undefined
      : ownerOf(net, dst)
          ?.ip?.allAddrs()
          .find((a) => inSubnet(ip, a));
  if (!there || !stack) return null;
  // A router that sits on the destination's network and shares a network with this device.
  for (const r of net.devices.values()) {
    if (r === device || !r.ip?.forwarding) continue;
    const addrs = r.ip.allAddrs();
    const via = addrs.find((a) => stack.allAddrs().some((m) => inSubnet(a.ip, m)));
    if (via && addrs.some((a) => inSubnet(a.ip, there))) {
      const net4 = formatCidr({ ip: networkOf(there), prefix: there.prefix });
      return `ip route add ${net4} via ${formatIp(via.ip)}`;
    }
  }
  return null;
}

/** The commands that start the service behind a TCP or UDP port. */
const SERVICES: Record<string, { name: string; start: string }> = {
  'tcp/80': { name: 'web server', start: 'httpd' },
  'tcp/22': { name: 'SSH server', start: 'sshd' },
  'tcp/25': { name: 'mail server', start: 'postfix start' },
  'tcp/110': { name: 'mail (POP3) server', start: 'dovecot' },
  'udp/53': { name: 'DNS server', start: 'dnsmasq' },
};

function describe(p: PacketSummary): string {
  switch (p.proto) {
    case 'icmp':
      if (p.what === 'echo-request') return `the ping to ${p.dst}`;
      if (p.what === 'echo-reply') return `the ping reply from ${p.src}`;
      return `an ICMP message (${p.what ?? 'error'})`;
    case 'tcp':
      if (p.what === 'SYN') return `the connection request to ${p.dst} port ${p.dstPort}`;
      if (p.what?.startsWith('SYN+ACK'))
        return `the answer from ${p.src} to the connection request`;
      return `a TCP packet from ${p.src} to ${p.dst}`;
    case 'udp':
      if (p.dstPort === 53) return `the DNS query to ${p.dst}`;
      if (p.srcPort === 53) return `the DNS answer from ${p.src}`;
      return `a UDP packet to ${p.dst} port ${p.dstPort}`;
    case 'arp':
      return p.what === 'request' ? `the ARP request for ${p.dst}` : `the ARP reply from ${p.src}`;
    case 'ospf':
      return 'an OSPF packet';
  }
}

// ------------------------------------------------------------------ explain

/** What went wrong at a drop, and the command that fixes it, run on the drop's device. */
function reasonOf(
  net: Network,
  where: Device,
  d: Drop,
): { text: string; fix: string | null; on?: string } {
  const p = d.packet;
  const wherePort = d.port ?? '';
  const stack = where.ip;
  const it = p ? describe(p) : 'the packet';
  const nameOf = (ip: string) => ownerOf(net, ip)?.name ?? ip;
  switch (d.reason) {
    case 'no-route': {
      const dst = p?.dst ?? '';
      if (d.forwarded) {
        const fix = routeFix(net, where, dst);
        return {
          text: `${where.name} received ${it} but has no route to ${dst}, so it cannot pass it on. Add a route for that network on ${where.name} (Config tab, Routing).`,
          fix,
        };
      }
      if (stack && stack.allAddrs().length === 0) {
        const first = where.ports.find(hasCarrier)?.name ?? 'eth0';
        return {
          text: `${where.name} has no IP address, so it cannot send anything. Get one from a DHCP server, or set one by hand with ip addr add.`,
          fix: `dhclient ${first}`,
        };
      }
      const ip = parseIp(dst);
      const dead = stack?.staticRoutes.find((r) => ip !== null && inSubnet(ip, r.dst));
      if (dead) {
        const via = dead.via === null ? dead.dev.name : formatIp(dead.via);
        return {
          text: `${where.name} has a route for ${dst} via ${via}, but it is not usable because ${via} is not on a network ${where.name} is connected to. Check the address and netmask of ${where.name}.`,
          fix: null,
        };
      }
      const gateway = gatewayFor(net, where);
      const fix = where.ip?.forwarding
        ? routeFix(net, where, dst)
        : gateway && p?.family !== 6
          ? `ip route add default via ${gateway}`
          : null;
      const hint = fix
        ? ''
        : ' Add a default route with ip route add default via <the router address>.';
      return {
        text: `${where.name} has no default gateway, so it does not know where to send packets for ${dst}.${hint}`,
        fix,
      };
    }
    case 'link-down': {
      const port = where.port(wherePort) ?? where.vlanPorts.find((x) => x.name === wherePort);
      const phys = port?.parent ?? port;
      if (d.cause === 'admin-down') {
        return {
          text: `${where.name} ${wherePort} is turned off, so nothing can leave through it.`,
          fix: `ip link set ${phys?.name ?? wherePort} up`,
        };
      }
      if (d.cause === 'peer-down' && phys) {
        const far = peerOf(phys);
        const fix = far ? `ip link set ${far.name} up` : null;
        return {
          text: `${where.name} ${wherePort} is cabled, but the other end (${far?.device.name ?? '?'} ${far?.name ?? ''}) is turned off, so there is no link.`,
          fix,
          ...(far && { on: far.device.name }),
        };
      }
      if (phys?.type === 'wifi') {
        const lost = net.drops
          .filter((x) => x.reason === 'wifi-out-of-range' && x.device === where.id)
          .at(-1);
        if (lost?.reason === 'wifi-out-of-range') {
          return {
            text: `${where.name} lost its Wi-Fi connection to ${lost.ssid} because it moved out of range. Move it closer to the access point and connect again.`,
            fix: `nmcli dev wifi connect ${lost.ssid}`,
          };
        }
        const best = scan(net, where)[0];
        if (!best) {
          return {
            text: `${where.name} is not connected to Wi-Fi, and no access point is in range. Move it closer to one.`,
            fix: null,
          };
        }
        const pass = best.ap.hostapd?.passphrase;
        return {
          text: `${where.name} is not connected to a Wi-Fi network, so it has no link.`,
          fix: `nmcli dev wifi connect ${best.ssid}${pass ? ` password ${pass}` : ''}`,
        };
      }
      return {
        text: `There is no cable plugged into ${where.name} ${wherePort}, so it has no link. Connect it to the next device with a cable.`,
        fix: null,
      };
    }
    case 'forwarding-off':
      return {
        text: `${where.name} received ${it} for another address, but it is a host and IP forwarding is off, so it threw the packet away. Turn forwarding on, or make the sender use a real router as its gateway.`,
        fix:
          p?.family === 6
            ? 'sysctl -w net.ipv6.conf.all.forwarding=1'
            : 'sysctl -w net.ipv4.ip_forward=1',
      };
    case 'ttl-expired':
      return {
        text: `The TTL of ${it} ran out at ${where.name}${wherePort ? ` (${wherePort})` : ''}. A packet only lives for a limited number of hops, so this usually means a routing loop between routers, or a very low ping -t.`,
        fix: null,
      };
    case 'arp-failed': {
      const owner = ownerOf(net, d.nextHop);
      const gateway = p !== null && d.nextHop !== p.dst;
      const who = gateway ? `its gateway ${d.nextHop}` : d.nextHop;
      if (!owner) {
        return {
          text: `${where.name} could not find the MAC address of ${who} on ${wherePort}: nobody answered ARP, and no device in the lab has that address. Check the address for typos.`,
          fix: null,
        };
      }
      return {
        text: `${where.name} could not find the MAC address of ${who} on ${wherePort}. ${owner.name} has that address, but its answer never arrived: check the cables and switch ports between them, and that they are in the same VLAN.`,
        fix: null,
      };
    }
    case 'netfilter': {
      const fam = d.family;
      const tables = where.ip?.nf.tables ?? [];
      const chain = tables
        .find((t) => t.name === d.table && t.family === fam)
        ?.chains.find((c) => c.name === d.chain);
      const rule = d.rule === null ? undefined : chain?.rules.find((r) => r.handle === d.rule);
      const verb = d.verdict === 'drop' ? 'dropped' : 'rejected';
      const policy = chain?.base?.policy ?? 'drop';
      const by =
        d.rule === null
          ? `no rule accepted it and the policy of chain ${d.chain} is ${policy}`
          : `rule "${rule ? formatRule(rule) : `handle ${d.rule}`}" (handle ${d.rule}) decided`;
      let fix: string | null = null;
      if (d.rule !== null) fix = `nft delete rule ${fam} ${d.table} ${d.chain} handle ${d.rule}`;
      else if (p) {
        const match =
          p.proto === 'icmp'
            ? 'ip protocol icmp'
            : p.proto === 'tcp' || p.proto === 'udp'
              ? `${p.proto} dport ${p.dstPort}`
              : null;
        if (match) fix = `nft add rule ${fam} ${d.table} ${d.chain} ${match} accept`;
      }
      return {
        text: `${where.name}'s firewall ${verb} ${it} (chain ${d.chain}, hook ${d.hook}): ${by}.`,
        fix,
      };
    }
    case 'no-listener': {
      const proto = p?.proto ?? 'tcp';
      const port = p?.dstPort ?? 0;
      const service = SERVICES[`${proto}/${port}`];
      const what = proto === 'tcp' ? 'connection request' : 'packet';
      return {
        text: `${where.name} received the ${what} but nothing is listening on ${proto.toUpperCase()} port ${port}${service ? `: its ${service.name} is not running` : ''}, so it refused it.`,
        fix: service?.start ?? null,
      };
    }
    case 'vlan-ingress': {
      const allowed = d.vids.length > 0 ? `VLANs ${d.vids.join(', ')}` : 'no VLANs';
      const vid = d.vid ?? d.vids[0] ?? 1;
      return {
        text:
          d.vid === null
            ? `${where.name} port ${wherePort} dropped ${it}: it arrived untagged and the port has no PVID (VLAN for untagged frames). The port allows ${allowed}.`
            : `${where.name} port ${wherePort} dropped ${it}: it is tagged VLAN ${d.vid}, but the port only allows ${allowed}.`,
        fix:
          d.vid === null
            ? `bridge vlan add dev ${wherePort} vid ${vid} pvid untagged`
            : `bridge vlan add dev ${wherePort} vid ${d.vid}`,
      };
    }
    case 'vlan-egress': {
      const src = p ? nameOf(p.src) : 'the sender';
      const other = d.others[0];
      const otherPort = other ? where.port(other.port) : undefined;
      const far = otherPort ? peerOf(otherPort) : null;
      const them = far?.device.name ?? (p ? nameOf(p.dst) : 'the receiver');
      const vlans = other?.vids.length ? `VLAN ${other.vids.join(', ')}` : 'no VLAN';
      const fix = other
        ? `bridge vlan add dev ${other.port} vid ${d.vid} pvid untagged${other.vids
            .filter((v) => v !== d.vid)
            .map((v) => ` && bridge vlan del dev ${other.port} vid ${v}`)
            .join('')}`
        : null;
      return {
        text: `${where.name} port ${wherePort} puts ${src} in VLAN ${d.vid}, but ${them}'s port ${other?.port ?? '?'} is in ${vlans}: they are separate networks, so the frame has nowhere to go. Put both ports in the same VLAN.`,
        fix,
        on: where.name,
      };
    }
    case 'stp-not-forwarding': {
      const secs = Math.round((where.bridge?.stp.forwardDelay ?? 15000) / 1000);
      return {
        text: `${where.name} port ${wherePort} is still in Spanning Tree state ${d.state}. After a link comes up a port waits ${secs} s in listening and again in learning before it forwards, to avoid loops. Wait and try again.`,
        fix: null,
      };
    }
    case 'wg-no-peer':
    case 'wg-no-endpoint':
    case 'wg-unknown-peer':
    case 'wg-allowed-ips': {
      const wg = where.wireguard(
        where.port(d.iface) ?? where.vlanPorts.find((x) => x.name === d.iface),
      );
      const peers = wg?.peers ?? [];
      const only = peers.length === 1 ? peers[0] : undefined;
      const known = only ? only.allowedIps.map(formatCidr) : [];
      const add = (ip: string | undefined) => (ip ? [...known, `${ip}/32`].join(',') : null);
      if (d.reason === 'wg-no-endpoint') {
        return {
          text: `${where.name}'s tunnel ${d.iface} has a peer for this traffic but no endpoint (the address and port to send to). Set one with wg set ${d.iface} peer <public key> endpoint <address>:51820.`,
          fix: null,
        };
      }
      if (d.reason === 'wg-no-peer') {
        const key = wg?.privateKey ? '' : ` ${where.name} has no private key set either.`;
        const fix =
          only && p ? `wg set ${d.iface} peer ${only.publicKey} allowed-ips ${add(p.dst)}` : null;
        return {
          text: `${where.name}'s tunnel ${d.iface} has no peer whose allowed-ips include ${p?.dst ?? 'the destination'}, so it has nobody to send it to.${key}`,
          fix,
        };
      }
      const fix =
        only && p ? `wg set ${d.iface} peer ${only.publicKey} allowed-ips ${add(p.src)}` : null;
      return {
        text: `${where.name}'s tunnel ${d.iface} dropped a packet from ${p?.src ?? '?'}: ${d.reason === 'wg-unknown-peer' ? 'it came from a peer that is not configured' : "that address is not in the sending peer's allowed-ips (WireGuard only accepts what a peer is allowed to send)"}.`,
        fix,
      };
    }
    case 'wifi-out-of-range':
      return {
        text: `${where.name} lost its Wi-Fi connection to ${d.ssid} because it moved out of range.`,
        fix: null,
      };
    case 'dns-nxdomain': {
      const at = d.server
        ? `The DNS server ${d.server}${ownerOf(net, d.server) ? ` (${nameOf(d.server)})` : ''}`
        : 'The DNS server';
      return {
        text: `${at} says that "${d.name}" does not exist. Check the spelling, or add the name on the DNS server (dnsmasq --address=/${d.name}/<address>).`,
        fix: null,
      };
    }
    case 'dns-no-server': {
      const port = where.ports.find(hasCarrier)?.name ?? 'eth0';
      const server = [...net.devices.values()].find(
        (s) =>
          s.dnsmasq &&
          s !== where &&
          s.ip?.allAddrs().some((a) => where.ip?.allAddrs().some((m) => inSubnet(a.ip, m))),
      );
      const addr = server?.ip
        ?.allAddrs()
        .find((a) => where.ip?.allAddrs().some((m) => inSubnet(a.ip, m)));
      return {
        text: `${where.name} has no DNS server set, so it cannot turn "${d.name}" into an address. Set one with resolvectl dns, or use the address directly.`,
        fix: addr ? `resolvectl dns ${port} ${formatIp(addr.ip)}` : null,
      };
    }
    case 'dns-refused':
      return {
        text: `The DNS server ${d.server ?? ''} answered that it does not run a DNS service, so "${d.name}" cannot be resolved. Start dnsmasq on it.`,
        fix: null,
      };
    case 'dns-timeout':
      return {
        text: `No answer from the DNS server ${d.server ?? ''} for "${d.name}" within 5 seconds. It may be off, or the queries or answers are being lost on the way.`,
        fix: null,
      };
  }
}

/** Packets of this conversation, in either direction, from `from` to `to`. */
function conversation(net: Network, device: Device, cmd: Parsed, run: CommandRun): Drop[] {
  const target = cmd.target;
  const known = target !== null && (parseIp(target) !== null || parseIp6(target) !== null);
  return net.drops.filter((d) => {
    if (d.seq <= run.after || d.seq > run.until) return false;
    if (!d.packet)
      return (
        d.device === device.id && d.reason.startsWith('dns-') && 'name' in d && d.name === target
      );
    const p = d.packet;
    if ((p.family === 6) !== cmd.v6) return false;
    // traceroute's probes die by design: at every hop, and at the destination.
    if (cmd.name === 'traceroute') {
      if (d.reason === 'ttl-expired') return false;
      if (d.reason === 'no-listener' && p.proto === 'udp') return false;
    }
    const mine = owns(device, p.src) || owns(device, p.dst);
    return mine || (known && (p.src === target || p.dst === target));
  });
}

/** Explains why a finished command failed, or says it did not. Null for other commands. */
export function explainFailure(net: Network, device: Device, run: CommandRun): Explanation | null {
  const cmd = parseCommand(run.line);
  if (!cmd) return null;
  const failed = commandFailed(run.line, run.output);
  const drops = conversation(net, device, cmd, run).sort(
    (a, b) => a.time - b.time || a.seq - b.seq,
  );
  if (!failed && drops.length === 0) {
    return {
      kind: 'ok',
      text: 'Nothing was dropped on the way and replies arrived, so this worked.',
      fix: null,
      deviceId: null,
    };
  }
  const target = cmd.target;
  const outbound = (d: Drop) =>
    !d.packet || owns(device, d.packet.src) || (target !== null && d.packet.dst === target);
  const first = drops.find(outbound) ?? drops[0];
  if (first) {
    const where = net.devices.get(first.device) ?? device;
    const back = !outbound(first);
    const { text, fix, on = where.name } = reasonOf(net, where, first);
    const lead = back
      ? `Your ${cmd.name === 'ping' ? 'ping' : 'request'} reached ${target ?? 'the destination'}, but the reply was lost on the way back. `
      : '';
    return {
      kind: 'dropped',
      text: `${lead}${text}`,
      fix,
      ...(fix && on !== device.name && { fixDevice: on }),
      deviceId: where.id,
    };
  }
  return explainWithoutDrops(net, device, cmd, run);
}

/** Failures that left no drop: look at how the device is set up. */
function explainWithoutDrops(
  net: Network,
  device: Device,
  cmd: Parsed,
  run: CommandRun,
): Explanation {
  const stack = device.ip;
  const here = (text: string, fix: string | null): Explanation => ({
    kind: 'config',
    text,
    fix,
    deviceId: device.id,
  });
  if (cmd.name === 'dig' && cmd.server === null && stack && stack.dns.length === 0) {
    return here(
      `${device.name} has no DNS server set, so dig has nobody to ask. Set one with resolvectl dns, or use dig @server.`,
      null,
    );
  }
  if (stack && stack.allAddrs().length === 0) {
    return here(
      `${device.name} has no IP address, so it cannot send anything. Get one from a DHCP server, or set one by hand with ip addr add.`,
      `dhclient ${device.ports.find(hasCarrier)?.name ?? 'eth0'}`,
    );
  }
  const hop = run.output.filter((l) => /^\s*\d+\s+\d+\.\d+\.\d+\.\d+/.test(l)).at(-1);
  const last = hop ? /^\s*(\d+)\s+(\d+\.\d+\.\d+\.\d+)/.exec(hop) : null;
  if (cmd.name === 'traceroute' && last) {
    return {
      kind: 'unknown',
      text: `The last router that answered was ${last[2] ?? ''} (hop ${last[1] ?? ''}). Packets are lost after it, but nothing reported why: check that router's routes and firewall.`,
      fix: null,
      deviceId: ownerOf(net, last[2] ?? '')?.id ?? null,
    };
  }
  return {
    kind: 'unknown',
    text: `No device reported dropping anything, so the cause is not clear from here. ${cmd.target ?? 'The target'} may be off or not answering, or the command was stopped before it could finish.`,
    fix: null,
    deviceId: null,
  };
}
