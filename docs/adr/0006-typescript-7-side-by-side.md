# 0006: TypeScript 7 for type-checking, TypeScript 6 API for tooling

**Status:** Accepted (2026-11-13). Supersedes the TypeScript pin in ADR 0004.

## Context

TypeScript 7 (the native port) ships no programmatic API; one is expected in 7.1.
typescript-eslint imports `typescript` directly and supports only `>=4.8.4 <6.1.0`
(tracking issue: typescript-eslint/typescript-eslint#10940). Microsoft publishes
`@typescript/typescript6` so 6.0 and 7.0 can run side by side.

## Decision

Follow Microsoft's side-by-side setup with npm aliases:

```json
"@typescript/native": "npm:typescript@^7.0.2",
"typescript": "npm:@typescript/typescript6@^6.0.2"
```

- `tsc` (and `npm run typecheck` / `npm run build`) runs TypeScript 7.
- Anything that does `require("typescript")`, such as typescript-eslint, gets the 6.0 API.

## Consequences

- We type-check with TypeScript 7 today.
- Lint parses code with 6.0. A TS 7-only syntax feature could pass `tsc` but fail lint.
- When typescript-eslint supports TypeScript 7, drop the alias and depend on `typescript`
  directly.
