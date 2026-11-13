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
  snapshots), `host.ts`, `switch.ts`, `shell.ts` (Linux-style commands).

### `src/ui/`: user interface

- React + React Flow (canvas) + Tailwind CSS.
- Reads engine state and sends commands. It never re-implements network logic.
- Theme colors are CSS custom properties in `src/ui/index.css` (`--nf-*`). Dark is the
  default.
- `lab.ts` is the single UI store: the live `Network` plus layout, selection, mode,
  terminal sessions and task progress. Components read it with `useLab()`.
- Realtime mode advances the scheduler every animation frame (`clock.ts`); simulation
  mode only advances it when the user steps.

### `src/tasks/`: guided tasks

- Pure TypeScript. A task is a list of steps; each step's `check` reads the live network
  and the commands the user ran. Steps complete in order and stay complete.

### Persistence

- `src/ui/project.ts` defines the lab file (`format: netforge-lab`, `version: 1`) and
  validates untrusted files field by field before the engine sees them.
- `src/ui/storage.ts` autosaves to IndexedDB and exports/imports files.
- Bump `PROJECT_VERSION` on incompatible changes and migrate older files. Never break old
  save files.

## Testing

| Kind       | Tool       | Location           | What                                  |
| ---------- | ---------- | ------------------ | ------------------------------------- |
| Unit       | Vitest     | `src/**/*.test.ts` | Engine logic, pure helpers            |
| End-to-end | Playwright | `e2e/*.spec.ts`    | Real browser flows, against the build |
