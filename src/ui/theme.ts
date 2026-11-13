import type { Protocol } from '../engine/packet.ts';

/** Packet colors per protocol, shared by the canvas and the simulation panel. */
export const PROTOCOL_COLORS: Record<Protocol, string> = {
  arp: '#f59e0b',
  icmp: '#22c55e',
  udp: '#94a3b8',
  dhcp: '#a78bfa',
  dns: '#38bdf8',
  tcp: '#cbd5e1',
  http: '#f472b6',
  smtp: '#fb923c',
  pop3: '#facc15',
  ssh: '#2dd4bf',
};
