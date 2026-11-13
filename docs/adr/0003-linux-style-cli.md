# 0003: Linux-style, vendor-neutral command line

**Status:** Accepted (2026-11-13)

## Context

Classic simulators copy one vendor's router CLI. NetForge is a vendor-neutral learning lab,
not a clone of any product.

## Decision

Every device, routers included, is configured through a Linux-style shell modeled on real
tools: `ip addr`, `ip link`, `ip route`, `ip neigh`, `ping`, `traceroute`, `dig`, `nft`, `wg`.
Commands follow the real syntax closely enough that what users learn transfers to real
Linux, VyOS/OpenWrt-style routers and servers. Dynamic routing will use an FRR-style
configuration (to be designed in Phase 4).

## Consequences

- Skills transfer to real Linux systems.
- WireGuard and nftables fit naturally.
- A future real Linux node (v86) uses the same commands as simulated devices.
- We must not use vendor trademarks, logos or icons.
