# 0004: Technology stack

**Status:** Accepted (2026-11-13). TypeScript version superseded by [ADR 0006](0006-typescript-7-side-by-side.md).

## Decision

| Need          | Choice                                                   |
| ------------- | -------------------------------------------------------- |
| Language      | TypeScript, strict                                       |
| Build         | Vite                                                     |
| UI            | React                                                    |
| Canvas        | React Flow (`@xyflow/react`)                             |
| Styling       | Tailwind CSS v4 + CSS custom properties for theme tokens |
| Unit tests    | Vitest                                                   |
| E2E tests     | Playwright (Chromium)                                    |
| Lint / format | ESLint (typescript-eslint strict), Prettier              |
| Commits       | Conventional Commits via husky + commitlint              |
| CI            | GitHub Actions                                           |

Added when a feature needs them, not before: xterm.js (terminal), a state library, a
Worker RPC helper, an IndexedDB helper, an i18n library.

## Consequences

React has the largest ecosystem, and React Flow saves us from building a graph editor. The
target scale is tens to a hundred devices, which React Flow handles well.
