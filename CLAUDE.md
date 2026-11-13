# NetForge: rules for AI assistants and contributors

NetForge is an open-source, browser-only network simulator for learning (static site, no
backend, no accounts). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing
structure, and [docs/ROADMAP.md](docs/ROADMAP.md) to see which phase we are in.

## Hard rules

1. **Everything in the repo is English:** code, comments, docs, commit messages, UI text.
2. **Vendor-neutral.** No Cisco/Packet Tracer names, logos, icons or IOS-style commands.
   The device shell is Linux-style (`ip`, `ping`, `nft`, `wg`...). See ADR 0003.
3. **Engine isolation.** `src/engine/` never imports `src/ui/`, React, or DOM APIs. Lint
   and `tsconfig.engine.json` enforce this. Do not weaken those rules to make code pass.
4. **Determinism.** Engine time comes only from `Scheduler`. No `Date.now()`,
   `Math.random()`, `setTimeout` in the engine.
5. **Save files are a contract.** Changing the persisted format requires bumping its
   `version` and adding a migration plus a test that loads the old format.
6. **No backend.** Anything that needs a server is out of scope unless an ADR says
   otherwise.

## Workflow

- Conventional Commits, enforced by commitlint: `feat(engine): ...`, `fix(ui): ...`,
  `docs: ...`, `test: ...`, `refactor: ...`, `build: ...`, `ci: ...`, `chore: ...`.
- Small commits, one logical change each. Never use `--no-verify`.
- Before committing, all of these must pass:
  `npm run lint && npm run typecheck && npm test` (and `npm run test:e2e` for UI changes).
- New engine behavior needs Vitest tests next to the code (`foo.ts` → `foo.test.ts`).
- New user-facing flows need a Playwright test in `e2e/`.
- When a feature lands, update [docs/FEATURES.md](docs/FEATURES.md) in the same change.
- When a decision changes the architecture or stack, add an ADR in `docs/adr/`.
- Add a dependency only when the feature needs it now. No speculative abstractions.

## Layout

```
src/engine/   simulation engine (pure TS, tested with Vitest)
src/tasks/    guided tasks (pure TS, tested with Vitest)
src/ui/       React UI (React Flow canvas, Tailwind), lab store, lab files
e2e/          Playwright tests (run against the production build)
docs/         architecture, roadmap, features, ADRs
```

## Adding a device type

1. Add a `DeviceSpec` in `src/engine/specs.ts` (ports with types, `bridge`, `ip`).
2. Draw its faceplate in `src/ui/DeviceNode.tsx` and a small icon in `src/ui/icons.tsx`;
   every port must be a `Socket` (React Flow handle) so it can be cabled.
3. If saved labs could contain something the new code reads differently, bump
   `PROJECT_VERSION` in `src/ui/project.ts` and add a migration with a test.
4. Engine tests for its behavior, an e2e test for cabling it, and a FEATURES.md row.

## Gotchas

- TypeScript is pinned to 6.0.x because typescript-eslint does not support 7.x yet.
- React Flow's dark background is overridden through `--xy-background-color` in
  `src/ui/index.css`; theme tokens are the `--nf-*` custom properties there.
- Each device node always mounts a full-size "body" target handle (pointer events off
  until a cable drag starts). React Flow only knows handles it measured, so a handle
  mounted mid-drag is ignored.
- Nodes are controlled: `Canvas.tsx` must feed React Flow's `measured` sizes back, or
  nodes become unclickable after re-renders.
- E2E tests share helpers in `e2e/helpers.ts` (`add`, `connect('pc1', 'sw1/eth3')`, `run`).
- `docs/RAPOR*.md` are private, git-ignored planning notes (Turkish). Do not commit them.
