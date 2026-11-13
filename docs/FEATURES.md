# Features

What the simulator supports today. Update this file in the same pull request as the
feature. If behavior is simplified compared to real networks, say how.

Legend: ✅ supported · 🟡 partial · ❌ not yet

## Devices

| Device   | Status | Notes                                                                                                                                                                               |
| -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC       | ✅     | One Ethernet port (`eth0`). No loopback interface. Can forward packets if `ip_forward` is turned on.                                                                                |
| Switch   | ✅     | 8 Ethernet ports (`eth0`–`eth7`) and 2 SFP fiber uplinks (`eth8`, `eth9`); unmanaged learning bridge. No IP address, no VLANs, no STP.                                              |
| Server   | ✅     | One Ethernet port, desktop apps, a sample site in `/var/www/html`; runs httpd, postfix, dovecot, dnsmasq.                                                                           |
| Internet | ✅     | Four provider networks (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `100.64.0.0/24`) with DHCP and DNS; hosts `www.example.com` at `198.18.0.10`. No real Internet access. |
| Router   | ✅     | Linux router with 4 Ethernet ports (`eth0`–`eth3`), `ip_forward` on. CLI tab instead of a desktop.                                                                                  |

## Network behavior

| Feature           | Status | Notes                                                                                                                                                                                                                                                                                           |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cables            | ✅     | Port to port. Copper joins Ethernet ports, fiber joins SFP ports; no straight/crossover distinction (auto-MDI-X). 0.25 ms per hop. No speed or duplex.                                                                                                                                          |
| Switching loops   | 🟡     | A cable that joins two ports of the same L2 broadcast domain is refused, since there is no STP yet. Loops between routers are allowed; TTL ends them.                                                                                                                                           |
| MAC learning      | ✅     | 300 s ageing like the Linux bridge; entries on a port are flushed when it loses carrier.                                                                                                                                                                                                        |
| ARP               | ✅     | 3 probes, 1 s apart, then `FAILED`. Entries stay `REACHABLE` forever (no `STALE`/aging).                                                                                                                                                                                                        |
| IPv4 routing      | ✅     | Connected and static routes, longest prefix match, default gateway. Routers look the route up, then check and decrement TTL, like Linux. No policy routing, no metrics.                                                                                                                         |
| ICMP              | ✅     | Echo, time exceeded, destination unreachable (net, host after failed ARP, port). Errors about the sender's own packets are reported locally, like Linux. Broadcast pings are ignored.                                                                                                           |
| TCP               | 🟡     | Three-way handshake, data with seq/ack, FIN close, RST for closed ports, SYN retried 3 times (1, 2, 4 s). One segment per application message; no data retransmission, windowing or congestion control.                                                                                         |
| HTTP              | ✅     | HTTP/1.1 GET/HEAD, `Connection: close`; 200, 400, 404, 501.                                                                                                                                                                                                                                     |
| Email             | 🟡     | SMTP delivery to local mailboxes (`/var/mail/USER`, mbox) and POP3 retrieval; dot-stuffing. No relaying between servers, no MX records, any POP3 password accepted.                                                                                                                             |
| Files             | ✅     | Per-device files (64 KB per file, 512 KB in all), saved with the lab.                                                                                                                                                                                                                           |
| UDP               | ✅     | Sockets with ephemeral ports from 32768; closed ports answer with port unreachable.                                                                                                                                                                                                             |
| DHCP              | ✅     | dnsmasq server and dhclient: Discover/Offer/Request/Ack, Nak, Release. The server answers on the interface whose subnet contains the range, and gives itself as gateway and DNS server unless options say otherwise. No relays; leases are not renewed or saved, and no address conflict check. |
| DNS               | ✅     | dnsmasq answers its host records and its DHCP clients' hostnames; A records only, no upstream servers, no caching, no `/etc/hosts`.                                                                                                                                                             |
| Interface up/down | ✅     | Carrier needs both ends cabled and up; `NO-CARRIER` and `linkdown` shown otherwise.                                                                                                                                                                                                             |

## Shell (Linux-style)

| Command                                     | Status | Notes                                                                                                                                         |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ip addr [show\|add\|del\|flush]`           | ✅     | iproute2 output and error messages; prefixes like `ip a`.                                                                                     |
| `ip link [show]`, `ip link set IF up\|down` | ✅     |                                                                                                                                               |
| `ip neigh [show\|flush]`                    | ✅     |                                                                                                                                               |
| `ip route [show\|add\|del\|get]`            | ✅     | `add DST [via GW] [dev IF]`, `DST` is `ADDR/LEN` or `default`. No `replace`, `metric`, `table`.                                               |
| `sysctl [-w] net.ipv4.ip_forward[=0\|1]`    | ✅     | The only sysctl key.                                                                                                                          |
| `ping [-c N] [-t TTL] HOST`                 | ✅     | Default 4 packets (Linux pings forever). Names are resolved with DNS. Ctrl+C stops.                                                           |
| `traceroute [-m MAX] HOST`                  | ✅     | UDP probes from port 33434, 3 per hop, 5 s wait; `*`, `!N`, `!H`.                                                                             |
| `dnsmasq [OPTIONS]`, `killall dnsmasq`      | ✅     | `--dhcp-range`, `--dhcp-option=option:router\|dns-server,IP` (or 3/6), `--address=/NAME/IP`, `--host-record=NAME,IP`. Runs in the background. |
| `dhclient [-r] IF`                          | ✅     | Prints the `-v` messages; 4 Discover attempts, 3 s apart.                                                                                     |
| `dig [@SERVER] [+short] NAME`               | ✅     | A records, dig-style output, NXDOMAIN, timeouts, connection refused.                                                                          |
| `resolvectl [status\|dns\|revert\|query]`   | ✅     | One global list of DNS servers.                                                                                                               |
| `bridge fdb [show]`                         | ✅     | Switches only.                                                                                                                                |
| `hostname [NAME]`, `help`, `clear`          | ✅     |                                                                                                                                               |
| Tab completion                              | ❌     |                                                                                                                                               |

## App

| Feature                                    | Status | Notes                                                                                                                                                                                                  |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canvas: add, move, delete, cable           | ✅     | Drag or click to add (new devices go to a free spot: gear above, PCs below). Drag from a port to a port; drop on a device body to use its only fitting port or choose from a menu. Delete key removes. |
| Device faceplates                          | ✅     | Visible sockets with link LEDs (green up, amber no carrier, grey no cable) that blink on traffic.                                                                                                      |
| Device windows                             | ✅     | A click (or Enter, or the right-click menu) opens a window beside the device. Several at once; move, resize, minimize, close. Full screen on narrow screens.                                           |
| Physical tab                               | ✅     | Ports with type, MAC and cable; Unplug or Connect to from a list; switch MAC table.                                                                                                                    |
| Config tab                                 | ✅     | Hostname; interfaces on/off; router addresses; `ip_forward`, routing table and Add route; dnsmasq form with live leases. Each form shows the matching command.                                         |
| Desktop tab (PCs), CLI (switches, routers) | ✅     | Apps: Terminal and IP Configuration. More apps come with the protocols behind them (ADR 0006).                                                                                                         |
| IP Configuration app                       | ✅     | DHCP button with its log and Release; addresses with prefix and mask; default gateway and DNS servers; ARP table.                                                                                      |
| Terminal app                               | ✅     | One session per device, history with Up/Down, Ctrl+C.                                                                                                                                                  |
| Realtime mode                              | ✅     | Virtual time follows the wall clock.                                                                                                                                                                   |
| Simulation mode                            | ✅     | Step/Play frame by frame, event list, layer-by-layer frame details (Ethernet, ARP, IPv4, ICMP, UDP, DHCP, DNS), animation.                                                                             |
| Guided tasks                               | ✅     | "Two computers, one cable", "Meet the switch", "Two networks, one router", "Automatic addresses with DHCP".                                                                                            |
| Autosave (IndexedDB)                       | ✅     | Saves 500 ms after changes. Running commands, ARP tables, MAC tables and DHCP leases are not saved; running dnsmasq is.                                                                                |
| Export / import lab file                   | ✅     | Versioned JSON (`netforge-lab`, version 4), validated on import; older versions are upgraded.                                                                                                          |
| Undo / redo                                | ✅     | Ctrl+Z, Ctrl+Y and buttons. Changes within 0.4 s are one step. Covers devices, cables, settings and layout, not task progress; undoing rebuilds the network, so ARP/MAC tables and leases start empty. |
| Share by link                              | ✅     | `#lab=` URL with the lab compressed in the browser; validated like an import, 2 MB limit, asks before replacing a lab. Long labs make long links.                                                      |
| Light theme                                | ❌     | Tokens exist, no toggle yet.                                                                                                                                                                           |
