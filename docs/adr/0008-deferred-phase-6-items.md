# 0008: Deferred Phase 6 items

**Status:** Accepted (2026-11-13)

## Context

Phase 6 listed WireGuard, SSH, pcap export, a task editor, link aggregation, Bluetooth/IoT,
a real Linux node (v86) and multiplayer over WebRTC. The first four shipped. The rest
were weighed against the project's rules (no backend, vendor-neutral, beginners first)
and the cost of doing them well.

## Decision

These items move to a later phase:

- **Real Linux node via v86.** It needs a WebAssembly emulator plus a Linux image of tens
  of megabytes, downloaded from somewhere and kept in the browser. That is a new
  dependency, a large download on a site meant to open instantly, and a second way to
  break determinism. Revisit when there is a clear lesson the simulated shell cannot
  teach.
- **Multiplayer over WebRTC.** Peers need signaling to find each other, which means a
  server (ADR 0005 forbids one) or a clumsy copy-and-paste of offers. Share links and lab
  files already let people pass labs around.
- **Link aggregation (bonding, LACP).** It touches the bridge, Spanning Tree, VLANs and
  the loop check at once, for a topic beginners rarely meet first. It needs its own
  design.
- **Bluetooth and IoT devices.** No lesson in the curriculum needs them yet; adding a
  device that does nothing real breaks ADR 0006.

## Consequences

- Phase 6 is done with what it shipped; the deferred items are listed as Phase 7.
- Nothing in the code anticipates them; they start from a design (and an ADR) when
  picked up.
