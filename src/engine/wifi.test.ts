import { describe, expect, it } from 'vitest';
import type { Device } from './device.ts';
import { Network } from './network.ts';
import { run } from './shell.ts';
import { WIFI_RANGE, checkWireless } from './wifi.ts';

function sh(net: Network, device: Device, line: string, ms = 30_000): string[] {
  const lines: string[] = [];
  let done = false;
  const proc = run(net, device, line, { out: (l) => lines.push(l), exit: () => (done = true) });
  for (let t = 0; proc && !done && t < ms; t += 100)
    net.scheduler.runUntil(net.scheduler.now + 100);
  return lines;
}

/** A router with DHCP on its LAN, an AP cabled to it, and wireless clients placed on a line. */
function lab() {
  const net = new Network();
  const where = new Map<string, { x: number; y: number }>();
  net.locate = (id) => where.get(id) ?? null;
  const place = (d: Device, x: number) => where.set(d.id, { x, y: 0 });
  const r1 = net.addDevice('router');
  const ap = net.addDevice('ap');
  const laptop = net.addDevice('laptop');
  const phone = net.addDevice('phone');
  place(ap, 0);
  place(laptop, 100);
  place(phone, WIFI_RANGE + 50);
  net.connect(ap.port('eth0') ?? (undefined as never), r1.port('eth0') ?? (undefined as never));
  sh(net, r1, 'ip addr add 192.168.1.1/24 dev eth0');
  sh(net, r1, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199');
  return { net, ap, laptop, phone, place };
}

describe('Wi-Fi', () => {
  it('starts access points ready, with hostapd running', () => {
    const { ap } = lab();
    expect(ap.hostapd).toMatchObject({ ssid: 'NetForge', passphrase: 'netforge123' });
  });

  it('lists networks in range and joins with the right password', () => {
    const { net, laptop, phone } = lab();
    const list = sh(net, laptop, 'nmcli dev wifi list');
    expect(list[0]).toBe('IN-USE  SSID              MODE   CHAN  SIGNAL  BARS  SECURITY');
    expect(list[1]).toMatch(/^ {8}NetForge {10}Infra {2}6 {5}79 {6}▂▄▆█ {2}WPA2$/);
    expect(sh(net, phone, 'nmcli dev wifi list')).toHaveLength(1);
    expect(sh(net, laptop, 'nmcli dev wifi connect NetForge password wrong')).toEqual([
      'Error: Connection activation failed: Secrets were required, but not provided.',
    ]);
    expect(sh(net, laptop, 'nmcli dev wifi connect Other password x')).toEqual([
      "Error: No network with SSID 'Other' found.",
    ]);
    expect(sh(net, phone, 'nmcli dev wifi connect NetForge password netforge123')).toEqual([
      "Error: No network with SSID 'NetForge' found.",
    ]);
    expect(sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123')).toEqual([
      "Device 'wlan0' successfully activated with 'NetForge'.",
    ]);
    expect(sh(net, laptop, 'nmcli dev wifi list')[1]?.startsWith('*')).toBe(true);
    expect(sh(net, laptop, 'nmcli dev status')).toEqual([
      'DEVICE  TYPE      STATE         CONNECTION',
      'eth0    ethernet  unavailable   --',
      'wlan0   wifi      connected     NetForge',
    ]);
  });

  it('bridges wireless clients to the wired network behind the access point', () => {
    const { net, laptop, phone, place } = lab();
    place(phone, 150);
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    sh(net, phone, 'nmcli dev wifi connect NetForge password netforge123');
    expect(sh(net, laptop, 'dhclient wlan0').at(-1)).toContain('bound to 192.168.1.100');
    expect(sh(net, phone, 'dhclient wlan0').at(-1)).toContain('bound to 192.168.1.101');
    expect(sh(net, phone, 'ping -c 1 192.168.1.100')).toContain(
      '1 packets transmitted, 1 received, 0% packet loss, time 2ms',
    );
    const wireless = [...net.links.values()].filter((l) => l.medium === 'wireless');
    expect(wireless).toHaveLength(2);
  });

  it('drops clients that walk away or whose access point stops', () => {
    const { net, ap, laptop, place } = lab();
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    place(laptop, WIFI_RANGE + 1);
    checkWireless(net);
    expect(laptop.port('wlan0')?.link).toBeNull();
    place(laptop, 50);
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    expect(sh(net, ap, 'killall hostapd')).toEqual([]);
    expect(laptop.port('wlan0')?.link).toBeNull();
    expect(sh(net, laptop, 'nmcli dev wifi list')).toHaveLength(1);
  });

  it('refuses cables on radios and keeps associations across a save and load', () => {
    const { net, ap, laptop } = lab();
    const other = net.addDevice('pc');
    expect(() =>
      net.connect(
        other.ports[0] ?? (undefined as never),
        laptop.port('wlan0') ?? (undefined as never),
      ),
    ).toThrow(/Wi-Fi radio/);
    sh(net, laptop, 'nmcli dev wifi connect NetForge password netforge123');
    const copy = Network.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.devices.get(ap.id)?.hostapd?.ssid).toBe('NetForge');
    expect(copy.devices.get(laptop.id)?.port('wlan0')?.link?.medium).toBe('wireless');
  });

  it('reads its settings from hostapd.conf', () => {
    const { net, ap } = lab();
    sh(net, ap, 'killall hostapd');
    sh(net, ap, 'echo "ssid=Cafe" > /etc/hostapd/hostapd.conf');
    expect(sh(net, ap, 'hostapd -B /etc/hostapd/hostapd.conf')).toEqual(['wlan0: AP-ENABLED']);
    expect(ap.hostapd).toMatchObject({ ssid: 'Cafe', passphrase: null });
    sh(net, ap, 'killall hostapd');
    sh(net, ap, 'echo -e "ssid=Cafe\\nwpa=2\\nwpa_passphrase=short" > /etc/hostapd/hostapd.conf');
    expect(sh(net, ap, 'hostapd -B /etc/hostapd/hostapd.conf')).toEqual([
      'Line: invalid WPA passphrase length 5 (expected 8..63)',
    ]);
  });
});
