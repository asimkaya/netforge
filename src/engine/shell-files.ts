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
