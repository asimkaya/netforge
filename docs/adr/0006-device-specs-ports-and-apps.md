# 0006: Device specs, typed ports and apps backed by protocols

**Status:** Accepted (2026-11-13)

## Context

Phase 1 hard-codes two device classes (`Host`, `Switch`), auto-picks ports when cabling,
draws generic icons and opens a single bottom terminal. The roadmap adds many devices
(router, server, laptop, phone, access point, home router, internet cloud) and
desktop-style apps (browser, mail, text editor, Wi-Fi, firewall). Without a shared model,
each device would duplicate network logic and each app risks being decoration.

## Decision

1. **Devices are data.** A `DeviceSpec` declares hardware (typed ports, radios, faceplate
   layout), the OS modules it runs, and the apps it offers. Adding a device means adding a
   spec, not a class.
2. **The engine is composed of stack modules**: `Bridge` (L2 switching), `IpStack` (ARP,
   routing table, optional forwarding), later `Udp`, `Tcp` with a socket API, services
   (DHCP, DNS, HTTP, mail) and a small virtual filesystem. A router is `IpStack` with
   forwarding on; an L3 switch is `Bridge` + `IpStack`.
3. **Ports and links are typed**: port types `ethernet`, `sfp`, `console`, `wifi`; link
   types `copper`, `fiber`, `console`, `wireless`. Compatibility is checked by the engine.
   No straight/crossover distinction (auto-MDI-X), documented in FEATURES.md.
4. **Every app is a client of a real protocol** with a counterpart service in the engine
   (browser → DNS + HTTP, mail → SMTP/POP3, Wi-Fi → AP association). Apps without a
   counterpart are not added. Bluetooth is deferred to the IoT phase for this reason.
5. **UI:** devices are drawn as SVG faceplates with clickable ports and link/activity LEDs.
   Cables go port to port; dropping on a device body opens a port menu. A single click
   opens a movable device window (Physical / Config / Desktop or CLI tabs); several
   windows can be open at once; on narrow screens a window fills the screen.

## Consequences

- Phase 1.5 refactors `Host`/`Switch` into specs + modules before routers are added, so
  routers and later devices reuse the same code.
- Lab files gain port types; the file `version` is bumped with a migration from version 1.
- Faceplate artwork is per device and lives with its spec.
