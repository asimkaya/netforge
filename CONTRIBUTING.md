# Contributing

Thanks for helping build NetForge!

## Workflow

1. Create a branch from `main` (`feat/arp`, `fix/canvas-zoom`, ...).
2. Make small, focused commits.
3. Open a pull request. CI must be green before merge.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook
checks every commit.

```
<type>(<optional scope>): <summary in imperative mood>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
`revert`. Common scopes: `engine`, `ui`, `cli`, `tasks`, `storage`.

Examples:

- `feat(engine): add ARP request/reply handling`
- `fix(ui): keep cable selected after drag`
- `docs: explain how to add a protocol module`

## Quality bar

- `npm run lint`, `npm run typecheck`, `npm test` and `npm run test:e2e` pass.
- New engine behavior comes with unit tests.
- User-visible changes update [docs/FEATURES.md](docs/FEATURES.md).
- Architectural changes come with an ADR in [docs/adr](docs/adr).
