import { formatCidr, formatIp, parseCidr, parseIp } from './addr.ts';
import {
  ICMP_TYPES,
  type Action,
  type BaseChain,
  type Chain,
  type ChainType,
  type CtState,
  type Hook,
  type IcmpType,
  type L4,
  type Match,
  type Netfilter,
  type Rule,
  type Table,
} from './netfilter.ts';

/**
 * The nftables language: commands (`nft add rule ip filter forward ...`), ruleset files
 * (`nft -f`), and `nft list ruleset` output, which reads back as a file. Saved labs keep
 * the firewall as that text.
 */

const HOOKS: readonly Hook[] = ['prerouting', 'input', 'forward', 'output', 'postrouting'];
const PRIORITIES: Record<string, number> = {
  raw: -300,
  mangle: -150,
  dstnat: -100,
  filter: 0,
  security: 50,
  srcnat: 100,
};
const CT_STATES: readonly CtState[] = ['new', 'established', 'related', 'invalid', 'untracked'];
const SERVICES: Record<string, number> = {
  ssh: 22,
  smtp: 25,
  domain: 53,
  bootps: 67,
  bootpc: 68,
  http: 80,
  pop3: 110,
  https: 443,
};

/** A problem in nft input, reported like nft: the message, then the offending text. */
export class NftError extends Error {}

// ------------------------------------------------------------------ tokens

/** Splits nft text into words and the punctuation `{ } ; ,` and newlines. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  const end = () => {
    if (word) tokens.push(word);
    word = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      end();
      tokens.push('\n');
    } else if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) throw new NftError('syntax error, unterminated string');
      word += text.slice(i + 1, close);
      i = close;
    } else if (c === '\\' && text[i + 1] === ';') {
      end();
      tokens.push(';');
      i++;
    } else if ('{};,\n'.includes(c)) {
      end();
      tokens.push(c);
    } else if (/\s/.test(c)) {
      end();
    } else {
      word += c;
    }
  }
  end();
  return tokens;
}

class Reader {
  i = 0;
  constructor(readonly tokens: string[]) {}

  peek(): string | undefined {
    return this.tokens[this.i];
  }

  next(): string {
    const t = this.tokens[this.i++];
    if (t === undefined) throw new NftError('syntax error, unexpected end of file');
    return t;
  }

  /** Takes `word` if it is next. */
  eat(word: string): boolean {
    if (this.peek() !== word) return false;
    this.i++;
    return true;
  }

  expect(word: string): void {
    const t = this.next();
    if (t !== word) throw unexpected(t, word);
  }

  /** Skips statement separators. */
  skipSeparators(): void {
    while (this.peek() === '\n' || this.peek() === ';') this.i++;
  }

  atStatementEnd(): boolean {
    const t = this.peek();
    return t === undefined || t === '\n' || t === ';' || t === '}';
  }
}

function unexpected(token: string, expecting?: string): NftError {
  const shown = token === '\n' ? 'newline' : token;
  return new NftError(
    `syntax error, unexpected ${shown}${expecting ? `, expecting ${expecting}` : ''}`,
  );
}

/** One value, or a `{ a, b }` set, or an `a,b` list. */
function values(r: Reader): string[] {
  const out: string[] = [];
  if (r.eat('{')) {
    while (!r.eat('}')) {
      const t = r.next();
      if (t !== ',' && t !== '\n') out.push(t);
    }
    return out;
  }
  out.push(r.next());
  while (r.eat(',')) out.push(r.next());
  return out;
}

function port(text: string): number {
  const n = /^\d+$/.test(text) ? Number(text) : SERVICES[text];
  if (n === undefined || n < 0 || n > 65535)
    throw new NftError(`Could not resolve service: ${text}`);
  return n;
}

function address(text: string): { addr: number; port: number | null } {
  const [ip, p] = text.split(':');
  const addr = ip === undefined ? null : parseIp(ip);
  if (addr === null) throw new NftError(`Could not resolve hostname: ${text}`);
  return { addr, port: p === undefined ? null : port(p) };
}

// ------------------------------------------------------------------- rules

/** Parses the words of one rule, e.g. `iifname "eth0" tcp dport 22 counter accept`. */
export function parseRule(r: Reader, handle: number): Rule {
  const matches: Match[] = [];
  let counter: Rule['counter'] = null;
  let action: Action = { kind: 'none' };
  while (!r.atStatementEnd()) {
    const word = r.next();
    if (action.kind !== 'none') throw unexpected(word);
    const neg = () => r.eat('!=');
    switch (word) {
      case 'iifname':
      case 'oifname':
      case 'iif':
      case 'oif': {
        const n = neg();
        const kind = word.startsWith('i') ? 'iifname' : 'oifname';
        matches.push({ kind, neg: n, name: r.next() });
        break;
      }
      case 'ip': {
        const field = r.next();
        const n = neg();
        if (field === 'saddr' || field === 'daddr') {
          const text = r.next();
          const cidr = parseCidr(text);
          if (!cidr) throw new NftError(`Could not resolve hostname: ${text}`);
          matches.push({ kind: field, neg: n, cidr });
        } else if (field === 'protocol') {
          matches.push({ kind: 'l4proto', neg: n, proto: l4(r.next()), via: 'ip protocol' });
        } else throw unexpected(field, 'saddr, daddr or protocol');
        break;
      }
      case 'meta': {
        r.expect('l4proto');
        const n = neg();
        matches.push({ kind: 'l4proto', neg: n, proto: l4(r.next()), via: 'meta l4proto' });
        break;
      }
      case 'tcp':
      case 'udp': {
        const field = r.next();
        if (field !== 'sport' && field !== 'dport') throw unexpected(field, 'sport or dport');
        const n = neg();
        matches.push({ kind: 'port', proto: word, field, neg: n, ports: values(r).map(port) });
        break;
      }
      case 'icmp': {
        r.expect('type');
        const types = values(r).map((t) => {
          if (!ICMP_TYPES.includes(t as IcmpType)) throw new NftError(`Unknown ICMP type ${t}`);
          return t as IcmpType;
        });
        matches.push({ kind: 'icmp', types });
        break;
      }
      case 'ct': {
        r.expect('state');
        const n = neg();
        const states = values(r).map((s) => {
          if (!CT_STATES.includes(s as CtState)) throw new NftError(`Unknown ct state ${s}`);
          return s as CtState;
        });
        matches.push({ kind: 'ct', neg: n, states });
        break;
      }
      case 'counter':
        counter = { packets: 0, bytes: 0 };
        if (r.eat('packets')) {
          counter.packets = Number(r.next()) || 0;
          r.expect('bytes');
          counter.bytes = Number(r.next()) || 0;
        }
        break;
      case 'accept':
      case 'drop':
      case 'reject':
      case 'masquerade':
        action = { kind: word };
        break;
      case 'snat':
      case 'dnat': {
        r.eat('ip');
        r.expect('to');
        const { addr, port: p } = address(r.next());
        action = { kind: word, addr, port: p };
        break;
      }
      default:
        throw unexpected(word);
    }
  }
  return { handle, matches, counter, action };
}

function l4(text: string): L4 {
  if (text === 'icmp' || text === 'tcp' || text === 'udp') return text;
  throw new NftError(`Could not resolve protocol name ${text}`);
}

function list(items: (string | number)[]): string {
  return items.length === 1 ? String(items[0]) : `{ ${items.join(', ')} }`;
}

export function formatRule(rule: Rule): string {
  const parts = rule.matches.map((m) => {
    const op = 'neg' in m && m.neg ? '!= ' : '';
    switch (m.kind) {
      case 'iifname':
      case 'oifname':
        return `${m.kind} ${op}"${m.name}"`;
      case 'saddr':
      case 'daddr':
        return `ip ${m.kind} ${op}${m.cidr.prefix === 32 ? formatIp(m.cidr.ip) : formatCidr(m.cidr)}`;
      case 'l4proto':
        return `${m.via} ${op}${m.proto}`;
      case 'port':
        return `${m.proto} ${m.field} ${op}${list(m.ports)}`;
      case 'icmp':
        return `icmp type ${list(m.types)}`;
      case 'ct':
        return `ct state ${op}${m.states.join(',')}`;
    }
  });
  if (rule.counter)
    parts.push(`counter packets ${rule.counter.packets} bytes ${rule.counter.bytes}`);
  const a = rule.action;
  if (a.kind === 'snat' || a.kind === 'dnat') {
    parts.push(`${a.kind} to ${formatIp(a.addr)}${a.port === null ? '' : `:${a.port}`}`);
  } else if (a.kind !== 'none') parts.push(a.kind);
  return parts.join(' ');
}

// ------------------------------------------------------------------ chains

function priorityName(base: BaseChain): string {
  const names: [string, number][] =
    base.type === 'nat'
      ? [
          ['dstnat', -100],
          ['srcnat', 100],
        ]
      : [['filter', 0]];
  return names.find(([, value]) => value === base.priority)?.[0] ?? String(base.priority);
}

/** `type filter hook forward priority 0; policy drop;` (inside a chain's braces). */
function parseBase(r: Reader): BaseChain {
  let type: ChainType | null = null;
  let hook: Hook | null = null;
  let priority = 0;
  let policy: BaseChain['policy'] = 'accept';
  r.skipSeparators();
  while (r.peek() !== '}' && r.peek() !== undefined) {
    const word = r.next();
    if (word === 'type') {
      const t = r.next();
      if (t !== 'filter' && t !== 'nat') throw new NftError(`unknown chain type ${t}`);
      type = t;
      r.expect('hook');
      const h = r.next();
      if (!HOOKS.includes(h as Hook)) throw new NftError(`unknown chain hook ${h}`);
      hook = h as Hook;
      r.expect('priority');
      const p = r.next();
      const value = /^-?\d+$/.test(p) ? Number(p) : PRIORITIES[p];
      if (value === undefined) throw new NftError(`unknown priority ${p}`);
      priority = value;
    } else if (word === 'policy') {
      const p = r.next();
      if (p !== 'accept' && p !== 'drop') throw unexpected(p, 'accept or drop');
      policy = p;
    } else {
      r.i--;
      break;
    }
    r.skipSeparators();
  }
  if (!type || !hook) throw new NftError('syntax error, chain type and hook are required');
  if (type === 'nat' && hook === 'forward') {
    throw new NftError('Could not process rule: Operation not supported');
  }
  return { type, hook, priority, policy };
}

// ------------------------------------------------------------------ tables

export function formatRuleset(tables: readonly Table[], handles = false): string[] {
  const lines: string[] = [];
  for (const table of tables) {
    lines.push(`table ${table.family} ${table.name} {`);
    table.chains.forEach((chain, i) => {
      if (i > 0) lines.push('');
      lines.push(`\tchain ${chain.name} {`);
      const b = chain.base;
      if (b) {
        lines.push(
          `\t\ttype ${b.type} hook ${b.hook} priority ${priorityName(b)}; policy ${b.policy};`,
        );
      }
      for (const rule of chain.rules) {
        lines.push(`\t\t${formatRule(rule)}${handles ? ` # handle ${rule.handle}` : ''}`);
      }
      lines.push('\t}');
    });
    lines.push('}');
  }
  return lines;
}

/** `[ip|inet] NAME` */
function family(r: Reader): Table['family'] {
  const t = r.peek();
  if (t === 'ip' || t === 'inet') {
    r.i++;
    return t;
  }
  if (t === 'ip6' || t === 'arp' || t === 'bridge' || t === 'netdev') {
    throw new NftError(`family ${t} is not simulated; use ip or inet`);
  }
  return 'ip';
}

function findTable(nf: Netfilter, fam: Table['family'], name: string): Table {
  const table = nf.tables.find((t) => t.family === fam && t.name === name);
  if (!table) throw new NftError('Could not process rule: No such file or directory');
  return table;
}

function findChain(table: Table, name: string): Chain {
  const chain = table.chains.find((c) => c.name === name);
  if (!chain) throw new NftError('Could not process rule: No such file or directory');
  return chain;
}

function addTable(nf: Netfilter, fam: Table['family'], name: string): Table {
  const old = nf.tables.find((t) => t.family === fam && t.name === name);
  if (old) return old;
  const table: Table = { family: fam, name, chains: [] };
  nf.tables.push(table);
  return table;
}

function addChain(table: Table, name: string, base: BaseChain | null): Chain {
  const old = table.chains.find((c) => c.name === name);
  if (old) {
    if (base) old.base = base;
    return old;
  }
  const chain: Chain = { name, base, rules: [] };
  table.chains.push(chain);
  return chain;
}

/** `table ip NAME { chain ... }` from a ruleset file. */
function tableBlock(nf: Netfilter, r: Reader): void {
  const table = addTable(nf, family(r), r.next());
  r.expect('{');
  for (r.skipSeparators(); !r.eat('}'); r.skipSeparators()) {
    r.expect('chain');
    const chain = addChain(table, r.next(), null);
    r.expect('{');
    r.skipSeparators();
    if (r.peek() === 'type') chain.base = parseBase(r);
    for (r.skipSeparators(); !r.eat('}'); r.skipSeparators()) {
      chain.rules.push(parseRule(r, nf.nextHandle()));
    }
  }
}

/** Runs one nft command or ruleset statement. Output lines go to `out`. */
function statement(nf: Netfilter, r: Reader, out: (line: string) => void, handles: boolean) {
  const verb = r.next();
  if (verb === 'table') return tableBlock(nf, r);
  if (verb === 'list') {
    const what = r.next();
    if (what === 'ruleset') formatRuleset(nf.tables, handles).forEach(out);
    else if (what === 'tables') nf.tables.forEach((t) => out(`table ${t.family} ${t.name}`));
    else if (what === 'table') {
      const fam = family(r);
      formatRuleset([findTable(nf, fam, r.next())], handles).forEach(out);
    } else throw unexpected(what, 'ruleset, tables or table');
    return;
  }
  if (verb === 'flush') {
    const what = r.next();
    if (what === 'ruleset') {
      nf.tables = [];
      return;
    }
    const fam = family(r);
    const table = findTable(nf, fam, r.next());
    if (what === 'table') table.chains.forEach((c) => (c.rules = []));
    else if (what === 'chain') findChain(table, r.next()).rules = [];
    else throw unexpected(what, 'ruleset, table or chain');
    return;
  }
  if (verb === 'add' || verb === 'create' || verb === 'insert') {
    const what = r.next();
    const fam = family(r);
    const name = r.next();
    if (what === 'table' && verb !== 'insert') {
      if (verb === 'create' && nf.tables.some((t) => t.family === fam && t.name === name)) {
        throw new NftError('Could not process rule: File exists');
      }
      addTable(nf, fam, name);
      if (r.eat('{')) r.expect('}');
      return;
    }
    const table = findTable(nf, fam, name);
    if (what === 'chain' && verb !== 'insert') {
      const chainName = r.next();
      let base: BaseChain | null = null;
      if (r.eat('{')) {
        base = parseBase(r);
        r.expect('}');
      }
      addChain(table, chainName, base);
      return;
    }
    if (what === 'rule') {
      const chain = findChain(table, r.next());
      const rule = parseRule(r, nf.nextHandle());
      if (verb === 'insert') chain.rules.unshift(rule);
      else chain.rules.push(rule);
      return;
    }
    throw unexpected(what, 'table, chain or rule');
  }
  if (verb === 'delete') {
    const what = r.next();
    const fam = family(r);
    const table = findTable(nf, fam, r.next());
    if (what === 'table') {
      nf.tables = nf.tables.filter((t) => t !== table);
    } else if (what === 'chain') {
      const chain = findChain(table, r.next());
      table.chains = table.chains.filter((c) => c !== chain);
    } else if (what === 'rule') {
      const chain = findChain(table, r.next());
      r.expect('handle');
      const handle = Number(r.next());
      const before = chain.rules.length;
      chain.rules = chain.rules.filter((rule) => rule.handle !== handle);
      if (chain.rules.length === before) {
        throw new NftError('Could not process rule: No such file or directory');
      }
    } else throw unexpected(what, 'table, chain or rule');
    return;
  }
  throw unexpected(verb);
}

/**
 * Runs nft text: one command, or a whole file of statements. All or nothing, like
 * `nft -f`: on an error the ruleset is left as it was.
 */
export function runNft(
  nf: Netfilter,
  text: string,
  out: (line: string) => void,
  handles = false,
): string | null {
  const saved = JSON.parse(JSON.stringify(nf.tables)) as Table[];
  const lines: string[] = [];
  try {
    const r = new Reader(tokenize(text));
    for (r.skipSeparators(); r.peek() !== undefined; r.skipSeparators()) {
      statement(nf, r, (l) => lines.push(l), handles);
      if (!r.atStatementEnd()) throw unexpected(r.next());
    }
  } catch (error) {
    if (!(error instanceof NftError)) throw error;
    nf.tables = saved;
    return `Error: ${error.message}`;
  }
  lines.forEach(out);
  nf.changed();
  return null;
}
