import { macFromIndex } from '../engine/addr.ts';
import { Network, type NetworkSnapshot } from '../engine/network.ts';
import { isSpecId, type SpecId } from '../engine/specs.ts';
import { SERVICES, checkError, type CustomCheck, type CustomTask } from '../tasks/custom.ts';
import { LIMITS, NOTE_ID, ZONE_ID, type Note, type Zone } from './annotations.ts';
import type { Point } from './lab.ts';

export const PROJECT_FORMAT = 'netforge-lab';
/** Bump on any incompatible change and add a migration for the previous version. */
export const PROJECT_VERSION = 14;

export interface TaskProgress {
  /** Id of the task being played, if any. */
  active: string | null;
  /** Number of completed steps per task id. */
  steps: Record<string, number>;
  /** Tasks written in the task editor, saved and shared with the lab. */
  custom?: CustomTask[];
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  network: NetworkSnapshot;
  layout: Record<string, Point>;
  notes: Note[];
  zones: Zone[];
  tasks: TaskProgress;
}

export interface Project {
  net: Network;
  layout: Record<string, Point>;
  /** Canvas notes and zones; a lab without any may leave them out. */
  notes?: Note[];
  zones?: Zone[];
  tasks: TaskProgress;
}

export function emptyProgress(): TaskProgress {
  return { active: null, steps: {} };
}

export function serializeProject({ net, layout, notes = [], zones = [], tasks }: Project): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    network: net.toJSON(),
    layout,
    notes,
    zones,
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
const PORT = /^(eth|wlan)[0-9]{1,2}$/;
/** Any interface name, including VLAN interfaces like eth0.10 (Linux allows 15 characters). */
const IFNAME = /^[A-Za-z][\w.-]{0,14}$/;
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
        dev: str(r.dev, `${what} route device`, IFNAME),
      };
    }),
  };
}

/** Service command lines; the engine's own option parser checks their content. */
function readServices(value: unknown, what: string) {
  const services = obj(value, `${what} services`);
  const list = (
    key:
      | 'dnsmasq'
      | 'dhcrelay'
      | 'httpd'
      | 'postfix'
      | 'dovecot'
      | 'hostapd'
      | 'bird'
      | 'radvd'
      | 'sshd',
    pattern: RegExp,
  ) =>
    services[key] === undefined
      ? {}
      : {
          [key]: arr(services[key], `${what} ${key} options`).map((a) =>
            str(a, `${what} ${key} option`, pattern),
          ),
        };
  return {
    ...list('dnsmasq', /^--?[a-z-]+(=[!-~]{0,200})?$/),
    ...list('dhcrelay', /^[\w./-]{1,240}$/),
    ...list('httpd', /^[\w./-]{1,240}$/),
    ...list('postfix', /^$/),
    ...list('dovecot', /^$/),
    ...list('hostapd', /^[\w./-]{1,240}$/),
    ...list('bird', /^[\w./-]{1,240}$/),
    ...list('radvd', /^[\w./-]{1,240}$/),
    ...list('sshd', /^$/),
  };
}

function vid(value: unknown, what: string): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 4094
    ? (value as number)
    : fail(`${what} is invalid.`);
}

function readVlanPorts(value: unknown, what: string) {
  return arr(value, `${what} VLAN interfaces`).map((raw) => {
    const v = obj(raw, `${what} VLAN interface`);
    if (typeof v.up !== 'boolean') fail(`${what} VLAN interface state is invalid.`);
    return {
      name: str(v.name, `${what} VLAN interface name`, IFNAME),
      parent: str(v.parent, `${what} VLAN interface parent`, PORT),
      vid: vid(v.vid, `${what} VLAN id`),
      up: v.up,
      addrs: arr(v.addrs, `${what} VLAN addresses`).map((a) => str(a, 'address', CIDR)),
    };
  });
}

function readBridge(value: unknown, what: string) {
  const b = obj(value, `${what} switch settings`);
  if (typeof b.vlanFiltering !== 'boolean') fail(`${what} VLAN filtering setting is invalid.`);
  const vlans: Record<string, { vids: number[]; pvid: number | null; untagged: number[] }> = {};
  for (const [name, raw] of Object.entries(obj(b.vlans, `${what} port VLANs`))) {
    const v = obj(raw, `${what} VLANs of ${name}`);
    const list = (key: string) =>
      arr(v[key], `${what} VLANs of ${name}`).map((x) => vid(x, `${what} VLAN id`));
    vlans[str(name, `${what} port name`, PORT)] = {
      vids: list('vids'),
      pvid: v.pvid === null ? null : vid(v.pvid, `${what} PVID`),
      untagged: list('untagged'),
    };
  }
  if (b.stp !== undefined && typeof b.stp !== 'boolean') fail(`${what} STP setting is invalid.`);
  return {
    vlanFiltering: b.vlanFiltering,
    vlans,
    ...(b.stp === undefined ? {} : { stp: b.stp }),
    ...(b.priority === undefined ? {} : { priority: count(b.priority, `${what} bridge priority`) }),
    ...(b.forwardDelay === undefined
      ? {}
      : { forwardDelay: count(b.forwardDelay, `${what} bridge forward delay`) }),
  };
}

const CIDR6 = /^[0-9a-f:]{2,39}(\/[0-9]{1,3})?$/;
const IP6 = /^[0-9a-f:]{2,39}$/;

function readIp6(value: unknown, what: string) {
  const v = obj(value, `${what} IPv6 settings`);
  if (typeof v.forwarding !== 'boolean') fail(`${what} IPv6 forwarding setting is invalid.`);
  const addrs: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(obj(v.addrs, `${what} IPv6 addresses`))) {
    addrs[str(name, `${what} interface name`, IFNAME)] = arr(list, `${what} IPv6 addresses`).map(
      (a) => str(a, `${what} IPv6 address`, CIDR6),
    );
  }
  return {
    forwarding: v.forwarding,
    addrs,
    routes: arr(v.routes, `${what} IPv6 routes`).map((raw) => {
      const r = obj(raw, `${what} IPv6 route`);
      return {
        dst: str(r.dst, `${what} IPv6 route destination`, CIDR6),
        ...(r.via === undefined ? {} : { via: str(r.via, `${what} IPv6 route gateway`, IP6) }),
        dev: str(r.dev, `${what} IPv6 route device`, IFNAME),
      };
    }),
  };
}

const KEY = /^[A-Za-z0-9+/]{43}=$/;
const ENDPOINT = /^[0-9.]{7,15}:[0-9]{1,5}$/;

function readWireguard(value: unknown, what: string) {
  return arr(value, `${what} WireGuard interfaces`).map((raw) => {
    const w = obj(raw, `${what} WireGuard interface`);
    if (typeof w.up !== 'boolean') fail(`${what} WireGuard state is invalid.`);
    return {
      name: str(w.name, `${what} WireGuard name`, IFNAME),
      up: w.up,
      addrs: arr(w.addrs, `${what} WireGuard addresses`).map((a) => str(a, 'address', CIDR)),
      privateKey: w.privateKey === null ? null : str(w.privateKey, `${what} WireGuard key`, KEY),
      listenPort: w.listenPort === null ? null : count(w.listenPort, `${what} WireGuard port`),
      peers: arr(w.peers, `${what} WireGuard peers`).map((rawPeer) => {
        const p = obj(rawPeer, `${what} WireGuard peer`);
        return {
          publicKey: str(p.publicKey, `${what} WireGuard peer key`, KEY),
          ...(p.endpoint === undefined
            ? {}
            : { endpoint: str(p.endpoint, `${what} WireGuard endpoint`, ENDPOINT) }),
          allowedIps: arr(p.allowedIps, `${what} WireGuard allowed IPs`).map((a) =>
            str(a, `${what} WireGuard allowed IP`, CIDR),
          ),
          ...(p.keepalive === undefined
            ? {}
            : { keepalive: count(p.keepalive, `${what} WireGuard keepalive`) }),
        };
      }),
    };
  });
}

/** Device files: sizes are checked again when the engine writes them. */
function readLeases(value: unknown, what: string) {
  return arr(value, `${what} DHCP leases`).map((v) => {
    const l = obj(v, `${what} DHCP lease`);
    return {
      mac: str(l.mac, `${what} lease MAC address`, MAC),
      ip: str(l.ip, `${what} lease address`, IP),
      prefix: count(l.prefix, `${what} lease prefix`),
      ...(l.hostname === undefined
        ? {}
        : { hostname: str(l.hostname, `${what} lease name`, NAME) }),
      seconds: count(l.seconds, `${what} lease time`),
    };
  });
}

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
      ...(d.leases === undefined ? {} : { leases: readLeases(d.leases, `device #${i + 1}`) }),
      ...(d.files === undefined ? {} : { files: readFiles(d.files, `device #${i + 1}`) }),
      ...(d.vlanPorts === undefined
        ? {}
        : { vlanPorts: readVlanPorts(d.vlanPorts, `device #${i + 1}`) }),
      ...(d.bridge === undefined ? {} : { bridge: readBridge(d.bridge, `device #${i + 1}`) }),
      ...(d.ip6 === undefined ? {} : { ip6: readIp6(d.ip6, `device #${i + 1}`) }),
      ...(d.bridgeAddrs === undefined
        ? {}
        : {
            bridgeAddrs: arr(d.bridgeAddrs, `device #${i + 1} br0 addresses`).map((a) =>
              str(a, 'address', CIDR),
            ),
          }),
      ...(d.wireguard === undefined
        ? {}
        : { wireguard: readWireguard(d.wireguard, `device #${i + 1}`) }),
      // The engine parses the ruleset; this only bounds its size.
      ...(d.firewall === undefined
        ? {}
        : { firewall: str(d.firewall, `device #${i + 1} firewall`, /^[^]{0,100000}$/) }),
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

function coordinate(value: unknown, what: string): number {
  return typeof value === 'number' && Math.abs(value) <= LIMITS.coordinate
    ? value
    : fail(`${what} is invalid.`);
}

function size(value: unknown, what: string, range: { min: number; max: number }): number {
  return typeof value === 'number' && value >= range.min && value <= range.max
    ? value
    : fail(`${what} is invalid.`);
}

/** Free text: no control characters except line breaks, and a length limit. */
function text(value: unknown, what: string, max: number): string {
  // Built from a string, like TEXT below: the pattern lists control characters on purpose.
  const allowed = new RegExp(`^[^\u0000-\u0008\u000b-\u001f]{0,${max}}$`);
  return typeof value === 'string' && allowed.test(value) ? value : fail(`${what} is invalid.`);
}

function readNotes(value: unknown): Note[] {
  const list = arr(value ?? [], 'notes');
  if (list.length > LIMITS.notes) fail('There are too many notes.');
  const seen = new Set<string>();
  return list.map((raw) => {
    const n = obj(raw, 'A note');
    const id = str(n.id, 'note id', NOTE_ID);
    if (seen.has(id)) fail(`Note ${id} appears twice.`);
    seen.add(id);
    return {
      id,
      x: coordinate(n.x, `position of ${id}`),
      y: coordinate(n.y, `position of ${id}`),
      w: size(n.w, `width of ${id}`, LIMITS.noteWidth),
      text: text(n.text, `text of ${id}`, LIMITS.noteText),
    };
  });
}

function readZones(value: unknown): Zone[] {
  const list = arr(value ?? [], 'zones');
  if (list.length > LIMITS.zones) fail('There are too many zones.');
  const seen = new Set<string>();
  return list.map((raw) => {
    const z = obj(raw, 'A zone');
    const id = str(z.id, 'zone id', ZONE_ID);
    if (seen.has(id)) fail(`Zone ${id} appears twice.`);
    seen.add(id);
    const tint = z.tint;
    if (!Number.isInteger(tint) || (tint as number) < 0 || (tint as number) >= LIMITS.zoneTints) {
      fail(`tint of ${id} is invalid.`);
    }
    return {
      id,
      x: coordinate(z.x, `position of ${id}`),
      y: coordinate(z.y, `position of ${id}`),
      w: size(z.w, `width of ${id}`, LIMITS.zoneWidth),
      h: size(z.h, `height of ${id}`, LIMITS.zoneHeight),
      title: text(z.title, `title of ${id}`, LIMITS.zoneTitle),
      tint: tint as number,
    };
  });
}

const TEXT = (max: number) => new RegExp(`^[^\\u0000-\\u0008]{0,${max}}$`);
const DEVICE = /^([A-Za-z0-9][A-Za-z0-9-]{0,62})?$/;

function readCheck(value: unknown, what: string): CustomCheck {
  const c = obj(value, what);
  const name = (v: unknown, field: string) => str(v, `${what} ${field}`, DEVICE);
  let check: CustomCheck;
  switch (c.kind) {
    case 'ping':
      check = {
        kind: 'ping',
        from: name(c.from, 'device'),
        to: str(c.to, `${what} target`, /^[\w.:-]{0,63}$/),
      };
      break;
    case 'address':
      check = {
        kind: 'address',
        device: name(c.device, 'device'),
        network: str(c.network, `${what} network`, CIDR),
      };
      break;
    case 'cable':
      check = { kind: 'cable', a: name(c.a, 'device'), b: name(c.b, 'device') };
      break;
    case 'service': {
      const service = SERVICES.find((s) => s === c.service) ?? fail(`${what} service is invalid.`);
      check = { kind: 'service', device: name(c.device, 'device'), service };
      break;
    }
    case 'command':
      check = {
        kind: 'command',
        device: name(c.device, 'device'),
        text: str(c.text, `${what} text`, TEXT(200)),
      };
      break;
    case 'devices':
      check = {
        kind: 'devices',
        spec: isSpecId(c.spec) ? c.spec : fail(`${what} device type is invalid.`),
        count: count(c.count, `${what} count`),
      };
      break;
    default:
      fail(`${what} kind is invalid.`);
  }
  const error = checkError(check);
  if (error) fail(`${what}: ${error}`);
  return check;
}

function readCustomTasks(value: unknown): CustomTask[] {
  return arr(value, 'custom tasks').map((raw, i) => {
    const what = `custom task #${i + 1}`;
    const t = obj(raw, what);
    const steps = arr(t.steps, `${what} steps`).map((rawStep, j) => {
      const s = obj(rawStep, `${what} step #${j + 1}`);
      return {
        title: str(s.title, `${what} step title`, TEXT(200)),
        detail: str(s.detail, `${what} step text`, TEXT(2000)),
        ...(s.hint === undefined ? {} : { hint: str(s.hint, `${what} hint`, TEXT(2000)) }),
        check: readCheck(s.check, `${what} step #${j + 1} check`),
      };
    });
    if (steps.length === 0 || steps.length > 30) fail(`${what} needs 1 to 30 steps.`);
    return {
      id: str(t.id, `${what} id`, /^custom-[a-z0-9-]{1,40}$/),
      title: str(t.title, `${what} title`, TEXT(200)),
      summary: str(t.summary, `${what} summary`, TEXT(2000)),
      steps,
      done: str(t.done, `${what} done text`, TEXT(2000)),
    };
  });
}

function readTasks(value: unknown): TaskProgress {
  if (value === undefined) return emptyProgress();
  const t = obj(value, 'tasks');
  const active = t.active === null ? null : str(t.active, 'active task', /^[a-z0-9-]{1,48}$/);
  const steps: Record<string, number> = {};
  for (const [id, n] of Object.entries(obj(t.steps, 'task steps'))) {
    steps[str(id, 'task id', /^[a-z0-9-]{1,48}$/)] = count(n, `progress of ${id}`);
  }
  return t.custom === undefined
    ? { active, steps }
    : { active, steps, custom: readCustomTasks(t.custom) };
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
  // v6 adds optional VLAN interfaces (`vlanPorts`), switch VLAN settings (`bridge`) and the
  // nftables ruleset (`firewall`).
  5: (file) => file,
  // v7 adds Spanning Tree settings (`stp`, `priority`) to the switch settings.
  6: (file) => file,
  // v8 adds IPv6 settings (`ip6`) and the radvd service.
  7: (file) => file,
  // v9 adds WireGuard interfaces (`wireguard`).
  8: (file) => file,
  // v10 adds tasks written in the task editor (`tasks.custom`).
  9: (file) => file,
  // v11 adds the home router device and its br0 addresses (`bridgeAddrs`).
  10: (file) => file,
  // v12 adds the dhcrelay service and the Spanning Tree `forwardDelay` of a switch.
  11: (file) => file,
  // v13 adds canvas notes and zones (`notes`, `zones`).
  12: (file) => ({ notes: [], zones: [], ...file }),
  // v14 adds the DHCP leases of a running dnsmasq (`leases`); older files have none.
  13: (file) => file,
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
export function parseProject(text: string): Required<Project> {
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
  return {
    net,
    layout: readLayout(file.layout),
    notes: readNotes(file.notes),
    zones: readZones(file.zones),
    tasks: readTasks(file.tasks),
  };
}
