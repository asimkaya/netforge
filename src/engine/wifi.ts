import type { Device } from './device.ts';
import { normalizePath } from './fs.ts';
import type { Network } from './network.ts';
import { peerOf, type Port } from './port.ts';

/** How far (in canvas units) an access point reaches. */
export const WIFI_RANGE = 340;

export interface HostapdConfig {
  ssid: string;
  /** WPA2 passphrase, or null for an open network. */
  passphrase: string | null;
}

/** Parses hostapd.conf (`ssid=`, `wpa=2`, `wpa_passphrase=`). Errors use hostapd's wording. */
export function parseHostapdConf(text: string): HostapdConfig | string {
  let ssid = '';
  let passphrase: string | null = null;
  let wpa = false;
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) return `Line ${i + 1}: invalid line '${line}'`;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'ssid') ssid = value;
    else if (key === 'wpa_passphrase') passphrase = value;
    else if (key === 'wpa') wpa = value !== '0';
  }
  if (!ssid || ssid.length > 32) return 'Configuration error: invalid SSID (1 to 32 characters)';
  if (wpa && (passphrase === null || passphrase.length < 8 || passphrase.length > 63)) {
    return `Line: invalid WPA passphrase length ${passphrase?.length ?? 0} (expected 8..63)`;
  }
  return { ssid, passphrase: wpa ? passphrase : null };
}

/** `hostapd [-B] CONFIG`: reads the config file and starts the access point. */
export function startHostapd(device: Device, args: readonly string[]): HostapdConfig | string {
  const file = args.filter((a) => !a.startsWith('-'))[0];
  const path = file === undefined ? null : normalizePath(file);
  if (!device.bridge?.ports.some((p) => p.type === 'wifi')) return 'hostapd: no wireless interface';
  if (path === null) return 'Usage: hostapd [-B] <configuration file>';
  const text = device.fs?.read(path);
  if (text === undefined) return `Could not open configuration file '${file}' for reading.`;
  return parseHostapdConf(text);
}

function distance(net: Network, a: Device, b: Device): number | null {
  const pa = net.locate?.(a.id);
  const pb = net.locate?.(b.id);
  if (!pa || !pb) return null;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

export interface WifiNetwork {
  ap: Device;
  ssid: string;
  secured: boolean;
  /** 0-100, from distance. */
  signal: number;
}

/** Access points with a running hostapd that `client` can hear, strongest first. */
export function scan(net: Network, client: Device): WifiNetwork[] {
  const found: WifiNetwork[] = [];
  for (const ap of net.devices.values()) {
    if (ap === client || !ap.hostapd) continue;
    const d = distance(net, ap, client);
    if (d === null || d > WIFI_RANGE) continue;
    found.push({
      ap,
      ssid: ap.hostapd.ssid,
      secured: ap.hostapd.passphrase !== null,
      signal: Math.round(100 - (d / WIFI_RANGE) * 70),
    });
  }
  return found.sort((a, b) => b.signal - a.signal || a.ap.id.localeCompare(b.ap.id));
}

export function radioOf(device: Device): Port | undefined {
  return device.ports.find((p) => p.type === 'wifi');
}

/** The access point a client's radio is associated with, if any. */
export function associatedAp(client: Device): Device | null {
  const radio = radioOf(client);
  return radio ? (peerOf(radio)?.device ?? null) : null;
}

export function disconnectWifi(net: Network, client: Device): boolean {
  const link = radioOf(client)?.link;
  if (!link) return false;
  net.disconnect(link);
  return true;
}

/**
 * Joins the strongest access point with `ssid` in range. Returns null, or an error message in
 * NetworkManager's words.
 */
export function connectWifi(
  net: Network,
  client: Device,
  ssid: string,
  password: string | null,
): string | null {
  const radio = radioOf(client);
  if (!radio) return 'Error: No Wi-Fi device found.';
  const choice = scan(net, client).find((n) => n.ssid === ssid);
  if (!choice) return `Error: No network with SSID '${ssid}' found.`;
  const config = choice.ap.hostapd;
  if (config?.passphrase !== null && config?.passphrase !== password) {
    return 'Error: Connection activation failed: Secrets were required, but not provided.';
  }
  const slot = choice.ap.bridge?.ports.find((p) => p.type === 'wifi' && !p.link);
  if (!slot) return 'Error: Connection activation failed: The access point is full.';
  disconnectWifi(net, client);
  net.associate(radio, slot);
  return null;
}

/** Drops clients that moved out of range or whose access point stopped. */
export function checkWireless(net: Network): void {
  for (const link of [...net.links.values()]) {
    if (link.medium !== 'wireless') continue;
    const ap = link.a.device.hostapd ? link.a.device : link.b.device;
    const client = ap === link.a.device ? link.b.device : link.a.device;
    const d = distance(net, ap, client);
    const outOfRange = d !== null && d > WIFI_RANGE;
    if (ap.hostapd && outOfRange) {
      const radio = link.a.device === client ? link.a : link.b;
      net.drop(client, radio, { reason: 'wifi-out-of-range', ssid: ap.hostapd.ssid }, null);
    }
    if (!ap.hostapd || outOfRange) net.disconnect(link);
  }
}
