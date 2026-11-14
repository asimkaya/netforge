import { HOME, normalizePath } from './fs.ts';
import type { Command, ShellIO } from './shell.ts';

export interface ParsedLine {
  words: string[];
  /** `> FILE` or `>> FILE`: where output goes instead of the terminal. */
  redirect?: { path: string; append: boolean };
}

/**
 * Splits a command line like a small POSIX shell: whitespace separates words, '...' and "..."
 * group them (\" and \\ escape inside double quotes), and > / >> redirect output to a file.
 * Returns an error message in bash wording for an unfinished quote or a missing file name.
 */
/**
 * Splits a line on `|` outside quotes: the commands of a pipeline. Returns an error in bash
 * wording when a side of a pipe is empty.
 */
export function splitPipeline(line: string): string[] | string {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? '';
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      const end = close < 0 ? line.length - 1 : close;
      current += line.slice(i, end + 1);
      i = end;
    } else if (c === '|') {
      parts.push(current);
      current = '';
    } else current += c;
  }
  parts.push(current);
  if (parts.length > 1 && parts.some((p) => p.trim() === '')) {
    return "bash: syntax error near unexpected token `|'";
  }
  return parts;
}

/**
 * Splits a line into the commands of a list (`a ; b`, `a && b`), outside quotes. A `;`
 * inside braces stays, so `nft add chain ... { type nat hook postrouting priority 100 ; }`
 * needs no escaping here (bash wants `\;`).
 */
export function splitList(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? '';
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      const end = close < 0 ? line.length - 1 : close;
      current += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '\\') {
      current += c + (line[++i] ?? '');
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    const and = c === '&' && line[i + 1] === '&';
    if (depth <= 0 && (c === ';' || and)) {
      parts.push(current);
      current = '';
      if (and) i++;
    } else current += c;
  }
  parts.push(current);
  return parts.filter((p) => p.trim() !== '');
}

export function parseLine(line: string): ParsedLine | string {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let redirect: ParsedLine['redirect'];
  let pending: { append: boolean } | null = null;
  const end = () => {
    if (!inWord) return;
    if (pending) {
      redirect = { path: word, append: pending.append };
      pending = null;
    } else words.push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? '';
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      if (close < 0) return `bash: unexpected EOF while looking for matching \`${c}'`;
      let text = line.slice(i + 1, close);
      if (c === '"') text = text.replace(/\\(["\\$`])/g, '$1');
      word += text;
      inWord = true;
      i = close;
    } else if (c === '>') {
      end();
      const append = line[i + 1] === '>';
      if (append) i++;
      pending = { append };
    } else if (/\s/.test(c)) {
      end();
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  if (pending) return "bash: syntax error near unexpected token `newline'";
  return redirect ? { words, redirect } : { words };
}

function needFs(device: Parameters<Command>[1], name: string, io: ShellIO) {
  if (!device.fs) io.out(`${name}: command not found`);
  return device.fs;
}

export const echo: Command = (_net, _device, args, io) => {
  // -n (no trailing newline) is accepted; the terminal shows whole lines either way.
  let rest = args;
  let escapes = false;
  while (rest[0] === '-n' || rest[0] === '-e') {
    if (rest[0] === '-e') escapes = true;
    rest = rest.slice(1);
  }
  let text = rest.join(' ');
  if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  text.split('\n').forEach((line) => io.out(line));
};

export const pwd: Command = (_net, _device, _args, io) => {
  io.out(HOME);
};

export const ls: Command = (_net, device, args, io) => {
  const fs = needFs(device, 'ls', io);
  if (!fs) return;
  const long = args.includes('-l') || args.includes('-la') || args.includes('-al');
  const targets = args.filter((a) => !a.startsWith('-'));
  for (const target of targets.length ? targets : ['.']) {
    const path = normalizePath(target);
    if (path === null || (!fs.isDir(path) && fs.read(path) === undefined)) {
      io.out(`ls: cannot access '${target}': No such file or directory`);
      continue;
    }
    if (targets.length > 1) io.out(`${target}:`);
    const names = fs.isDir(path) ? fs.list(path) : [target];
    if (!long) {
      if (names.length) io.out(names.map((n) => n.replace(/\/$/, '')).join('  '));
      continue;
    }
    for (const name of names) {
      const full = fs.isDir(path) ? normalizePath(name.replace(/\/$/, ''), path) : path;
      const dir = name.endsWith('/');
      const size = dir ? 4096 : (fs.read(full ?? '') ?? '').length;
      io.out(
        `${dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 root root ${String(size).padStart(6)} ${name.replace(/\/$/, '')}`,
      );
    }
  }
};

export const cat: Command = (_net, device, args, io) => {
  // With no files, cat copies its input (the previous command of a pipeline).
  if (args.length === 0) {
    io.stdin?.forEach((l) => io.out(l));
    return;
  }
  const fs = needFs(device, 'cat', io);
  if (!fs) return;
  for (const name of args) {
    const path = normalizePath(name);
    const text = path === null ? undefined : fs.read(path);
    if (path !== null && fs.isDir(path)) io.out(`cat: ${name}: Is a directory`);
    else if (text === undefined) io.out(`cat: ${name}: No such file or directory`);
    else
      text
        .replace(/\n$/, '')
        .split('\n')
        .forEach((l) => io.out(l));
  }
};

export const touch: Command = (_net, device, args, io) => {
  const fs = needFs(device, 'touch', io);
  if (!fs) return;
  for (const name of args) {
    const path = normalizePath(name);
    if (path === null) io.out(`touch: cannot touch '${name}': No such file or directory`);
    else if (fs.read(path) === undefined && !fs.isDir(path)) {
      const error = fs.write(path, '');
      if (error) io.out(`touch: ${error}`);
    }
  }
};

export const rm: Command = (_net, device, args, io) => {
  const fs = needFs(device, 'rm', io);
  if (!fs) return;
  const force = args.includes('-f');
  for (const name of args.filter((a) => !a.startsWith('-'))) {
    const path = normalizePath(name);
    if (path !== null && fs.isDir(path)) io.out(`rm: cannot remove '${name}': Is a directory`);
    else if ((path === null || !fs.remove(path)) && !force) {
      io.out(`rm: cannot remove '${name}': No such file or directory`);
    }
  }
};

export const mkdir: Command = (_net, device, args, io) => {
  const fs = needFs(device, 'mkdir', io);
  if (!fs) return;
  for (const name of args.filter((a) => !a.startsWith('-'))) {
    const path = normalizePath(name);
    if (path === null)
      io.out(`mkdir: cannot create directory '${name}': No such file or directory`);
    else if (fs.isDir(path) && !args.includes('-p'))
      io.out(`mkdir: cannot create directory '${name}': File exists`);
    else fs.mkdir(path);
  }
};

/** `grep [-i] [-v] [-c] [-E] PATTERN [FILE...]`: lines that match, from files or the pipe. */
export const grep: Command = (_net, device, args, io) => {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (/^-[ivcE]+$/.test(a)) for (const f of a.slice(1)) flags.add(f);
    else rest.push(a);
  }
  const [pattern, ...files] = rest;
  if (pattern === undefined) {
    io.out('Usage: grep [OPTION]... PATTERNS [FILE]...');
    return;
  }
  let re: RegExp;
  try {
    // shortcut: basic and extended regular expressions both use JavaScript's syntax.
    re = new RegExp(pattern, flags.has('i') ? 'i' : '');
  } catch {
    io.out('grep: Unmatched ( or \\(');
    return;
  }
  const sources: { name: string; lines: readonly string[] }[] = [];
  if (files.length === 0) sources.push({ name: '(standard input)', lines: io.stdin ?? [] });
  for (const name of files) {
    const path = normalizePath(name);
    const text = path === null ? undefined : device.fs?.read(path);
    if (text === undefined) io.out(`grep: ${name}: No such file or directory`);
    else sources.push({ name, lines: text.replace(/\n$/, '').split('\n') });
  }
  for (const source of sources) {
    const hits = source.lines.filter((l) => re.test(l) !== flags.has('v'));
    const prefix = sources.length > 1 ? `${source.name}:` : '';
    if (flags.has('c')) io.out(`${prefix}${hits.length}`);
    else hits.forEach((l) => io.out(`${prefix}${l}`));
  }
};

/** `tee [-a] FILE...`: copies the pipe to files and to the output. */
export const tee: Command = (_net, device, args, io) => {
  const append = args.includes('-a');
  const lines = io.stdin ?? [];
  const text = lines.map((l) => `${l}\n`).join('');
  for (const name of args.filter((a) => a !== '-a')) {
    const path = normalizePath(name);
    const error =
      path === null || !device.fs
        ? `${name}: No such file or directory`
        : device.fs.write(path, text, append);
    if (error) io.out(`tee: ${error}`);
  }
  lines.forEach((l) => io.out(l));
};
