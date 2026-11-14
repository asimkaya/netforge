import { describe, expect, it } from 'vitest';
import { copyOf, paste } from './clipboard.ts';
import { Lab } from './labBuilder.ts';
import { emptyProgress, type Project } from './project.ts';

function smallLab(): Project {
  const lab = new Lab();
  const pc1 = lab.add('pc', 0, 0);
  const pc2 = lab.add('pc', 200, 0);
  const sw = lab.add('switch', 0, 200);
  const outsider = lab.add('router', 400, 200);
  lab.cable(pc1, 'eth0', sw, 'eth0');
  lab.cable(pc2, 'eth0', sw, 'eth1');
  lab.cable(outsider, 'eth0', sw, 'eth2');
  lab.sh(pc1, 'ip addr add 10.0.0.1/24 dev eth0', 'ip route add 10.9.0.0/24 via 10.0.0.254');
  lab.sh(sw, 'ip link set br0 type bridge vlan_filtering 1', 'bridge vlan add dev eth0 vid 10');
  return { ...lab.done(), tasks: emptyProgress() };
}

const byName = (p: Project, name: string) =>
  [...p.net.devices.values()].find((d) => d.name === name);

describe('copy and paste', () => {
  it('adds copies with new names and MACs, their cables, and the same configuration', () => {
    const before = smallLab();
    const ids = ['d1', 'd3']; // pc1 and sw1; pc2 and the router stay out
    const clip = copyOf(before, ids);
    expect(clip.links).toHaveLength(1); // only pc1 - sw1

    const { project, ids: created } = paste(before, clip, 40);
    expect(created).toHaveLength(2);
    expect([...project.net.devices.values()].map((d) => d.name)).toEqual([
      'pc1',
      'pc2',
      'sw1',
      'r1',
      'pc3',
      'sw2',
    ]);

    const pc3 = byName(project, 'pc3');
    const sw2 = byName(project, 'sw2');
    const pc1 = byName(project, 'pc1');
    if (!pc3 || !sw2 || !pc1) throw new Error('missing device');
    // new MACs everywhere, never reused
    const macs = [...project.net.devices.values()].flatMap((d) => d.ports.map((p) => p.mac));
    expect(new Set(macs).size).toBe(macs.length);
    // the copied cable joins the copies, not the originals
    const link = pc3.ports[0]?.link;
    expect(link?.a.device === sw2 || link?.b.device === sw2).toBe(true);
    expect(pc1.ports[0]?.link?.a.device === sw2 || pc1.ports[0]?.link?.b.device === sw2).toBe(
      false,
    );
    // configuration travels with the copy (and the duplicate address is kept on purpose)
    const addrs = (d: typeof pc1) => {
      const port = d.ports[0];
      return port ? d.ip?.addrsOn(port).map((a) => a.ip) : [];
    };
    expect(addrs(pc3)).toEqual(addrs(pc1));
    expect(pc3.ip?.staticRoutes).toHaveLength(1);
    expect(sw2.bridge?.vlanFiltering).toBe(true);
    // the cable from the original switch to the router was not copied
    expect(project.net.links.size).toBe(before.net.links.size + 1);
    // placed 40 px away; originals did not move
    expect(project.layout[pc3.id]).toEqual({ x: 40, y: 40 });
    expect(project.layout['d1']).toEqual({ x: 0, y: 0 });
    // the original lab object is not modified
    expect(before.net.devices.size).toBe(4);
  });

  it('can be pasted twice', () => {
    const before = smallLab();
    const clip = copyOf(before, ['d1']);
    const once = paste(before, clip, 40).project;
    const twice = paste(once, clip, 80).project;
    expect([...twice.net.devices.values()].map((d) => d.name)).toEqual([
      'pc1',
      'pc2',
      'sw1',
      'r1',
      'pc3',
      'pc4',
    ]);
  });
});
