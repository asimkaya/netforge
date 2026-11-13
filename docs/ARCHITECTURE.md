# Architecture

NetForge is a static single-page app. Everything, including the network simulation, runs
in the user's browser.

```
┌─────────────────────────────────────────────┐
│ UI (React)                     src/ui/      │
│  Canvas · Device panels · Terminal ·        │
│  Simulation timeline · Tasks                │
├─────────────────────────────────────────────┤
│ App state + commands / undo                 │
├───────────── messages (Web Worker) ─────────┤
│ Simulation engine (pure TS)   src/engine/   │
│  Scheduler (virtual clock) · Devices ·      │
│  Protocol modules · Shell interpreter       │
├─────────────────────────────────────────────┤
│ Persistence: IndexedDB · JSON export/import │
└─────────────────────────────────────────────┘
```

Only the scheduler and the UI shell exist today. The rest of the diagram is the target
design; see the [roadmap](ROADMAP.md).

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
- Will run inside a Web Worker so the UI never blocks.

### `src/ui/`: user interface

- React + React Flow (canvas) + Tailwind CSS.
- Reads engine state and sends commands. It never re-implements network logic.
- Theme colors are CSS custom properties in `src/ui/index.css` (`--nf-*`). Dark is the
  default.

### Persistence (planned)

- Projects and task progress are saved to IndexedDB.
- Export/import as a versioned JSON file. Every file carries a `version` field, and loading
  an older version runs migrations. Never break old save files.

## Testing

| Kind       | Tool       | Location           | What                                  |
| ---------- | ---------- | ------------------ | ------------------------------------- |
| Unit       | Vitest     | `src/**/*.test.ts` | Engine logic, pure helpers            |
| End-to-end | Playwright | `e2e/*.spec.ts`    | Real browser flows, against the build |
