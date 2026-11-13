import type { Mac } from './addr.ts';
import type { Device } from './device.ts';

/** Physical socket type. Decides which cable fits. */
export type PortType = 'ethernet' | 'sfp' | 'wifi';
/** Cable type, derived from the ports it joins; `wireless` links come from Wi-Fi association. */
export type Medium = 'copper' | 'fiber' | 'wireless';

export const MEDIUM_OF: Record<PortType, Medium> = {
  ethernet: 'copper',
  sfp: 'fiber',
  wifi: 'wireless',
};
export const PORT_TYPE_LABEL: Record<PortType, string> = {
  ethernet: 'Ethernet (copper)',
  sfp: 'SFP (fiber)',
  wifi: 'Wi-Fi radio',
};

export interface Port {
  readonly name: string;
  readonly type: PortType;
  readonly mac: Mac;
  readonly device: Device;
  link: Link | null;
  /** Administrative state (`ip link set <port> up|down`). */
  adminUp: boolean;
  /** VLAN interfaces (`eth0.10`) sit on a parent port and tag what they send with `vid`. */
  readonly parent?: Port;
  readonly vid?: number;
}

export interface Link {
  readonly id: string;
  readonly a: Port;
  readonly b: Port;
  readonly medium: Medium;
}

export function peerOf(port: Port): Port | null {
  const link = port.link;
  if (!link) return null;
  return link.a === port ? link.b : link.a;
}

/** Carrier is up when both ends are cabled and administratively up. */
export function hasCarrier(port: Port): boolean {
  if (port.parent) return port.adminUp && hasCarrier(port.parent);
  const peer = peerOf(port);
  return port.adminUp && peer !== null && peer.adminUp;
}

/**
 * Why two ports can't take one cable, in user-facing words, or null if they can. Wi-Fi radios
 * only link through association (`wireless`), never with a cable.
 */
export function cableError(a: Port, b: Port, wireless = false): string | null {
  if (a === b) return 'A port cannot be connected to itself.';
  if (!wireless && (a.type === 'wifi' || b.type === 'wifi')) {
    const radio = a.type === 'wifi' ? a : b;
    return `${radio.device.name} ${radio.name} is a Wi-Fi radio: join a wireless network instead of plugging a cable (nmcli dev wifi connect).`;
  }
  if (a.link) return `${a.device.name} ${a.name} already has a cable.`;
  if (b.link) return `${b.device.name} ${b.name} already has a cable.`;
  if (MEDIUM_OF[a.type] !== MEDIUM_OF[b.type]) {
    return `${a.device.name} ${a.name} is ${PORT_TYPE_LABEL[a.type]} but ${b.device.name} ${b.name} is ${PORT_TYPE_LABEL[b.type]}. They need different cables.`;
  }
  return null;
}
