import { describe, expect, test } from 'vitest';
import { Network } from './network.ts';
import { deviceScript, labScript } from './script.ts';
import { port, sh } from './testing.ts';

const RUN_AS_ROOT =
  '# Run as root. Interface names (eth0, wlan0...) can differ on a real machine: check `ip link`.';

describe('deviceScript', () => {
  test('a PC: link, address, default route and DNS', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    const sw = net.addDevice('switch');
    net.connect(port(pc, 'eth0'), port(sw, 'eth0'));
    sh(net, pc, 'ip addr add 192.168.1.10/24 dev eth0');
    sh(net, pc, 'ip route add default via 192.168.1.1');
    sh(net, pc, 'resolvectl dns eth0 192.168.1.1');
    expect(deviceScript(net, pc)).toEqual([
      '# pc1 (PC)',
      '# Debian packages: iproute2 systemd-resolved',
      RUN_AS_ROOT,
      'hostname pc1',
      '',
      '# Links',
      'ip link set eth0 up',
      '',
      '# Addresses',
      'ip addr add 192.168.1.10/24 dev eth0',
      '',
      '# Routing',
      'ip route add default via 192.168.1.1 dev eth0',
      'resolvectl dns eth0 192.168.1.1',
    ]);
  });

  test('a router with NAT and DHCP: forwarding, nftables heredoc, services last', () => {
    const net = new Network();
    const r = net.addDevice('router');
    sh(net, r, 'ip addr add 192.168.1.1/24 dev eth1');
    sh(net, r, 'sysctl -w net.ipv4.ip_forward=1');
    sh(net, r, 'nft add table ip nat');
    sh(net, r, 'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }');
    sh(net, r, 'nft add rule ip nat postrouting oifname "eth0" masquerade');
    sh(net, r, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199 --host-record=a.lan,192.168.1.5');
    expect(deviceScript(net, r)).toEqual([
      '# r1 (Router)',
      '# Debian packages: iproute2 nftables dnsmasq',
      RUN_AS_ROOT,
      'hostname r1',
      '',
      '# Links',
      'ip link set eth1 up',
      '',
      '# Addresses',
      'ip addr add 192.168.1.1/24 dev eth1',
      '',
      '# Routing',
      'sysctl -w net.ipv4.ip_forward=1',
      'sysctl -w net.ipv6.conf.all.forwarding=1',
      '',
      '# Firewall and NAT (nftables)',
      "nft -f - <<'EOF'",
      'table ip nat {',
      '\tchain postrouting {',
      '\t\ttype nat hook postrouting priority srcnat; policy accept;',
      '\t\toifname "eth0" masquerade',
      '\t}',
      '}',
      'EOF',
      '',
      '# Services',
      'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199 --host-record=a.lan,192.168.1.5',
    ]);
  });

  test('a switch with VLANs and STP: bridge settings and per-port VLANs', () => {
    const net = new Network();
    const sw = net.addDevice('switch');
    const pc = net.addDevice('pc');
    net.connect(port(pc, 'eth0'), port(sw, 'eth0'));
    sh(net, sw, 'ip link set br0 type bridge vlan_filtering 1 stp_state 1 priority 4096');
    sh(net, sw, 'bridge vlan add dev eth0 vid 10 pvid untagged');
    sh(net, sw, 'bridge vlan del dev eth0 vid 1');
    sh(net, sw, 'bridge vlan add dev eth7 vid 10');
    sh(net, sw, 'bridge vlan add dev eth7 vid 20');
    expect(deviceScript(net, sw)).toEqual([
      '# sw1 (Switch)',
      '# Debian packages: iproute2',
      RUN_AS_ROOT,
      'hostname sw1',
      '',
      '# Links',
      '# A real switch is a Linux bridge: ip link add br0 type bridge, then for each port',
      '# ip link set PORT master br0, and ip link set br0 up. The simulator has br0 built in.',
      'ip link set eth0 up',
      '',
      '# Switching',
      'ip link set br0 type bridge vlan_filtering 1 stp_state 1 priority 4096',
      'bridge vlan add dev eth0 vid 10 pvid untagged',
      'bridge vlan del dev eth0 vid 1',
      'bridge vlan add dev eth7 vid 10',
      'bridge vlan add dev eth7 vid 20',
    ]);
  });

  test('a WireGuard router: key file, wg set with a peer, the interface up', () => {
    const net = new Network();
    const r = net.addDevice('router');
    const peerKey = (sh(net, r, 'wg genkey | wg pubkey')[0] ?? '').trim();
    sh(net, r, 'ip link add wg0 type wireguard');
    sh(net, r, 'wg genkey > /etc/wireguard/key');
    const key = (sh(net, r, 'cat /etc/wireguard/key')[0] ?? '').trim();
    sh(net, r, 'wg set wg0 private-key /etc/wireguard/key listen-port 51820');
    sh(
      net,
      r,
      `wg set wg0 peer ${peerKey} endpoint 203.0.113.9:51820 allowed-ips 10.9.0.2/32,192.168.2.0/24 persistent-keepalive 25`,
    );
    sh(net, r, 'ip addr add 10.9.0.1/24 dev wg0');
    sh(net, r, 'ip link set wg0 up');
    sh(net, r, 'ip route add 192.168.2.0/24 dev wg0');
    expect(deviceScript(net, r)).toEqual([
      '# r1 (Router)',
      '# Debian packages: iproute2 wireguard-tools',
      RUN_AS_ROOT,
      'hostname r1',
      '',
      '# Links',
      'ip link add wg0 type wireguard',
      '',
      '# Addresses',
      'ip addr add 10.9.0.1/24 dev wg0',
      '',
      '# Files',
      'mkdir -p /etc/wireguard',
      '# Keep /etc/wireguard/key private: chmod 600 /etc/wireguard/key',
      "cat > /etc/wireguard/key <<'EOF'",
      key,
      'EOF',
      '',
      '# WireGuard',
      `wg set wg0 private-key /etc/wireguard/key listen-port 51820 peer ${peerKey} endpoint 203.0.113.9:51820 allowed-ips 10.9.0.2/32,192.168.2.0/24 persistent-keepalive 25`,
      'ip link set wg0 up',
      '',
      '# Routing',
      'sysctl -w net.ipv4.ip_forward=1',
      'sysctl -w net.ipv6.conf.all.forwarding=1',
      'ip route add 192.168.2.0/24 dev wg0',
    ]);
  });

  test('the Internet cloud gets a comment instead of commands', () => {
    const net = new Network();
    const cloud = net.addDevice('internet');
    const lines = deviceScript(net, cloud);
    expect(lines.every((l) => l.startsWith('# '))).toBe(true);
    expect(lines[0]).toContain('simulator-only');
  });
});

describe('labScript', () => {
  test('one case branch per device, a default branch, heredocs left unindented', () => {
    const net = new Network();
    const pc = net.addDevice('pc');
    const r = net.addDevice('router');
    net.addDevice('internet');
    sh(net, pc, 'ip addr add 192.168.1.10/24 dev eth0');
    sh(net, r, 'nft add table ip nat');
    const text = labScript(net);
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain('case "$(hostname)" in\npc1)\n');
    expect(text).toContain('\nr1)\n');
    expect(text).toContain('\ninternet1)\n');
    expect(text).toContain('This lab knows: pc1 r1 internet1');
    expect(text).toContain("\n  nft -f - <<'EOF'\ntable ip nat {\n}\nEOF\n");
    expect(text.trimEnd().endsWith('esac')).toBe(true);
  });
});
