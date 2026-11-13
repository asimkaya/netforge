import { describe, expect, it } from 'vitest';
import type { Device } from '../engine/device.ts';
import { Network } from '../engine/network.ts';
import { runNft } from '../engine/nft.ts';
import { run } from '../engine/shell.ts';
import { TASKS, advance, findTask, type Task, type TaskContext } from './tasks.ts';

function play(net: Network) {
  const ctx: TaskContext = { net, commands: [] };
  const sh = (device: Device, line: string) => {
    ctx.commands.push({ device: device.id, line });
    run(net, device, line, { out: () => {}, exit: () => {} });
    net.scheduler.runUntil(net.scheduler.now + 30_000);
  };
  return { ctx, sh };
}

function task(id: string): Task {
  const t = findTask(id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

describe('tasks', () => {
  it('have unique ids and at least one step', () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) expect(t.steps.length).toBeGreaterThan(0);
  });

  it('first-ping completes step by step as the user builds the network', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);

    expect(progress()).toBe(0);
    const pc1 = net.addDevice('pc');
    const pc2 = net.addDevice('pc');
    expect(progress()).toBe(1);
    net.connect(pc1, pc2);
    expect(progress()).toBe(2);
    sh(pc1, 'ip addr add 192.168.1.10/24 dev eth0');
    expect(progress()).toBe(3);
    sh(pc2, 'ip addr add 192.168.2.20/24 dev eth0');
    expect(progress()).toBe(3); // different network: not done yet
    sh(pc2, 'ip addr flush dev eth0');
    sh(pc2, 'ip addr add 192.168.1.20/24 dev eth0');
    expect(progress()).toBe(4);
    sh(pc1, 'ping -c 1 192.168.1.20');
    expect(progress()).toBe(5);
  });

  it('a ping to yourself does not count', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx, sh } = play(net);
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(pc1, pc2);
    sh(pc1, 'ip addr add 10.0.0.1/24 dev eth0');
    sh(pc2, 'ip addr add 10.0.0.2/24 dev eth0');
    sh(pc1, 'ping -c 1 10.0.0.1');
    expect(advance(t, ctx, 0)).toBe(4);
  });

  it('meet-the-switch needs three PCs, one subnet, a ping and a look at the FDB', () => {
    const t = task('meet-the-switch');
    const net = new Network();
    const { ctx, sh } = play(net);
    const sw = net.addDevice('switch');
    expect(advance(t, ctx, 0)).toBe(1);
    const pcs = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
    pcs.forEach((pc) => net.connect(pc, sw));
    expect(advance(t, ctx, 0)).toBe(2);
    pcs.forEach((pc, i) => sh(pc, `ip addr add 10.0.0.${i + 1}/24 dev eth0`));
    expect(advance(t, ctx, 0)).toBe(3);
    const [first] = pcs;
    if (!first) throw new Error('setup');
    sh(first, 'ping -c 1 10.0.0.3');
    expect(advance(t, ctx, 0)).toBe(4);
    sh(first, 'bridge fdb show'); // on a PC: does not count
    expect(advance(t, ctx, 0)).toBe(4);
    sh(sw, 'bridge fdb show');
    expect(advance(t, ctx, 0)).toBe(5);
  });

  it('keeps completed steps even if the network changes later', () => {
    const t = task('first-ping');
    const net = new Network();
    const { ctx } = play(net);
    const pc = net.addDevice('pc');
    net.addDevice('pc');
    expect(advance(t, ctx, 0)).toBe(1);
    net.removeDevice(pc);
    expect(advance(t, ctx, 1)).toBe(1);
    expect(advance(t, ctx, 99)).toBe(t.steps.length);
  });

  it('two-networks follows routing from cables to traceroute', () => {
    const t = task('two-networks');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);
    const r1 = net.addDevice('router');
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    expect(progress()).toBe(1);
    const port = (d: Device, name: string) => {
      const p = d.port(name);
      if (!p) throw new Error(`no ${name}`);
      return p;
    };
    net.connect(port(pc1, 'eth0'), port(r1, 'eth0'));
    net.connect(port(pc2, 'eth0'), port(r1, 'eth1'));
    expect(progress()).toBe(2);
    sh(r1, 'ip addr add 192.168.1.1/24 dev eth0');
    sh(r1, 'ip addr add 192.168.2.1/24 dev eth1');
    expect(progress()).toBe(3);
    sh(pc1, 'ip addr add 192.168.1.10/24 dev eth0');
    sh(pc2, 'ip addr add 192.168.2.10/24 dev eth0');
    expect(progress()).toBe(4);
    sh(pc1, 'ip route add default via 192.168.1.1');
    expect(progress()).toBe(4); // pc2 has no gateway yet
    sh(pc2, 'ip route add default via 192.168.2.1');
    expect(progress()).toBe(5);
    sh(pc1, 'ping -c 1 192.168.2.10');
    expect(progress()).toBe(6);
    sh(pc1, 'traceroute 192.168.2.10');
    expect(progress()).toBe(7);
  });

  it('two-networks does not accept a gateway that is not the router', () => {
    const t = task('two-networks');
    const net = new Network();
    const { ctx, sh } = play(net);
    const r1 = net.addDevice('router');
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    net.connect(pc1, r1);
    net.connect(pc2, r1);
    sh(r1, 'ip addr add 10.0.1.1/24 dev eth0');
    sh(r1, 'ip addr add 10.0.2.1/24 dev eth1');
    sh(pc1, 'ip addr add 10.0.1.10/24 dev eth0');
    sh(pc2, 'ip addr add 10.0.2.10/24 dev eth0');
    sh(pc1, 'ip route add default via 10.0.1.99');
    sh(pc2, 'ip route add default via 10.0.2.1');
    expect(advance(t, ctx, 0)).toBe(4);
  });

  it('dhcp walks from a server to pinging a PC by name', () => {
    const t = task('dhcp');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);
    const r1 = net.addDevice('router');
    const sw = net.addDevice('switch');
    const [pc1, pc2] = [net.addDevice('pc'), net.addDevice('pc')];
    [r1, pc1, pc2].forEach((d) => net.connect(d, sw));
    expect(progress()).toBe(1);
    sh(r1, 'ip addr add 192.168.1.1/24 dev eth0');
    expect(progress()).toBe(2);
    sh(r1, 'dnsmasq --dhcp-range=10.9.9.100,10.9.9.200');
    expect(progress()).toBe(2); // a range outside the router's network serves nobody
    sh(r1, 'killall dnsmasq');
    sh(r1, 'dnsmasq --dhcp-range=192.168.1.100,192.168.1.199');
    expect(progress()).toBe(3);
    sh(pc1, 'dhclient eth0');
    expect(progress()).toBe(3);
    sh(pc2, 'dhclient eth0');
    expect(progress()).toBe(4);
    sh(pc1, 'ping -c 1 192.168.1.101');
    expect(progress()).toBe(4); // by address, not by name
    sh(pc1, 'ping -c 1 pc2');
    expect(progress()).toBe(5);
  });
  it('vlans goes from one network to two VLANs that cannot reach each other', () => {
    const t = task('vlans');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);
    const sw = net.addDevice('switch');
    const pcs = [net.addDevice('pc'), net.addDevice('pc'), net.addDevice('pc')];
    pcs.forEach((pc, i) => {
      net.connect(pc, sw);
      sh(pc, `ip addr add 192.168.1.${i + 1}0/24 dev eth0`);
    });
    expect(progress()).toBe(1);
    sh(sw, 'ip link set br0 type bridge vlan_filtering 1');
    expect(progress()).toBe(2);
    for (const [dev, vid] of [
      ['eth0', 10],
      ['eth1', 10],
      ['eth2', 20],
    ] as const) {
      sh(sw, `bridge vlan add dev ${dev} vid ${vid} pvid untagged`);
      sh(sw, `bridge vlan del dev ${dev} vid 1`);
    }
    expect(progress()).toBe(3);
    const [pc1 = sw, , pc3 = sw] = pcs;
    sh(pc1, 'ping -c 1 192.168.1.30');
    expect(progress()).toBe(3); // the other VLAN does not count as "inside"
    sh(pc1, 'ping -c 1 192.168.1.20');
    expect(progress()).toBe(5);
    expect(pc3.ip?.echoRepliesFrom.size).toBe(0);
  });

  it('nat needs a public address, NAT, a ping out and a stateful firewall', () => {
    const t = task('nat');
    const net = new Network();
    const { ctx, sh } = play(net);
    const progress = () => advance(t, ctx, 0);
    const inet = net.addDevice('internet');
    const r1 = net.addDevice('router');
    const pc = net.addDevice('pc');
    const port = (d: typeof pc, name: string) => d.port(name) ?? (undefined as never);
    net.connect(port(r1, 'eth1'), port(inet, 'eth0'));
    net.connect(port(pc, 'eth0'), port(r1, 'eth0'));
    expect(progress()).toBe(1);
    sh(r1, 'dhclient eth1');
    expect(progress()).toBe(2);
    sh(r1, 'ip addr add 192.168.1.1/24 dev eth0');
    sh(pc, 'ip addr add 192.168.1.10/24 dev eth0');
    sh(pc, 'ip route add default via 192.168.1.1');
    expect(progress()).toBe(3);
    sh(pc, 'ping -c 1 198.18.0.10');
    sh(r1, 'nft add table ip nat');
    sh(r1, 'nft add chain ip nat postrouting { type nat hook postrouting priority 100 ; }');
    sh(r1, 'nft add rule ip nat postrouting oifname "eth0" masquerade');
    expect(progress()).toBe(3); // masquerading on the wrong side
    sh(r1, 'nft flush ruleset');
    sh(r1, 'nft add table ip nat');
    sh(r1, 'nft add chain ip nat postrouting { type nat hook postrouting priority 100 ; }');
    sh(r1, 'nft add rule ip nat postrouting oifname "eth1" masquerade');
    expect(progress()).toBe(4);
    sh(pc, 'ping -c 1 198.18.0.10');
    expect(progress()).toBe(5);
    const step = t.steps[5];
    sh(r1, 'conntrack -F');
    const rules = step?.hint ?? '';
    expect(r1.ip && runNft(r1.ip.nf, rules, () => {})).toBeNull();
    expect(progress()).toBe(5); // no connection has gone through the firewall yet
    sh(pc, 'ping -c 1 198.18.0.10');
    expect(progress()).toBe(6);
  });
});
