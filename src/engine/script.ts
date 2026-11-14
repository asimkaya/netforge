import { BIRD_CONF } from './bird.ts';
import type { Device } from './device.ts';
import { RADVD_CONF } from './ip6.ts';
import type { Network, NetworkSnapshot } from './network.ts';
import { SHADOW } from './ssh.ts';
import { SPECS } from './specs.ts';
import { DEFAULT_PRIORITY } from './stp.ts';
import { associatedAp } from './wifi.ts';

/**
 * Turns a lab into the shell commands that would configure the same thing on real Linux
 * machines. Pure: it reads the network's snapshot (the same data the save file holds) and
 * writes text. The commands use the simulator's own syntax, which copies the real tools, so
 * `script.test.ts` can run them back through the simulator and compare the result.
 */

type DeviceSnapshot = NetworkSnapshot['devices'][number];

/** Quotes a word for sh unless it is plain. */
function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const words = (args: readonly string[]): string => args.map(quote).join(' ');

/** `cat > PATH <<'EOF'` with the text as the body (a real shell adds the final newline). */
function heredoc(command: string, text: string): string[] {
  const body = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  let end = 'EOF';
  while (body.includes(end)) end += '_';
  return [`${command} <<'${end}'`, ...body, end];
}

/** The word after `flag` in an argument list. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** Files that matter on a real machine: changed or new ones, and what running services read. */
function filesToWrite(d: DeviceSnapshot): [string, string][] {
  const files = d.files ?? {};
  const defaults = SPECS[d.spec].files ?? {};
  const wanted = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    // Password hashes and mailboxes are state, not configuration.
    if (path === SHADOW || path.startsWith('/var/mail/')) continue;
    if (defaults[path] !== text) wanted.add(path);
  }
  const s = d.services ?? {};
  if (s.bird) wanted.add(after(s.bird, '-c') ?? BIRD_CONF);
  if (s.radvd) wanted.add(after(s.radvd, '-C') ?? RADVD_CONF);
  const conf = s.hostapd?.find((a) => !a.startsWith('-'));
  if (conf) wanted.add(conf);
  if (s.httpd) {
    const root = (after(s.httpd, '-h') ?? '/var/www/html').replace(/\/$/, '');
    for (const path of Object.keys(files)) if (path.startsWith(`${root}/`)) wanted.add(path);
  }
  return [...wanted]
    .sort()
    .flatMap((path) =>
      files[path] === undefined ? [] : [[path, files[path]] as [string, string]],
    );
}

/** Debian packages the commands of this device need. */
function packages(d: DeviceSnapshot): string[] {
  const s = d.services ?? {};
  return [
    'iproute2',
    ...(d.firewall !== undefined ? ['nftables'] : []),
    ...(d.ip && d.ip.dns.length > 0 ? ['systemd-resolved'] : []),
    ...(d.wireguard ? ['wireguard-tools'] : []),
    ...(s.dnsmasq ? ['dnsmasq'] : []),
    ...(s.dhcrelay ? ['isc-dhcp-relay'] : []),
    ...(s.bird ? ['bird2'] : []),
    ...(s.radvd ? ['radvd'] : []),
    ...(s.hostapd ? ['hostapd'] : []),
    ...(s.sshd ? ['openssh-server'] : []),
    ...(s.httpd ? ['busybox'] : []),
    ...(s.postfix ? ['postfix'] : []),
    ...(s.dovecot ? ['dovecot-pop3d'] : []),
  ];
}

/** `bridge vlan` commands that turn a port's default VLAN setup (VLAN 1) into `v`. */
function portVlans(port: string, v: { vids: number[]; pvid: number | null; untagged: number[] }) {
  const lines: string[] = [];
  for (const vid of v.vids) {
    const pvid = v.pvid === vid;
    const untagged = v.untagged.includes(vid);
    if (vid === 1 && pvid && untagged) continue;
    lines.push(
      `bridge vlan add dev ${port} vid ${vid}${pvid ? ' pvid' : ''}${untagged ? ' untagged' : ''}`,
    );
  }
  if (!v.vids.includes(1)) lines.push(`bridge vlan del dev ${port} vid 1`);
  return lines;
}

function bridgeLines(d: DeviceSnapshot): string[] {
  const b = d.bridge;
  if (!b) return [];
  const options = [
    ...(b.vlanFiltering ? ['vlan_filtering 1'] : []),
    ...(b.stp ? ['stp_state 1'] : []),
    ...(b.priority !== undefined && b.priority !== DEFAULT_PRIORITY
      ? [`priority ${b.priority}`]
      : []),
    ...(b.forwardDelay === undefined ? [] : [`forward_delay ${b.forwardDelay}`]),
  ];
  const vlans = Object.entries(b.vlans).flatMap(([port, v]) => portVlans(port, v));
  return [
    ...(options.length > 0 ? [`ip link set br0 type bridge ${options.join(' ')}`] : []),
    ...vlans,
  ];
}

/** Interface names with an address worth naming the DNS server on, else the first port. */
function dnsInterface(d: DeviceSnapshot): string {
  const withAddr = d.ports.find((p) => (p.addrs?.length ?? 0) > 0);
  return withAddr?.name ?? d.ports[0]?.name ?? 'eth0';
}

function serviceLines(d: DeviceSnapshot): string[] {
  const s = d.services;
  if (!s) return [];
  const start = (name: string, args: readonly string[]) =>
    args.length > 0 ? `${name} ${words(args)}` : name;
  return [
    ...(s.sshd
      ? [
          '# SSH server. Give root a password first: echo root:PASSWORD | chpasswd (or use keys).',
          'sshd',
        ]
      : []),
    ...(s.radvd ? [start('radvd', s.radvd)] : []),
    ...(s.bird
      ? [
          "# Debian's bird2 reads /etc/bird/bird.conf by default; pass -c if the file lives elsewhere.",
          start('bird', s.bird),
        ]
      : []),
    ...(s.hostapd ? [start('hostapd', s.hostapd)] : []),
    ...(s.dnsmasq ? [start('dnsmasq', s.dnsmasq)] : []),
    ...(s.dhcrelay ? [start('dhcrelay', s.dhcrelay)] : []),
    ...(s.httpd
      ? ['# busybox httpd; on Debian run it as: busybox httpd', start('httpd', s.httpd)]
      : []),
    ...(s.postfix ? ['postfix start'] : []),
    ...(s.dovecot ? ['dovecot'] : []),
  ];
}

function wireguardLines(d: DeviceSnapshot): string[] {
  const files = d.files ?? {};
  return (d.wireguard ?? []).flatMap((w) => {
    const lines: string[] = [];
    let keyPath: string | null = null;
    if (w.privateKey !== null) {
      const same = Object.entries(files).find(([, text]) => text.trim() === w.privateKey);
      keyPath = same ? same[0] : `/etc/wireguard/${w.name}.key`;
      if (!same) {
        lines.push(
          'umask 077',
          'mkdir -p /etc/wireguard',
          ...heredoc(`cat > ${keyPath}`, `${w.privateKey}\n`),
        );
      }
    }
    const set = [
      ...(keyPath === null ? [] : ['private-key', keyPath]),
      ...(w.listenPort === null ? [] : ['listen-port', String(w.listenPort)]),
      ...w.peers.flatMap((p) => [
        'peer',
        p.publicKey,
        ...(p.endpoint ? ['endpoint', p.endpoint] : []),
        'allowed-ips',
        p.allowedIps.join(','),
        ...(p.keepalive ? ['persistent-keepalive', String(p.keepalive)] : []),
      ]),
    ];
    if (set.length > 0) lines.push(`wg set ${w.name} ${words(set)}`);
    if (w.up) lines.push(`ip link set ${w.name} up`);
    return lines;
  });
}

/** The commands for one device, in the order a person would type them. */
export function deviceScript(
  net: Network,
  device: Device,
  snapshot: NetworkSnapshot = net.toJSON(),
): string[] {
  const d = snapshot.devices.find((x) => x.id === device.id);
  if (!d) return [];
  const spec = SPECS[d.spec];
  if (spec.id === 'internet') {
    return [
      `# ${d.name} (${spec.label}) is simulator-only: it stands for your ISP and the Internet.`,
      '# On a real lab, connect the machines to a real router or to the real Internet instead.',
    ];
  }
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length > 0) out.push('', `# ${title}`, ...lines);
  };

  out.push(
    `# ${d.name} (${spec.label})`,
    `# Debian packages: ${packages(d).join(' ')}`,
    '# Run as root. Interface names (eth0, wlan0...) can differ on a real machine: check `ip link`.',
    `hostname ${d.name}`,
  );

  const portByName = new Map(device.ports.map((p) => [p.name, p]));
  const links = d.ports.flatMap((p) => {
    const hasAddr = (p.addrs?.length ?? 0) > 0;
    if (!p.up) return [`ip link set ${p.name} down`];
    return portByName.get(p.name)?.link || hasAddr ? [`ip link set ${p.name} up`] : [];
  });
  section('Links', [
    ...(spec.bridge
      ? [
          '# A real switch is a Linux bridge: ip link add br0 type bridge, then for each port',
          '# ip link set PORT master br0, and ip link set br0 up. The simulator has br0 built in.',
        ]
      : []),
    ...links,
    ...(d.vlanPorts ?? []).flatMap((v) => [
      `ip link add link ${v.parent} name ${v.name} type vlan id ${v.vid}`,
      ...(v.up ? [`ip link set ${v.name} up`] : []),
    ]),
    ...(d.wireguard ?? []).map((w) => `ip link add ${w.name} type wireguard`),
  ]);

  const ap = associatedAp(device);
  if (ap?.hostapd) {
    const { ssid, passphrase } = ap.hostapd;
    section('Wi-Fi', [
      `nmcli dev wifi connect ${quote(ssid)}${passphrase === null ? '' : ` password ${quote(passphrase)}`}`,
    ]);
  }

  section('Switching', bridgeLines(d));

  const addr = (name: string, list: readonly string[] | undefined) =>
    (list ?? []).map((a) => `ip addr add ${a} dev ${name}`);
  section('Addresses', [
    ...d.ports.flatMap((p) => addr(p.name, p.addrs)),
    ...addr('br0', d.bridgeAddrs),
    ...(d.vlanPorts ?? []).flatMap((v) => addr(v.name, v.addrs)),
    ...(d.wireguard ?? []).flatMap((w) => addr(w.name, w.addrs)),
    ...Object.entries(d.ip6?.addrs ?? {}).flatMap(([name, list]) =>
      list.map((a) => `ip -6 addr add ${a} dev ${name}`),
    ),
  ]);

  section('Files', [
    ...[...new Set(filesToWrite(d).map(([path]) => dirOf(path)))]
      .filter((dir) => !['/', '/etc', '/root'].includes(dir))
      .map((dir) => `mkdir -p ${dir}`),
    ...filesToWrite(d).flatMap(([path, text]) => [
      ...(path.startsWith('/etc/wireguard/') ? [`# Keep ${path} private: chmod 600 ${path}`] : []),
      ...heredoc(`cat > ${path}`, text),
    ]),
  ]);

  section('WireGuard', wireguardLines(d));

  const route = (r: { dst: string; via?: string; dev: string }, family: string) => {
    const dst = /^(0\.0\.0\.0|::)\/0$/.test(r.dst) ? 'default' : r.dst;
    return `ip ${family}route add ${dst}${r.via ? ` via ${r.via}` : ''} dev ${r.dev}`;
  };
  const ip4 = d.ip;
  // Linux forwards nothing by default, so a router always needs these lines.
  const forwarding = [
    ...(ip4 && (ip4.forwarding || ip4.forwarding !== spec.forwarding)
      ? [`sysctl -w net.ipv4.ip_forward=${ip4.forwarding ? 1 : 0}`]
      : []),
    ...(d.ip6 && (d.ip6.forwarding || spec.forwarding)
      ? [`sysctl -w net.ipv6.conf.all.forwarding=${d.ip6.forwarding ? 1 : 0}`]
      : []),
  ];
  section('Routing', [
    ...forwarding,
    ...(ip4?.routes ?? []).map((r) => route(r, '')),
    ...(d.ip6?.routes ?? []).map((r) => route(r, '-6 ')),
    ...(ip4 && ip4.dns.length > 0
      ? [`resolvectl dns ${dnsInterface(d)} ${ip4.dns.join(' ')}`]
      : []),
  ]);

  if (d.firewall !== undefined) {
    section('Firewall and NAT (nftables)', heredoc('nft -f -', d.firewall));
  }
  section('Services', serviceLines(d));
  return out;
}

/** Lines after a heredoc opener, up to its terminator, must not be indented. */
function indent(lines: string[]): string[] {
  let end: string | null = null;
  return lines.map((line) => {
    if (end !== null) {
      if (line === end) end = null;
      return line;
    }
    const m = /<<'(\w+)'$/.exec(line);
    if (m) end = m[1] ?? null;
    return line === '' ? '' : `  ${line}`;
  });
}

/** One POSIX sh file for the whole lab: it configures whichever machine runs it. */
export function labScript(net: Network): string {
  const snapshot = net.toJSON();
  const devices = [...net.devices.values()];
  const names = devices.map((d) => d.name);
  const cases = devices.flatMap((device) => [
    `${device.name})`,
    ...indent(deviceScript(net, device, snapshot)),
    '  ;;',
  ]);
  return [
    '#!/bin/sh',
    '# NetForge lab export: the commands that configure this lab on real Linux machines.',
    '#',
    '# Run this one file, as root, on every machine of a real lab. It looks at the',
    "# machine's hostname (set it first with: hostnamectl set-hostname NAME) and runs only",
    '# the commands for that machine. Start the machines in any order; a Wi-Fi client',
    '# needs its access point running first.',
    '# Lines that start with # explain what a command does or where a real machine differs.',
    '# Generated from the lab in the browser: it describes the lab as it was when exported.',
    '',
    'case "$(hostname)" in',
    ...cases,
    '*)',
    `  echo "Unknown hostname: $(hostname). This lab knows: ${names.join(' ')}" >&2`,
    '  exit 1',
    '  ;;',
    'esac',
    '',
  ].join('\n');
}
