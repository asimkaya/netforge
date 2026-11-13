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
src/ui/       React UI (React Flow canvas, Tailwind)
e2e/          Playwright tests (run against the production build)
docs/         architecture, roadmap, features, ADRs
```

## Gotchas

- `tsc` is TypeScript 7 (`@typescript/native` alias); the `typescript` package is the 6.0
  API for typescript-eslint. Do not "fix" this by installing plain `typescript`. See ADR 0006.
- React Flow's dark background is overridden through `--xy-background-color` in
  `src/ui/index.css`; theme tokens are the `--nf-*` custom properties there.
- `docs/RAPOR.md` is a private, git-ignored planning note. Do not commit it.
