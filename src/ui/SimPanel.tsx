import { useEffect, useState } from 'react';
import { formatIp } from '../engine/addr.ts';
import { formatCidr6, formatIp6 } from '../engine/addr6.ts';
import type { Network, TraceEntry } from '../engine/network.ts';
import {
  describeFrame,
  protocolOf,
  TCP_SERVICES,
  type EthernetFrame,
  type IcmpPacket,
} from '../engine/packet.ts';
import { stepToNextFrame } from './clock.ts';
import { useLab } from './lab.ts';
import { PROTOCOL_COLORS } from './theme.ts';

const PLAY_INTERVAL_MS = 700;

const button =
  'rounded border border-(--nf-border) px-3 py-1 text-xs hover:border-(--nf-accent) disabled:opacity-40 disabled:hover:border-(--nf-border)';

type Field = [string, string];

/** Header fields per layer, like a packet analyzer. */
function layers(frame: EthernetFrame): { name: string; fields: Field[] }[] {
  const p = frame.payload;
  const ethernet = {
    name: 'Ethernet II',
    fields: [
      ['Destination', frame.dst],
      ['Source', frame.src],
      ...(frame.vlan === undefined ? [] : [['802.1Q VLAN', String(frame.vlan)] satisfies Field]),
      [
        'Type',
        {
          arp: 'ARP (0x0806)',
          ipv4: 'IPv4 (0x0800)',
          ipv6: 'IPv6 (0x86dd)',
          bpdu: 'LLC, Spanning Tree',
        }[p.kind],
      ],
    ] satisfies Field[],
  };
  if (p.kind === 'ipv6') {
    const m = p.payload;
    const fields: Field[] = [['Type', m.type.replaceAll('-', ' ')]];
    if (m.type === 'echo-request' || m.type === 'echo-reply') {
      fields.push(['Identifier', String(m.id)], ['Sequence', String(m.seq)]);
    } else if (m.type === 'neighbor-solicitation' || m.type === 'neighbor-advertisement') {
      fields.push(['Target address', formatIp6(m.target)]);
    } else if (m.type === 'router-advertisement') {
      fields.push(['Router lifetime', `${m.lifetime} s`]);
      for (const prefix of m.prefixes) fields.push(['Prefix', formatCidr6(prefix)]);
    } else if (m.type === 'time-exceeded' || m.type === 'dest-unreachable') {
      fields.push(['About packet to', formatIp6(m.original.dst)]);
    }
    return [
      ethernet,
      {
        name: 'Internet Protocol version 6',
        fields: [
          ['Source', formatIp6(p.src)],
          ['Destination', formatIp6(p.dst)],
          ['Hop limit', String(p.hopLimit)],
          ['Next header', 'ICMPv6 (58)'],
        ],
      },
      { name: 'Internet Control Message Protocol v6', fields },
    ];
  }
  if (p.kind === 'bpdu') {
    return [
      ethernet,
      {
        name: 'Spanning Tree Protocol',
        fields: [
          ['Root bridge', p.rootId],
          ['Root path cost', String(p.rootCost)],
          ['Bridge', p.bridgeId],
          ['Port', `0x${p.portId.toString(16)}`],
          ['Topology change', p.tc ? 'yes' : 'no'],
        ],
      },
    ];
  }
  if (p.kind === 'arp') {
    return [
      ethernet,
      {
        name: 'Address Resolution Protocol',
        fields: [
          ['Opcode', p.op === 'request' ? 'request (1)' : 'reply (2)'],
          ['Sender MAC', p.senderMac],
          ['Sender IP', formatIp(p.senderIp)],
          ['Target MAC', p.targetMac],
          ['Target IP', formatIp(p.targetIp)],
        ],
      },
    ];
  }
  const inner = p.payload;
  const ip = {
    name: 'Internet Protocol version 4',
    fields: [
      ['Source', formatIp(p.src)],
      ['Destination', formatIp(p.dst)],
      ['Time to live', String(p.ttl)],
      [
        'Protocol',
        { icmp: 'ICMP (1)', tcp: 'TCP (6)', udp: 'UDP (17)', ospf: 'OSPF (89)' }[inner.kind],
      ],
    ] satisfies Field[],
  };
  if (inner.kind === 'icmp') {
    const fields = icmpFields(inner);
    return [ethernet, ip, { name: 'Internet Control Message Protocol', fields }];
  }
  if (inner.kind === 'ospf') {
    const fields: Field[] = [
      ['Message type', inner.type === 'hello' ? 'Hello' : 'Link State Update'],
      ['Router ID', formatIp(inner.routerId)],
      ['Area', String(inner.area)],
    ];
    if (inner.type === 'hello') {
      fields.push(['Neighbors seen', inner.neighbors.map(formatIp).join(', ') || 'none']);
    } else {
      for (const lsa of inner.lsas) {
        const links = lsa.links.map((l) =>
          l.kind === 'router'
            ? `router ${formatIp(l.id)} cost ${l.cost}`
            : `${formatIp(l.net)}/${l.prefix} cost ${l.cost}`,
        );
        fields.push([`LSA ${formatIp(lsa.routerId)} #${lsa.seq}`, links.join('; ')]);
      }
    }
    return [ethernet, ip, { name: 'Open Shortest Path First', fields }];
  }
  if (inner.kind === 'tcp') {
    const tcp = {
      name: 'Transmission Control Protocol',
      fields: [
        ['Source port', String(inner.srcPort)],
        ['Destination port', String(inner.dstPort)],
        ['Flags', inner.flags.join(', ')],
        ['Sequence number', String(inner.seq)],
        ['Acknowledgment', inner.flags.includes('ACK') ? String(inner.ack) : '—'],
        ['Data length', String(inner.data?.length ?? 0)],
      ] satisfies Field[],
    };
    if (!inner.data) return [ethernet, ip, tcp];
    const service = TCP_SERVICES[inner.dstPort] ?? TCP_SERVICES[inner.srcPort];
    const lines = inner.data.split(/\r?\n/).slice(0, 12);
    return [
      ethernet,
      ip,
      tcp,
      {
        name: service ? `${service.toUpperCase()} data` : 'Data',
        fields: lines.map((line, i): Field => [i === 0 ? 'Text' : '', line]),
      },
    ];
  }
  const udp = {
    name: 'User Datagram Protocol',
    fields: [
      ['Source port', String(inner.srcPort)],
      ['Destination port', String(inner.dstPort)],
    ] satisfies Field[],
  };
  const d = inner.data;
  if (d.app === 'wireguard') {
    const kind = {
      initiation: 'Handshake initiation',
      response: 'Handshake response',
      data: 'Transport data',
    }[d.type];
    const fields: Field[] = [
      ['Message type', kind],
      ['Sender key', d.sender],
      ['Receiver key', d.receiver],
    ];
    if (d.type === 'data')
      fields.push(['Encrypted payload', 'an IP packet, unreadable without the keys']);
    return [ethernet, ip, udp, { name: 'WireGuard', fields }];
  }
  if (d.app === 'dhcp') {
    const fields: Field[] = [
      ['Message type', `DHCP ${d.op}`],
      ['Transaction ID', `0x${d.xid.toString(16)}`],
      ['Client MAC', d.chaddr],
      ['Your IP', formatIp(d.yiaddr)],
      ['Server', formatIp(d.serverId)],
    ];
    if (d.requested !== undefined) fields.push(['Requested IP', formatIp(d.requested)]);
    if (d.hostname) fields.push(['Hostname', d.hostname]);
    if (d.lease) {
      fields.push(['Subnet prefix', `/${d.lease.prefix}`]);
      if (d.lease.router !== undefined) fields.push(['Router', formatIp(d.lease.router)]);
      if (d.lease.dns !== undefined) fields.push(['DNS server', formatIp(d.lease.dns)]);
      fields.push(['Lease time', `${d.lease.seconds} s`]);
    }
    return [ethernet, ip, udp, { name: 'Dynamic Host Configuration Protocol', fields }];
  }
  if (d.app === 'dns') {
    const fields: Field[] = [
      ['Transaction ID', `0x${d.id.toString(16)}`],
      ['Flags', d.qr === 'query' ? 'Standard query' : 'Standard query response'],
      ['Question', `${d.name} A`],
    ];
    if (d.qr === 'response') {
      fields.push(['Answer', d.answer ? formatIp(d.answer) : 'No such name (NXDOMAIN)']);
    }
    return [ethernet, ip, udp, { name: 'Domain Name System', fields }];
  }
  return [ethernet, ip, udp];
}

function icmpFields(icmp: IcmpPacket): Field[] {
  switch (icmp.type) {
    case 'echo-request':
    case 'echo-reply':
      return [
        ['Type', icmp.type === 'echo-request' ? '8 (Echo request)' : '0 (Echo reply)'],
        ['Identifier', String(icmp.id)],
        ['Sequence', String(icmp.seq)],
      ];
    case 'time-exceeded':
      return [
        ['Type', '11 (Time exceeded)'],
        ['Code', '0 (TTL expired in transit)'],
        ['About packet', `${formatIp(icmp.original.src)} > ${formatIp(icmp.original.dst)}`],
      ];
    case 'dest-unreachable':
      return [
        ['Type', '3 (Destination unreachable)'],
        ['Code', UNREACHABLE_CODE[icmp.code]],
        ['About packet', `${formatIp(icmp.original.src)} > ${formatIp(icmp.original.dst)}`],
      ];
  }
}

const UNREACHABLE_CODE = {
  net: '0 (Network unreachable)',
  host: '1 (Host unreachable)',
  port: '3 (Port unreachable)',
} as const;

function deviceName(net: Network, id: string): string {
  return net.devices.get(id)?.name ?? '(removed)';
}

/** A frame's headers, layer by layer. Also used by the Packet Capture app. */
export function Details({ entry }: { entry: TraceEntry }) {
  return (
    <div className="space-y-2 text-xs">
      {layers(entry.frame).map((layer) => (
        <section key={layer.name}>
          <h4 className="font-semibold">{layer.name}</h4>
          <dl className="grid grid-cols-[8rem_1fr] font-mono text-(--nf-muted)">
            {layer.fields.map(([k, v], i) => (
              <div key={i} className="contents">
                <dt>{k}</dt>
                <dd className="text-(--nf-text)">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Event list and controls for stepping through the simulation frame by frame. */
export function SimPanel() {
  const { net } = useLab();
  const [playing, setPlaying] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const pending = net.scheduler.pending > 0;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      if (!stepToNextFrame(net)) setPlaying(false);
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, net]);

  const entries = net.trace;
  const shown = entries.find((e) => e.seq === chosen) ?? entries.at(-1);

  return (
    <section
      className="flex h-56 shrink-0 border-t border-(--nf-border) bg-(--nf-surface)"
      aria-label="Simulation events"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-(--nf-border) px-3 py-1.5">
          <button
            type="button"
            className={button}
            onClick={() => setPlaying(!playing)}
            disabled={!pending && !playing}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className={button}
            onClick={() => stepToNextFrame(net)}
            disabled={!pending || playing}
          >
            Step
          </button>
          <button type="button" className={button} onClick={() => net.clearTrace()}>
            Clear list
          </button>
          <span className="ml-2 text-xs text-(--nf-muted)">
            Time {net.scheduler.now.toFixed(2)} ms ·{' '}
            {pending ? 'events waiting' : 'nothing to do: run a command, e.g. ping'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-(--nf-surface) text-(--nf-muted)">
              <tr>
                <th className="px-3 py-1 font-medium">Time (ms)</th>
                <th className="px-3 py-1 font-medium">From → To</th>
                <th className="px-3 py-1 font-medium">Info</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {entries.map((e) => (
                <tr
                  key={e.seq}
                  onClick={() => setChosen(e.seq)}
                  className={`cursor-pointer hover:bg-(--nf-border) ${e === shown ? 'bg-(--nf-border)' : ''}`}
                  aria-selected={e === shown}
                >
                  <td className="px-3 py-0.5">{e.time.toFixed(2)}</td>
                  <td className="px-3 py-0.5 whitespace-nowrap">
                    {deviceName(net, e.from.device)} → {deviceName(net, e.to.device)}
                  </td>
                  <td className="px-3 py-0.5">
                    <span
                      className="mr-2 inline-block h-2 w-2 rounded-full"
                      style={{ background: PROTOCOL_COLORS[protocolOf(e.frame)] }}
                      aria-hidden
                    />
                    {describeFrame(e.frame)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-(--nf-border) p-3">
        {shown ? (
          <Details entry={shown} />
        ) : (
          <p className="text-xs text-(--nf-muted)">
            Frames appear here one hop at a time. Open a terminal, run a ping, then press Step.
          </p>
        )}
      </aside>
    </section>
  );
}
