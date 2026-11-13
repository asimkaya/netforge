import { macFromIndex } from '../engine/addr.ts';
import { Network, type NetworkSnapshot } from '../engine/network.ts';
import { isSpecId, type SpecId } from '../engine/specs.ts';
import type { Point } from './lab.ts';

export const PROJECT_FORMAT = 'netforge-lab';
/** Bump on any incompatible change and add a migration for the previous version. */
export const PROJECT_VERSION = 5;

export interface TaskProgress {
  /** Id of the task being played, if any. */
  active: string | null;
  /** Number of completed steps per task id. */
  steps: Record<string, number>;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  network: NetworkSnapshot;
  layout: Record<string, Point>;
  tasks: TaskProgress;
}

export interface Project {
  net: Network;
  layout: Record<string, Point>;
  tasks: TaskProgress;
}

export function emptyProgress(): TaskProgress {
  return { active: null, steps: {} };
}

export function serializeProject({ net, layout, tasks }: Project): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    network: net.toJSON(),
    layout,
    tasks,
  };
  return JSON.stringify(file, null, 2);
}

/** A problem with a lab file, worded for the user. */
export class ProjectError extends Error {}

type Json = Record<string, unknown>;

function fail(message: string): never {
  throw new ProjectError(message);
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown, what: string): Json {
  return isObject(value) ? value : fail(`${what} is missing or not an object.`);
}

function arr(value: unknown, what: string): unknown[] {
  return Array.isArray(value) ? value : fail(`${what} is missing or not a list.`);
}

function str(value: unknown, what: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) fail(`${what} is invalid.`);
  return value;
}

function count(value: unknown, what: string): number {
  return Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : fail(`${what} is invalid.`);
}

const ID = /^[a-z][0-9]{1,9}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const PORT = /^eth[0-9]{1,2}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const CIDR = /^[0-9./]{1,18}$/;

function endpoint(value: unknown, what: string) {
  const e = obj(value, what);
  return { device: str(e.device, `${what} device`, ID), port: str(e.port, `${what} port`, PORT) };
}

const IP = /^[0-9.]{7,15}$/;

function readIpSettings(value: unknown, what: string) {
  const ip = obj(value, `${what} IP settings`);
  if (typeof ip.forwarding !== 'boolean') fail(`${what} forwarding setting is invalid.`);
  return {
    forwarding: ip.forwarding,
    dns: arr(ip.dns, `${what} DNS servers`).map((a) => str(a, `${what} DNS server`, IP)),
    routes: arr(ip.routes, `${what} routes`).map((value) => {
      const r = obj(value, `${what} route`);
      return {
        dst: str(r.dst, `${what} route destination`, CIDR),
        ...(r.via === undefined ? {} : { via: str(r.via, `${what} route gateway`, IP) }),
        dev: str(r.dev, `${what} route device`, PORT),
      };
    }),
  };
}

/** Service command lines; the engine's own option parser checks their content. */
function readServices(value: unknown, what: string) {
  const services = obj(value, `${what} services`);
  const list = (key: 'dnsmasq' | 'httpd' | 'postfix' | 'dovecot' | 'hostapd', pattern: RegExp) =>
    services[key] === undefined
      ? {}
      : {
          [key]: arr(services[key], `${what} ${key} options`).map((a) =>
            str(a, `${what} ${key} option`, pattern),
          ),
        };
  return {
    ...list('dnsmasq', /^--?[a-z-]+(=[!-~]{0,200})?$/),
    ...list('httpd', /^[\w./-]{1,240}$/),
    ...list('postfix', /^$/),
    ...list('dovecot', /^$/),
    ...list('hostapd', /^[\w./-]{1,240}$/),
  };
}

/** Device files: sizes are checked again when the engine writes them. */
function readFiles(value: unknown, what: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(obj(value, `${what} files`))) {
    files[str(path, `${what} file name`, /^\/[\w./-]{1,240}$/)] = str(text, `${what} file ${path}`);
  }
  return files;
}

/** Checks the shape of untrusted JSON before the engine sees it. */
function readSnapshot(value: unknown): NetworkSnapshot {
  const n = obj(value, 'network');
  const devices = arr(n.devices, 'network.devices').map((value, i) => {
    const d = obj(value, `device #${i + 1}`);
    const spec: SpecId = isSpecId(d.spec) ? d.spec : fail(`device #${i + 1} type is invalid.`);
    return {
      id: str(d.id, `device #${i + 1} id`, ID),
      spec,
      name: str(d.name, `device #${i + 1} name`, NAME),
      ports: arr(d.ports, `device #${i + 1} ports`).map((value, j) => {
        const p = obj(value, `port #${j + 1} of device #${i + 1}`);
        if (typeof p.up !== 'boolean') fail(`port #${j + 1} of device #${i + 1} state is invalid.`);
        const port = {
          name: str(p.name, 'port name', PORT),
          mac: str(p.mac, 'port MAC address', MAC),
          up: p.up,
        };
        return p.addrs === undefined
          ? port
          : { ...port, addrs: arr(p.addrs, 'port addresses').map((a) => str(a, 'address', CIDR)) };
      }),
      ...(d.ip === undefined ? {} : { ip: readIpSettings(d.ip, `device #${i + 1}`) }),
      ...(d.services === undefined
        ? {}
        : { services: readServices(d.services, `device #${i + 1}`) }),
      ...(d.files === undefined ? {} : { files: readFiles(d.files, `device #${i + 1}`) }),
    };
  });
  const links = arr(n.links, 'network.links').map((value, i) => {
    const l = obj(value, `cable #${i + 1}`);
    return {
      id: str(l.id, `cable #${i + 1} id`, ID),
      a: endpoint(l.a, `cable #${i + 1} end A`),
      b: endpoint(l.b, `cable #${i + 1} end B`),
    };
  });
  const c = obj(n.counters, 'network.counters');
  const counters = {
    device: count(c.device, 'device counter'),
    link: count(c.link, 'cable counter'),
    mac: count(c.mac, 'MAC counter'),
    names: Object.fromEntries(
      Object.entries(obj(c.names, 'name counters')).map(([prefix, n]) => [
        str(prefix, 'name counter', /^[a-z]{1,10}$/),
        count(n, `${prefix} counter`),
      ]),
    ),
  };
  return { devices, links, counters };
}

function readLayout(value: unknown): Record<string, Point> {
  const layout: Record<string, Point> = {};
  for (const [id, raw] of Object.entries(obj(value, 'layout'))) {
    const p = obj(raw, `position of ${id}`);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(`position of ${id} is invalid.`);
    layout[str(id, 'layout id', ID)] = { x: p.x as number, y: p.y as number };
  }
  return layout;
}

function readTasks(value: unknown): TaskProgress {
  if (value === undefined) return emptyProgress();
  const t = obj(value, 'tasks');
  const active = t.active === null ? null : str(t.active, 'active task', /^[a-z0-9-]{1,40}$/);
  const steps: Record<string, number> = {};
  for (const [id, n] of Object.entries(obj(t.steps, 'task steps'))) {
    steps[str(id, 'task id', /^[a-z0-9-]{1,40}$/)] = count(n, `progress of ${id}`);
  }
  return { active, steps };
}

/**
 * Upgrades raw file data from version N to N + 1. Runs before validation, so it only
 * reshapes what it recognizes and leaves anything odd for the validator to reject.
 */
const MIGRATIONS: Record<number, (file: Json) => Json> = {
  // v3 only adds optional per-device `ip` settings (routes, DNS, forwarding) and `services`
  // (dnsmasq); the bump keeps older app versions from silently dropping them.
  2: (file) => file,
  // v4 adds optional per-device `files` and the httpd service.
  3: (file) => file,
  // v5 adds laptops, phones, access points and the hostapd service.
  4: (file) => file,
  // v2: devices name a spec instead of a kind; switches gain two SFP uplinks (eth8, eth9);
  // per-kind name counters become per-prefix counters.
  1: (file) => {
    const network = obj(file.network, 'network');
    const counters = obj(network.counters, 'network.counters');
    let mac = count(counters.mac, 'MAC counter');
    const devices = arr(network.devices, 'network.devices').map((value) => {
      if (!isObject(value)) return value;
      const { kind, ...device } = value;
      if (kind === 'host') return { ...device, spec: 'pc' };
      if (kind !== 'switch' || !Array.isArray(device.ports)) return value;
      const uplinks = [8, 9].map((i) => ({ name: `eth${i}`, mac: macFromIndex(++mac), up: true }));
      return { ...device, spec: 'switch', ports: [...device.ports, ...uplinks] };
    });
    const { host, switch: sw, ...rest } = counters;
    return {
      ...file,
      network: { ...network, devices, counters: { ...rest, mac, names: { pc: host, sw } } },
    };
  },
};

/** Parses a lab file. Throws ProjectError with a user-facing message. */
export function parseProject(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail('This is not a NetForge lab file (it is not valid JSON).');
  }
  let file = obj(data, 'The file');
  if (file.format !== PROJECT_FORMAT) fail('This is not a NetForge lab file.');
  let version = count(file.version, 'File version');
  if (version > PROJECT_VERSION) {
    fail('This lab was saved by a newer version of NetForge. Reload the page to update.');
  }
  if (version < 1) fail('File version is invalid.');
  for (; version < PROJECT_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) fail(`Cannot upgrade lab files from version ${version}.`);
    file = { ...migrate(file), version: version + 1 };
  }
  const snapshot = readSnapshot(file.network);
  let net: Network;
  try {
    net = Network.fromJSON(snapshot);
  } catch (error) {
    fail(`The lab is damaged: ${error instanceof Error ? error.message : String(error)}.`);
  }
  return { net, layout: readLayout(file.layout), tasks: readTasks(file.tasks) };
}
