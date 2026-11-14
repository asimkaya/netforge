# Architecture

NetForge is a static single-page app. Everything, including the network simulation, runs
in the user's browser.

```
┌─────────────────────────────────────────────┐
│ UI (React)                     src/ui/      │
│  Canvas · Device panels · Terminal ·        │
│  Simulation timeline · Tasks                │
├─────────────────────────────────────────────┤
│ Lab store (src/ui/lab.ts) · Tasks           │
├─────────────────────────────────────────────┤
│ Simulation engine (pure TS)   src/engine/   │
│  Scheduler (virtual clock) · Devices ·      │
│  Protocol modules · Shell interpreter       │
├─────────────────────────────────────────────┤
│ Persistence: IndexedDB · JSON export/import │
└─────────────────────────────────────────────┘
```

See [FEATURES.md](FEATURES.md) for what exists today and the [roadmap](ROADMAP.md) for what
comes next.

## Layers

### `src/engine/`: simulation engine

- Pure TypeScript. **Must not import UI code, React, or use DOM APIs.** Enforced by ESLint
  (`no-restricted-imports`) and by type-checking it with no DOM lib (`tsconfig.engine.json`).
  See [ADR 0002](adr/0002-engine-isolated-from-ui.md).
- **Deterministic.** Time is virtual and driven by `Scheduler`. The same topology and inputs
  always produce the same events. Never use `Date.now()`, `Math.random()` or timers in the
  engine; take time from the scheduler and randomness from a seeded generator.
- Packets are layered objects (`Ethernet → IPv4 → ICMP`). Fields are real (MACs, TTL), but
  we do not encode bytes unless a feature needs it (e.g. pcap export).
- A device = interfaces + protocol modules + configuration. Configuration is the single
  source of truth. The shell and the GUI both edit it.
- Each protocol is a self-contained module with its own tests.
- Runs on the main thread today. If large labs make the UI stutter, move it into a Web
  Worker behind the same narrow API.
- Key files: `scheduler.ts` (virtual clock), `network.ts` (devices, cables, trace,
  snapshots), `specs.ts` (device catalog), `device.ts` (a device built from a spec),
  `port.ts` (typed ports and cables), `bridge.ts` (L2 switching, VLAN filtering), `stp.ts`
  (Spanning Tree), `ip.ts` (IPv4, ARP, routing, forwarding, ICMP errors, UDP sockets),
  `addr6.ts` and `ip6.ts` (IPv6, NDP, SLAAC), `netfilter.ts` (nftables hooks, conntrack,
  NAT) and `nft.ts` (its language), `bird.ts` (OSPF), `wireguard.ts` (VPN tunnels),
  `ssh.ts` (sshd and client), `pcap.ts` (frames as bytes, pcap files), `dnsmasq.ts` (DHCP
  and DNS server),
  `dhcp.ts` (dhclient), `dns.ts` (resolver), `tcp.ts` (TCP), `http.ts` (httpd, client),
  `drops.ts` (the record of discarded packets and why) with `explain.ts` (turns it into the
  "Why did this fail?" answer), `mail.ts` (SMTP, POP3), `wifi.ts` (hostapd, association, range), `fs.ts` (device
  files), and the Linux-style commands in `shell.ts` with `shell-files.ts`,
  `shell-services.ts`, `shell-firewall.ts`, `shell-routing.ts`, `shell-ip6.ts` and
  `shell-wireguard.ts`. Commands may be interactive: a `Process` can take input lines and
  show its own prompt (ssh), and pipelines pass output lines as `stdin`.
- Interfaces beyond the physical ports are ordinary `Port` objects: VLAN interfaces have a
  `parent`, WireGuard interfaces a `tunnel`, and a bridge's own interface (`br0` on the
  home router) `bridgeSelf`. The IP stack routes over all of them alike. Specs may list `setup` commands that a new
  device runs once (the internet cloud configures itself this way).
- Services and apps talk through the IP stack's sockets (`openUdp`, `openIcmp`), never by
  reaching into other devices. Errors come back to the socket that sent the packet. See [ADR 0006](adr/0006-device-specs-ports-and-apps.md).

### `src/ui/`: user interface

- React + React Flow (canvas) + Tailwind CSS.
- Reads engine state and sends commands. It never re-implements network logic.
- Theme colors are CSS custom properties in `src/ui/index.css` (`--nf-*`). Dark is the
  default.
- `lab.ts` is the single UI store: the live `Network` plus layout, selection, open
  device windows, mode, terminal sessions and task progress. Components read it with
  `useLab()`.
- Device windows live in `window/` (frame, tabs, and Config sections for routing, services,
  VLANs, STP, OSPF and the firewall) and their apps in `apps/` (Terminal, IP Configuration,
  Web Browser, Text Editor, Mail, Packet Capture, Wi-Fi).
- `history.ts` keeps undo snapshots of the lab file format; `share.ts` packs a lab into a
  `#lab=` link; `placement.ts` finds a free spot for new devices. Apps call the same engine methods as the shell, so the GUI and the
  CLI never disagree.
- `net.locate` is set by the UI store to device centers on the canvas; Wi-Fi range uses it,
  and moving a device re-checks range.
- Realtime mode advances the scheduler every animation frame (`clock.ts`); simulation
  mode only advances it when the user steps.

### `src/tasks/`: guided tasks

- Pure TypeScript. A task is a list of steps; each step's `check` reads the live network
  and the commands the user ran. Steps complete in order and stay complete.
- `custom.ts` turns tasks written in the task editor (data with declarative checks, saved
  in the lab file) into playable tasks.

### Persistence

- `src/ui/project.ts` defines the lab file (`format: netforge-lab`, `version: 11`) and
  validates untrusted files field by field before the engine sees them.
- `src/ui/storage.ts` autosaves to IndexedDB and exports/imports files.
- Bump `PROJECT_VERSION` on incompatible changes and migrate older files. Never break old
  save files.

## Testing

| Kind       | Tool       | Location           | What                                  |
| ---------- | ---------- | ------------------ | ------------------------------------- |
| Unit       | Vitest     | `src/**/*.test.ts` | Engine logic, pure helpers            |
| End-to-end | Playwright | `e2e/*.spec.ts`    | Real browser flows, against the build |
