# Features

What the simulator supports today. Update this file in the same pull request as the
feature. If behavior is simplified compared to real networks, say how.

Legend: ✅ supported · 🟡 partial · ❌ not yet

## Devices

| Device | Status | Notes                                                                                |
| ------ | ------ | ------------------------------------------------------------------------------------ |
| PC     | ✅     | One Ethernet port (`eth0`). No loopback interface.                                   |
| Switch | ✅     | 8 ports (`eth0`–`eth7`), unmanaged learning bridge. No IP address, no VLANs, no STP. |
| Router | ❌     | Phase 2                                                                              |

## Network behavior

| Feature           | Status | Notes                                                                                                       |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Cables            | ✅     | Auto-picks the first free port. 0.25 ms per hop. No cable types, speed or duplex.                           |
| Switching loops   | 🟡     | Refused when cabling, since there is no STP yet.                                                            |
| MAC learning      | ✅     | 300 s ageing like the Linux bridge; entries on a port are flushed when it loses carrier.                    |
| ARP               | ✅     | 3 probes, 1 s apart, then `FAILED`. Entries stay `REACHABLE` forever (no `STALE`/aging).                    |
| IPv4              | 🟡     | Multiple addresses per port, connected routes only (no gateway yet). Hosts never forward.                   |
| ICMP echo         | ✅     | Echo request/reply, TTL 64. No other ICMP messages on the wire; unreachable is reported locally like Linux. |
| Interface up/down | ✅     | Carrier needs both ends cabled and up; `NO-CARRIER` shown otherwise.                                        |

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

| Feature                          | Status | Notes                                                                          |
| -------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Canvas: add, move, delete, cable | ✅     | Drag or click to add; drag from a device's dot to cable; Delete key removes.   |
| Device inspector                 | ✅     | Rename, ports, MACs, addresses, ARP and MAC tables.                            |
| Terminal per device              | ✅     | History with Up/Down, Ctrl+C.                                                  |
| Realtime mode                    | ✅     | Virtual time follows the wall clock.                                           |
| Simulation mode                  | ✅     | Step/Play frame by frame, event list, layer-by-layer frame details, animation. |
| Guided tasks                     | ✅     | "Two computers, one cable", "Meet the switch".                                 |
| Autosave (IndexedDB)             | ✅     | Saves 500 ms after changes. Running pings and ARP tables are not saved.        |
| Export / import lab file         | ✅     | Versioned JSON (`netforge-lab`, version 1), validated on import.               |
| Share by link, undo/redo         | ❌     | Phase 2                                                                        |
| Light theme                      | ❌     | Tokens exist, no toggle yet.                                                   |
