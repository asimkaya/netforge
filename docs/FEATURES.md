# Features

What the simulator supports today. Update this file in the same pull request as the
feature. If behavior is simplified compared to real networks, say how.

Legend: ✅ supported · 🟡 partial · ❌ not yet

## Devices

| Device | Status | Notes                                                                                                                                  |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| PC     | ✅     | One Ethernet port (`eth0`). No loopback interface.                                                                                     |
| Switch | ✅     | 8 Ethernet ports (`eth0`–`eth7`) and 2 SFP fiber uplinks (`eth8`, `eth9`); unmanaged learning bridge. No IP address, no VLANs, no STP. |
| Router | ❌     | Phase 2                                                                                                                                |

## Network behavior

| Feature           | Status | Notes                                                                                                                                                  |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cables            | ✅     | Port to port. Copper joins Ethernet ports, fiber joins SFP ports; no straight/crossover distinction (auto-MDI-X). 0.25 ms per hop. No speed or duplex. |
| Switching loops   | 🟡     | A cable that joins two ports of the same L2 broadcast domain is refused, since there is no STP yet.                                                    |
| MAC learning      | ✅     | 300 s ageing like the Linux bridge; entries on a port are flushed when it loses carrier.                                                               |
| ARP               | ✅     | 3 probes, 1 s apart, then `FAILED`. Entries stay `REACHABLE` forever (no `STALE`/aging).                                                               |
| IPv4              | 🟡     | Multiple addresses per port, connected routes only (no gateway yet). Hosts never forward.                                                              |
| ICMP echo         | ✅     | Echo request/reply, TTL 64. No other ICMP messages on the wire; unreachable is reported locally like Linux.                                            |
| Interface up/down | ✅     | Carrier needs both ends cabled and up; `NO-CARRIER` shown otherwise.                                                                                   |

## Shell (Linux-style)

| Command                                     | Status | Notes                                                     |
| ------------------------------------------- | ------ | --------------------------------------------------------- |
| `ip addr [show\|add\|del\|flush]`           | ✅     | iproute2 output and error messages; prefixes like `ip a`. |
| `ip link [show]`, `ip link set IF up\|down` | ✅     |                                                           |
| `ip neigh [show\|flush]`                    | ✅     |                                                           |
| `ip route [show]`                           | 🟡     | Shows connected routes; `ip route add` comes in Phase 2.  |
| `ping [-c N] ADDR`                          | ✅     | Default 4 packets (Linux pings forever). Ctrl+C stops.    |
| `bridge fdb [show]`                         | ✅     | Switches only.                                            |
| `hostname [NAME]`, `help`, `clear`          | ✅     |                                                           |
| Tab completion                              | ❌     |                                                           |

## App

| Feature                          | Status | Notes                                                                                                                                           |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas: add, move, delete, cable | ✅     | Drag or click to add. Drag from a port to a port; drop on a device body to use its only fitting port or choose from a menu. Delete key removes. |
| Device faceplates                | ✅     | Visible sockets with link LEDs (green up, amber no carrier, grey no cable) that blink on traffic.                                               |
| Device inspector                 | ✅     | Rename, all ports with peers, MACs, addresses, ARP and MAC tables; cable a free port from a list.                                               |
| Terminal per device              | ✅     | History with Up/Down, Ctrl+C.                                                                                                                   |
| Realtime mode                    | ✅     | Virtual time follows the wall clock.                                                                                                            |
| Simulation mode                  | ✅     | Step/Play frame by frame, event list, layer-by-layer frame details, animation.                                                                  |
| Guided tasks                     | ✅     | "Two computers, one cable", "Meet the switch".                                                                                                  |
| Autosave (IndexedDB)             | ✅     | Saves 500 ms after changes. Running pings and ARP tables are not saved.                                                                         |
| Export / import lab file         | ✅     | Versioned JSON (`netforge-lab`, version 2), validated on import; version 1 files are upgraded.                                                  |
| Share by link, undo/redo         | ❌     | Phase 2                                                                                                                                         |
| Light theme                      | ❌     | Tokens exist, no toggle yet.                                                                                                                    |
