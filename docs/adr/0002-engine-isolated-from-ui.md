# 0002: The engine is isolated from the UI

**Status:** Accepted (2026-11-13)

## Context

The simulation is the hardest and most valuable part of the code. It must be testable
without a browser and able to run in a Web Worker.

## Decision

`src/engine/` is pure TypeScript. It must not import from `src/ui/`, React, or use DOM
APIs. This is enforced by:

- ESLint `no-restricted-imports` for `src/engine/**`.
- `tsconfig.engine.json`, which type-checks the engine with only the `ES2022` lib, so
  `window`, `document`, etc. do not exist.

The engine must also be deterministic: time comes from `Scheduler`, never from wall-clock
APIs or timers.

## Consequences

- Engine tests run fast in Node with Vitest.
- The UI talks to the engine through a narrow API, which later becomes the Worker boundary.
