import type { PortType } from './port.ts';

export type SpecId = 'pc' | 'switch';

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
}

function ports(type: PortType, from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `eth${from + i}`, type }));
}

export const SPECS: Record<SpecId, DeviceSpec> = {
  pc: {
    id: 'pc',
    label: 'PC',
    description: 'A computer with one Ethernet port',
    namePrefix: 'pc',
    ports: ports('ethernet', 0, 1),
    bridge: false,
    ip: true,
  },
  switch: {
    id: 'switch',
    label: 'Switch',
    description: 'Unmanaged switch: 8 Ethernet ports and 2 fiber (SFP) uplinks',
    namePrefix: 'sw',
    ports: [...ports('ethernet', 0, 8), ...ports('sfp', 8, 2)],
    bridge: true,
    ip: false,
  },
};

export function isSpecId(value: unknown): value is SpecId {
  return typeof value === 'string' && Object.hasOwn(SPECS, value);
}
