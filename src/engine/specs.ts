import type { PortType } from './port.ts';

export type SpecId = 'pc' | 'server' | 'switch' | 'router';

/**
 * What a device is made of. Adding a device type means adding a spec here (and its
 * faceplate in the UI), not writing a new class. See ADR 0006.
 */
export interface DeviceSpec {
  id: SpecId;
  label: string;
  description: string;
  /** Default hostnames are prefix + counter, e.g. pc1, sw2. */
  namePrefix: string;
  ports: { name: string; type: PortType }[];
  /** All ports are enslaved to one learning bridge (L2 switching). */
  bridge: boolean;
  /** Runs an IP stack on the ports that are not bridged. */
  ip: boolean;
  /** Initial `net.ipv4.ip_forward`: forwards packets between its interfaces. */
  forwarding: boolean;
  /** Files a new device starts with. */
  files?: Record<string, string>;
}

function ports(type: PortType, from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `eth${from + i}`, type }));
}

const SAMPLE_PAGE = `<!doctype html>
<html>
  <head><title>It works!</title></head>
  <body>
    <h1>It works!</h1>
    <p>This page is served by NetForge's httpd from /var/www/html/index.html.</p>
    <p>Edit it with the Text Editor, or: echo "&lt;h1&gt;Hello&lt;/h1&gt;" &gt; /var/www/html/index.html</p>
  </body>
</html>
`;

export const SPECS: Record<SpecId, DeviceSpec> = {
  pc: {
    id: 'pc',
    label: 'PC',
    description: 'A computer with one Ethernet port',
    namePrefix: 'pc',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    ip: true,
    forwarding: false,
  },
  server: {
    id: 'server',
    label: 'Server',
    description: 'A server with one Ethernet port and a sample website in /var/www/html',
    namePrefix: 'srv',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    ip: true,
    forwarding: false,
    files: {
      '/var/www/html/index.html': SAMPLE_PAGE,
    },
  },
  switch: {
    id: 'switch',
    label: 'Switch',
    description: 'Unmanaged switch: 8 Ethernet ports and 2 fiber (SFP) uplinks',
    namePrefix: 'sw',
    ports: [...ports('ethernet', 0, 8), ...ports('sfp', 8, 2)],
    bridge: true,
    ip: false,
    forwarding: false,
  },
  router: {
    id: 'router',
    label: 'Router',
    description: 'Linux router with 4 Ethernet ports; forwards packets between networks',
    namePrefix: 'r',
    ports: ports('ethernet', 0, 4),
    bridge: false,
    ip: true,
    forwarding: true,
  },
};

export function isSpecId(value: unknown): value is SpecId {
  return typeof value === 'string' && Object.hasOwn(SPECS, value);
}
