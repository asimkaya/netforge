import { describe, expect, it } from 'vitest';
import { runNft } from '../engine/nft.ts';
import { SOLUTIONS, type Action } from '../tasks/solutions.ts';
import { TASKS, advance, clearEvidence, findTask } from '../tasks/tasks.ts';
import { Lab } from './labBuilder.ts';
import { FOOTPRINT } from './placement.ts';
import type { Project } from './project.ts';
import { startOf } from './taskStart.ts';

function overlapping(project: Project): string[] {
  const placed = [...project.net.devices.values()].map((d) => {
    const at = project.layout[d.id] ?? { x: NaN, y: NaN };
    return { name: d.name, ...at, ...FOOTPRINT[d.spec.id] };
  });
  return placed.flatMap((a, i) =>
    placed
      .slice(i + 1)
      .filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
      .map((b) => `${a.name} / ${b.name}`),
  );
}

describe('the tasks are chapters of one growing network', () => {
  it('every task has a scripted solution', () => {
    expect(Object.keys(SOLUTIONS)).toEqual(TASKS.map((t) => t.id));
  });

  it('the first task starts from an empty canvas', () => {
    const first = TASKS[0];
    expect(first && startOf(first.id).net.devices.size).toBe(0);
  });

  for (const task of TASKS) {
    it(`${task.id}: its prepared start has no step done, its solution finishes them all`, () => {
      const start = startOf(task.id);
      expect(overlapping(start)).toEqual([]);
      const lab = new Lab(start);
      expect(advance(task, { net: lab.net, commands: lab.commands }, 0)).toBe(0);
      lab.apply(SOLUTIONS[task.id] ?? []);
      expect(advance(task, { net: lab.net, commands: lab.commands }, 0)).toBe(task.steps.length);
      expect(overlapping({ net: lab.net, layout: lab.layout, tasks: start.tasks })).toEqual([]);
    });
  }

  it('on the learner’s own network, a task starts with nothing done and ends with everything done', () => {
    const lab = new Lab();
    for (const task of TASKS) {
      clearEvidence(lab.net);
      lab.commands.length = 0;
      const ctx = { net: lab.net, commands: lab.commands };
      expect(advance(task, ctx, 0), `${task.id} at its start`).toBe(0);
      lab.apply(SOLUTIONS[task.id] ?? []);
      expect(advance(task, ctx, 0), `${task.id} after its solution`).toBe(task.steps.length);
    }
  });
});

describe('what a step accepts', () => {
  /** Starts the task, plays `actions` and says how many steps are done. */
  function progress(id: string, ...actions: Action[][]): { done: number; lab: Lab } {
    const lab = new Lab(startOf(id));
    const task = findTask(id);
    if (!task) throw new Error(`no task ${id}`);
    const done: number[] = [];
    for (const a of actions) {
      lab.apply(a);
      done.push(advance(task, { net: lab.net, commands: lab.commands }, 0));
    }
    return { done: done.at(-1) ?? 0, lab };
  }
  const sh = (device: string, ...lines: string[]): Action => ({ sh: device, lines });
  const build = (id: string, from: number, to: number) => (SOLUTIONS[id] ?? []).slice(from, to);

  it('a gateway that is not the router does not count', () => {
    const { done } = progress(
      'two-networks',
      build('two-networks', 0, 5),
      [sh('pc4', 'ip addr add 192.168.2.10/24 dev eth0', 'ip route add default via 192.168.2.99')],
      ['pc1', 'pc2', 'pc3'].map((pc) => sh(pc, 'ip route add default via 192.168.1.1')),
    );
    expect(done).toBe(4);
  });

  it('a DHCP range outside the router’s network serves nobody', () => {
    expect(progress('dhcp', [sh('r1', 'dnsmasq --dhcp-range=10.9.9.100,10.9.9.200')]).done).toBe(0);
    expect(progress('dhcp', build('dhcp', 0, 1)).done).toBe(1);
  });

  it('pinging the other VLAN is not “inside” the VLAN', () => {
    const { done } = progress('vlans', build('vlans', 0, 2), [
      { sh: 'pc1', lines: ['ping -c 1 192.168.1.102'], failing: true },
    ]);
    expect(done).toBe(2);
  });

  it('one tagged VLAN is not a trunk for two', () => {
    const solution = SOLUTIONS['inter-vlan'] ?? [];
    const { done } = progress('inter-vlan', solution.slice(0, 3), [
      sh('sw1', 'bridge vlan add dev eth7 vid 10'),
    ]);
    expect(done).toBe(1);
  });

  it('the camera stream is over when its chapter is done: nothing is left scheduled', () => {
    const lab = new Lab(startOf('lobby-camera'));
    lab.apply(SOLUTIONS['lobby-camera'] ?? []);
    expect(lab.named('cam1').camera?.viewers).toBe(0);
    expect(lab.net.scheduler.pending).toBe(0);
  });

  it('a printer with a static address in another network did not get one from DHCP', () => {
    const { done } = progress('first-print', build('first-print', 0, 3), [
      sh('printer1', 'ip addr flush dev eth0', 'ip addr add 10.9.9.5/24 dev eth0'),
    ]);
    expect(done).toBe(1);
    expect(progress('first-print', build('first-print', 0, 3)).done).toBe(2);
  });

  it('a closed port or a bare connection is not a printed page', () => {
    const { done, lab } = progress('first-print', build('first-print', 0, 3), [
      sh('pc1', 'curl -s http://printer1/'),
      { sh: 'pc1', lines: ['nc -w 1 printer1 8000 < /dev/null'], failing: true },
      sh('pc1', 'nc -z printer1 9100'),
    ]);
    expect(done).toBe(3);
    expect(lab.named('printer1').printer?.pages).toBe(0);
  });

  it('a camera connection without a viewer (nc -z) is not watching the stream', () => {
    const { done } = progress('lobby-camera', build('lobby-camera', 0, 3), [
      sh('pc1', 'nc -z cam1 554'),
    ]);
    expect(done).toBe(2);
  });

  it('a printer does not stand in for the camera, and the other way round', () => {
    expect(progress('lobby-camera', [{ add: 'printer', at: [270, 900] }]).done).toBe(0);
  });

  const join = (c: string, ssid: string, password: string) =>
    sh(c, `nmcli dev wifi connect ${ssid} password ${password}`);

  it('an access point with the factory name and password is not the office Wi-Fi', () => {
    expect(progress('meeting-room-wifi', build('meeting-room-wifi', 0, 2)).done).toBe(1);
    expect(progress('meeting-room-wifi', build('meeting-room-wifi', 0, 3)).done).toBe(2);
  });

  it('clients on an access point that is not on the office LAN do not count', () => {
    const { done } = progress(
      'meeting-room-wifi',
      build('meeting-room-wifi', 0, 3),
      // A second access point cabled to nothing, still with the factory settings.
      [
        { add: 'ap', at: [210, 260] },
        { add: 'laptop', at: [10, 140] },
        { add: 'phone', at: [200, 150] },
      ],
      [join('laptop1', 'NetForge', 'netforge123'), join('phone1', 'NetForge', 'netforge123')],
    );
    expect(done).toBe(2);
  });

  it('Wi-Fi clients with a static address outside the office network have none from DHCP', () => {
    const { done } = progress('meeting-room-wifi', build('meeting-room-wifi', 0, 7), [
      sh('laptop1', 'ip addr flush dev wlan0', 'ip addr add 10.9.9.5/24 dev wlan0'),
      sh('phone1', 'ip addr flush dev wlan0', 'ip addr add 10.9.9.6/24 dev wlan0'),
    ]);
    expect(done).toBe(3);
  });

  it('a server address inside the DHCP range is not a fixed address', () => {
    const server: Action[] = [
      { add: 'server', at: [40, 700] },
      { cable: ['srv1/eth0', 'sw1/eth6'] },
    ];
    const gateway = 'ip route add default via 192.168.1.1';
    expect(
      progress('intranet', server, [sh('srv1', 'ip addr add 192.168.1.150/24 dev eth0', gateway)])
        .done,
    ).toBe(0);
    expect(
      progress('intranet', server, [sh('srv1', 'ip addr add 192.168.1.5/24 dev eth0')]).done,
    ).toBe(0);
    expect(
      progress('intranet', server, [sh('srv1', 'ip addr add 192.168.1.5/24 dev eth0', gateway)])
        .done,
    ).toBe(1);
  });

  it('the sample page is not a home page of your own', () => {
    const start = build('intranet', 0, 2);
    const web = [
      sh(
        'srv1',
        'ip addr add 192.168.1.5/24 dev eth0',
        'ip route add default via 192.168.1.1',
        'httpd',
      ),
    ];
    expect(progress('intranet', start, web).done).toBe(2);
  });

  it('a wired PC opening the page is not Wi-Fi', () => {
    const { done } = progress('intranet', build('intranet', 0, 3).slice(0, 3), [
      sh('pc1', 'curl -s http://192.168.1.5/'),
    ]);
    expect(done).toBe(3);
  });

  describe('guest Wi-Fi', () => {
    const guest = (to: number) => build('guest-wifi', 0, to);
    const hint = 'nft insert rule ip filter forward iifname "br0" ip daddr 192.168.0.0/16 drop';
    const pingOffice = (failing: boolean): Action => ({
      sh: 'phone2',
      lines: ['ping -c 1 192.168.1.5'],
      failing,
    });
    const rule = (line: string) => sh('home1', `nft insert rule ip filter forward ${line}`);

    it('a home router that is cabled to nothing has no office address', () => {
      expect(progress('guest-wifi', guest(3)).done).toBe(0);
      expect(progress('guest-wifi', guest(5)).done).toBe(1);
    });

    it('a guest network in the office subnet, or without a DHCP range for it, does not count', () => {
      const clash = [sh('home1', 'ip addr flush dev br0', 'ip addr add 192.168.2.1/24 dev br0')];
      const serve = [
        sh('home1', 'killall dnsmasq', 'dnsmasq --dhcp-range=192.168.2.100,192.168.2.199'),
      ];
      expect(progress('guest-wifi', guest(5), clash, serve).done).toBe(1);
      const own = [sh('home1', 'ip addr flush dev br0', 'ip addr add 192.168.50.1/24 dev br0')];
      expect(progress('guest-wifi', guest(5), own).done).toBe(1);
      expect(progress('guest-wifi', guest(6)).done).toBe(2);
    });

    it('a visitor that got no guest address, or joined the office Wi-Fi, is not a guest', () => {
      expect(progress('guest-wifi', guest(7)).done).toBe(2);
      const office = [
        { add: 'phone', at: [200, 260] } as Action,
        join('phone2', 'Office', 'meeting-room-1'),
      ];
      expect(progress('guest-wifi', guest(6), office).done).toBe(2);
    });

    it('a visitor without Internet is not done with the Internet step', () => {
      const cut: Action[] = [sh('home1', 'ip route del default')];
      const lost: Action = { sh: 'phone2', lines: ['ping -c 1 198.18.0.10'], failing: true };
      expect(progress('guest-wifi', guest(8), cut, [lost]).done).toBe(3);
      expect(progress('guest-wifi', guest(9)).done).toBe(4);
    });

    it('a rule without a try, or a try that got through, does not count', () => {
      expect(progress('guest-wifi', guest(10)).done).toBe(4);
      expect(progress('guest-wifi', guest(9), [pingOffice(false)]).done).toBe(4);
      expect(progress('guest-wifi', guest(10), [pingOffice(true)]).done).toBe(5);
    });

    it('a rule that also cuts the Internet, or the replies, does not count', () => {
      const blanket = [rule('iifname "br0" drop'), pingOffice(true)];
      expect(progress('guest-wifi', guest(9), blanket).done).toBe(4);
      const replies = [rule('ip daddr 192.168.0.0/16 drop'), pingOffice(true)];
      expect(progress('guest-wifi', guest(9), replies).done).toBe(4);
    });

    it('unplugging the router does not keep visitors out', () => {
      const cut: Action[] = [{ uncable: 'sw1/eth8' }];
      expect(progress('guest-wifi', guest(9), cut, [pingOffice(true)]).done).toBe(4);
    });

    it('the firewall hint is valid nft', () => {
      const step = findTask('guest-wifi')?.steps[4]?.hint ?? '';
      expect(step).toBe(hint);
      const { lab } = progress('guest-wifi', guest(9));
      const home = lab.named('home1');
      expect(home.ip && runNft(home.ip.nf, hint.replace(/^nft /, ''), () => {})).toBeNull();
    });
  });

  it('NAT on the wrong side does not count, and the firewall hint is valid nft', () => {
    const { done, lab } = progress('nat', build('nat', 0, 2), [
      sh(
        'r1',
        'dhclient eth3',
        'nft add table ip nat',
        'nft add chain ip nat postrouting { type nat hook postrouting priority srcnat ; }',
        'nft add rule ip nat postrouting oifname "eth1" masquerade',
      ),
    ]);
    expect(done).toBe(2);
    const hint = findTask('nat')?.steps[4]?.hint ?? '';
    const r1 = lab.named('r1');
    expect(r1.ip && runNft(r1.ip.nf, hint, () => {})).toBeNull();
  });
});
