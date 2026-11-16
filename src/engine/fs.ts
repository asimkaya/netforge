/** Largest file and largest total size per device, so labs stay small enough to save. */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
/** The shell's working directory: relative paths start here. */
export const HOME = '/root';

/** Turns `path` into a clean absolute path, or null if it climbs above `/` or is odd. */
export function normalizePath(path: string, cwd = HOME): string | null {
  if (!/^[\w./-]{1,240}$/.test(path)) return null;
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * A device's files: a flat map of absolute paths to text. Directories exist implicitly as
 * prefixes of file paths (plus any created with mkdir).
 */
export class FileSystem {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/', HOME]);

  constructor(
    initial: Record<string, string> = {},
    private readonly onChange: () => void = () => {},
  ) {
    for (const [path, text] of Object.entries(initial)) this.write(path, text);
  }

  #size(): number {
    let total = 0;
    for (const text of this.files.values()) total += text.length;
    return total;
  }

  isDir(path: string): boolean {
    if (this.dirs.has(path)) return true;
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.files.keys()].some((f) => f.startsWith(prefix));
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  /** Writes a file. Returns an error message (in shell wording) or null. */
  write(path: string, text: string, append = false): string | null {
    if (this.isDir(path)) return `${path}: Is a directory`;
    const next = append ? (this.files.get(path) ?? '') + text : text;
    if (next.length > MAX_FILE_BYTES) return `${path}: File too large`;
    const growth = next.length - (this.files.get(path)?.length ?? 0);
    if (this.#size() + growth > MAX_TOTAL_BYTES) return `${path}: No space left on device`;
    this.files.set(path, next);
    for (
      let dir = path.slice(0, path.lastIndexOf('/'));
      dir;
      dir = dir.slice(0, dir.lastIndexOf('/'))
    ) {
      this.dirs.add(dir);
    }
    this.onChange();
    return null;
  }

  remove(path: string): boolean {
    const removed = this.files.delete(path);
    if (removed) this.onChange();
    return removed;
  }

  /** Adds a directory and its parents (`mkdir -p`). */
  mkdir(path: string): void {
    for (let dir = path; dir; dir = dir.slice(0, dir.lastIndexOf('/'))) this.dirs.add(dir);
    this.onChange();
  }

  /** Names directly inside `dir`, directories with a trailing slash, sorted. */
  list(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === dir) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) names.add(`${rest.slice(0, slash)}/`);
      else if (rest) names.add(this.files.has(path) ? rest : `${rest}/`);
    }
    return [...names].sort();
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b)));
  }
}
