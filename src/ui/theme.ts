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

/**
 * The look of a downloaded progress report: a standalone file, so it cannot use the app's
 * `--nf-*` tokens. These are the light tokens of src/ui/index.css, kept in step by hand.
 */
export const REPORT_CSS = `
:root { --bg: #eff1ec; --surface: #fafaf7; --raised: #e9ece6; --border: #d3d8d0; --text: #1b211f; --muted: #5c6762; --accent: #0b6b4f; --ok: #1fa45b; --bad: #c8372d; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 Barlow, system-ui, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
h2 { margin: 2rem 0 .5rem; font-size: 1.1rem; }
p { margin: .25rem 0; }
.muted { color: var(--muted); }
code { font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace; }
.code { display: inline-block; padding: .1rem .5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 1.05rem; }
table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); }
th, td { padding: .4rem .6rem; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--raised); font-weight: 600; }
td.done { color: var(--accent); font-weight: 600; }
.note { margin-top: 2rem; padding: .6rem .8rem; border-left: 3px solid var(--accent); background: var(--raised); font-size: .9rem; }
`;
