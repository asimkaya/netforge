# 0001: Simulate protocols instead of emulating real operating systems

**Status:** Accepted (2026-11-13)

## Context

Network labs come in two kinds. Emulators (GNS3, EVE-NG, Containerlab) run real operating
system images and need a server. Simulators (Packet Tracer, Filius) model protocols in
software. We want a zero-install site on static hosting.

## Decision

NetForge models protocols in TypeScript as a deterministic discrete-event simulation.

## Consequences

- Works on static hosting and needs no image licenses.
- Deterministic, so guided tasks and tests are reliable.
- We can pause any packet and inspect it layer by layer (simulation mode).
- Every protocol is our own work, and fidelity is limited by effort. Simplifications are
  documented in `docs/FEATURES.md`.
- A real Linux node (v86/WASM) may be added later as a special device type.
