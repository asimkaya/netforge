# NetForge

Build, wire and debug computer networks right in your browser. No install, no account.

NetForge is an open-source network simulator for learning. Drop hosts, switches and
routers on a canvas, connect them, configure them from a Linux-style shell, and watch
packets travel hop by hop. Guided tasks take you from "two machines that can ping each
other" to VLANs, routing, NAT, firewalls and VPNs.

> **Status:** early development (Phase 0 — project foundation). See the
> [roadmap](docs/ROADMAP.md).

## Principles

- **Runs entirely in the browser.** Static site, no backend.
- **Local-first.** Your labs are saved in your browser. Export them to a file to move
  to another device.
- **Vendor-neutral.** Devices are configured with Linux-style commands (`ip`, `nft`,
  `wg`), not a copy of any vendor's CLI.
- **Learn by doing.** Guided tasks check the real simulation state, not screenshots.

## Development

Requires Node.js 22+ (see `.nvmrc`).

```bash
npm install
npm run dev          # start dev server at http://localhost:5173
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests (Playwright)
npm run lint
npm run typecheck
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand how the pieces fit.

## Deployment

The site is deployed to Cloudflare Pages:

- Build command: `npm run build`
- Output directory: `dist`

## License

[MIT](LICENSE)
