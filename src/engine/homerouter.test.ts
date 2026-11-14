import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

const wait = (net: Network, ms = 10_000) => net.scheduler.runUntil(net.scheduler.now + ms);
const received = (lines: string[]) => lines.some((l) => / [1-9]\d* received/.test(l));
const port = (d: Device, name: string) => d.port(name) ?? (undefined as never);

/** A home router plugged into the Internet, a PC on a LAN port, a phone near it. */
function lab() {
  const net = new Network();
  const where = new Map<string, { x: number; y: number }>();
  net.locate = (id) => where.get(id) ?? null;
  const inet = net.addDevice('internet');
  const home = net.addDevice('homerouter');
  const pc = net.addDevice('pc');
  const phone = net.addDevice('phone');
  where.set(home.id, { x: 0, y: 0 });
  where.set(phone.id, { x: 100, y: 0 });
  net.connect(port(home, 'eth0'), port(inet, 'eth0'));
  net.connect(port(pc, 'eth0'), port(home, 'eth2'));
  wait(net);
  return { net, inet, home, pc, phone };
}

describe('home router', () => {
  it('comes ready: LAN on br0, DHCP, Wi-Fi, NAT and a firewall', () => {
    const { net, home } = lab();
    expect(sh(net, home, 'ip -4 addr show br0')).toEqual([
      `15: br0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP`,
      `    link/ether ${port(home, 'eth1').mac} brd ff:ff:ff:ff:ff:ff`,
      '    inet 192.168.1.1/24 brd 192.168.1.255 scope global br0',
    ]);
    // The WAN port asked the provider for an address when it was plugged in.
    expect(sh(net, home, 'ip -4 addr show eth0').at(-1)).toBe(
      '    inet 192.0.2.100/24 brd 192.0.2.255 scope global eth0',
    );
    expect(sh(net, home, 'ip route')[0]).toBe('default via 192.0.2.1 dev eth0');
    expect(home.dnsmasq).not.toBeNull();
    expect(home.hostapd?.ssid).toBe('HomeWiFi');
    expect(sh(net, home, 'nft list ruleset')).toContain('\t\toifname "eth0" masquerade');
  });

  it('gives wired and wireless devices addresses and Internet access', () => {
    const { net, inet, home, pc, phone } = lab();
    expect(sh(net, pc, 'dhclient eth0').at(-1)).toContain('bound to 192.168.1.100');
    expect(sh(net, pc, 'ip route')[0]).toBe('default via 192.168.1.1 dev eth0');
    expect(received(sh(net, pc, 'ping -c 1 198.18.0.10'))).toBe(true);
    expect(sh(net, pc, 'curl -s http://198.18.0.10/').join('\n')).toContain(
      'Hello from the Internet',
    );
    expect(sh(net, phone, 'nmcli dev wifi connect HomeWiFi password netforge123')).toEqual([
      "Device 'wlan0' successfully activated with 'HomeWiFi'.",
    ]);
    expect(sh(net, phone, 'dhclient wlan0').at(-1)).toContain('bound to 192.168.1.101');
    expect(received(sh(net, phone, 'ping -c 1 192.168.1.100'))).toBe(true);
    expect(received(sh(net, phone, 'ping -c 1 198.18.0.10'))).toBe(true);
    // Nothing from the Internet reaches inside, even with a route.
    sh(net, inet, 'ip route add 192.168.1.0/24 via 192.0.2.100');
    expect(received(sh(net, inet, 'ping -c 1 192.168.1.100'))).toBe(false);
    expect(sh(net, home, 'bridge fdb').length).toBeGreaterThan(0);
  });

  it('keeps its LAN address across a save and load', () => {
    const { net, home, pc } = lab();
    sh(net, pc, 'dhclient eth0');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
    const h = copy.devices.get(home.id) ?? home;
    expect(sh(copy, h, 'ip -4 addr show br0').at(-1)).toContain('inet 192.168.1.1/24');
    const p = copy.devices.get(pc.id) ?? pc;
    expect(received(sh(copy, p, 'ping -c 1 198.18.0.10'))).toBe(true);
  });
});
