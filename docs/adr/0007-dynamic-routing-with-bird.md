# 0007: Dynamic routing with BIRD

**Status:** Accepted (2026-11-13). Supersedes the "FRR-style configuration" note in ADR 0003.

## Context

Phase 5 adds dynamic routing (OSPF). ADR 0003 planned an FRR-style configuration, but FRR
is configured through `vtysh`, whose `router ospf` / `network ... area` syntax copies one
vendor's router CLI. That conflicts with the vendor-neutral rule.

## Decision

Routers run a simulated **BIRD 2** daemon, the routing daemon common on Linux routers and
Internet exchanges:

- configuration in `/etc/bird.conf` with BIRD's own syntax (`protocol ospf v2 { area 0 {
interface "eth*" { cost 10; }; }; }`, `protocol kernel { ipv4 { export all; }; }`);
- `bird` starts it, `killall bird` or `birdc down` stops it, `birdc configure` reloads;
- `birdc show protocols | show ospf neighbors | show route` inspect it;
- learned routes appear in `ip route` as `proto bird metric 32`.

OSPF runs as real packets (IP protocol 89 to 224.0.0.5): hellos, link-state updates,
Dijkstra on every router. Only the configuration subset NetForge uses is parsed.

## Consequences

- Skills transfer to real Linux routers; nothing imitates a vendor CLI.
- New routers ship a ready `/etc/bird.conf`, so `bird` alone enables OSPF on all ports.
- Simplifications (documented in FEATURES.md): one area, no DR/BDR election, adjacency
  right after two-way hellos, LSAs never age, no ECMP.
