# 0009: Host on GitHub Pages

**Status:** Accepted (2026-11-21). Changes the hosting line of [ADR 0005](0005-local-first-no-accounts.md).

## Context

The site was served only from `netforge-20l.pages.dev`. In November 2026 Turkish ISPs
(seen on Turkcell Superonline and on mobile data) started blocking `*.pages.dev`: DNS
answers with an ISP address and direct connections are reset. Our first users are in
Turkey, and we do not want to depend on a custom domain yet.

## Decision

- The main address is GitHub Pages: <https://asimkaya.github.io/netforge/>, deployed by
  the `pages` job in CI. The Cloudflare Pages copy stays as a second address.
- The build uses relative URLs (`base: './'` in Vite, relative paths in `index.html`, the
  manifest and the service worker), so it runs at a site root or under `/netforge/`.

## Consequences

- Browser storage is per origin: labs saved on the old address do not appear on the new
  one. Users move them with export/import.
- Any address on a shared hosting domain can be blocked the same way. A custom domain is
  the lasting fix if this happens again.
