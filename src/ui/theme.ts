import type { Protocol } from '../engine/packet.ts';

/** Packet colors per protocol, shared by the canvas and the simulation panel. Mid-tones: they stay visible on both theme backgrounds. */
export const PROTOCOL_COLORS: Record<Protocol, string> = {
  arp: '#c27800',
  stp: '#c04fd0',
  icmp: '#1f9d55',
  icmp6: '#2f9a8a',
  ospf: '#6a8f18',
  wireguard: '#6c7be0',
  udp: '#7d8a96',
  dhcp: '#8b6fe0',
  dns: '#1e90d6',
  tcp: '#857a6c',
  http: '#e0508f',
  smtp: '#d4631c',
  pop3: '#9c8800',
  ssh: '#0f8a9a',
};
