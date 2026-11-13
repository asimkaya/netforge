# 0005: Local-first storage, no accounts, static hosting

**Status:** Accepted (2026-11-13)

## Decision

- No backend and no accounts. The site is a static build hosted on Cloudflare Pages.
- Labs and progress are stored in the browser (IndexedDB).
- Users move work between devices by exporting/importing a versioned JSON file.
- Small labs can be shared as a link, with the topology compressed into the URL hash.

## Consequences

- Free to host, nothing to operate, private by default.
- Browser data can be cleared. We request persistent storage and remind users to export.
- The save format is a public contract: it carries a `version` and is migrated forward.
