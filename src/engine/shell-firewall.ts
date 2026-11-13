import { formatIp } from './addr.ts';
import { TIMEOUT_S, type Conn, type Tuple } from './netfilter.ts';
import { runNft } from './nft.ts';
import type { Command } from './shell.ts';

const NFT_USAGE = [
  'Usage: nft [ -a ] [ -f FILE ] COMMAND',
  '  nft list ruleset                                   show all tables, chains and rules',
  '  nft add table ip NAME                              add a table',
  '  nft add chain ip TABLE CHAIN { type filter hook forward priority 0 ; policy drop ; }',
  '  nft add rule ip TABLE CHAIN MATCHES... VERDICT     append a rule',
  '  nft insert rule ip TABLE CHAIN ...                 prepend a rule',
  '  nft -a list ruleset; nft delete rule ip TABLE CHAIN handle N',
  '  nft flush ruleset                                  remove everything',
  '  nft -f /etc/nftables.conf                          load a ruleset file',
  'Matches: iifname, oifname, ip saddr|daddr|protocol, tcp|udp sport|dport, icmp type,',
  '         ct state. Verdicts: accept, drop, reject, masquerade, snat to, dnat to, counter.',
];

/** `nft`: the nftables firewall and NAT. */
export const nft: Command = (_net, device, args, io) => {
  const nf = device.ip?.nf;
  if (!nf || !device.fs) {
    io.out('nft: command not found');
    return;
  }
  let handles = false;
  let file: string | null = null;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-a' || a === '--handle') handles = true;
    else if (a === '-f' || a === '--file') file = args[++i] ?? '';
    else words.push(a);
  }
  if (file === null && words.length === 0) {
    NFT_USAGE.forEach(io.out);
    return;
  }
  let text = words.join(' ');
  if (file !== null) {
    const content = device.fs.read(file);
    if (content === undefined) {
      io.out(`Error: Could not process rule: No such file or directory`);
      io.out(`  ${file}`);
      return;
    }
    text = content;
  }
  const error = runNft(nf, text, io.out, handles);
  if (error) {
    io.out(error);
    if (file === null) io.out(text);
  }
};

function tupleText(t: Tuple): string {
  const addrs = `src=${formatIp(t.src)} dst=${formatIp(t.dst)}`;
  if (t.proto !== 'icmp') return `${addrs} sport=${t.sport} dport=${t.dport}`;
  // Echo requests keep their id in sport, replies in dport (see tupleOf).
  const request = t.dport === 0;
  return `${addrs} type=${request ? 8 : 0} code=0 id=${request ? t.sport : t.dport}`;
}

function connLine(conn: Conn, now: number): string {
  const proto = conn.orig.proto;
  const number = { icmp: 1, tcp: 6, udp: 17 }[proto];
  const left = Math.max(0, Math.floor(TIMEOUT_S[proto] - (now - conn.last) / 1000));
  const state = proto === 'tcp' ? ` ${conn.replied ? 'ESTABLISHED' : 'SYN_SENT'}` : '';
  const unreplied = conn.replied ? '' : ' [UNREPLIED]';
  const assured = conn.replied && proto === 'tcp' ? ' [ASSURED]' : '';
  return `${proto.padEnd(8)} ${number} ${left}${state} ${tupleText(conn.orig)}${unreplied} ${tupleText(conn.reply)}${assured} mark=0 use=1`;
}

/** `conntrack -L` lists tracked connections; `conntrack -F` forgets them. */
export const conntrack: Command = (net, device, args, io) => {
  const nf = device.ip?.nf;
  if (!nf) {
    io.out('conntrack: command not found');
    return;
  }
  const [flag] = args;
  if (flag === '-L' || flag === '--dump') {
    const conns = nf.connections();
    conns.forEach((c) => io.out(connLine(c, net.scheduler.now)));
    io.out(`conntrack v1.4.7 (conntrack-tools): ${conns.length} flow entries have been shown.`);
    return;
  }
  if (flag === '-F' || flag === '--flush') {
    nf.flushConntrack();
    io.out('conntrack v1.4.7 (conntrack-tools): connection tracking table has been emptied.');
    return;
  }
  io.out('conntrack v1.4.7 (conntrack-tools): Usage: conntrack -L | -F');
};
