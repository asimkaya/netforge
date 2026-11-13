# Roadmap

Each phase ends with a usable, deployed product.

| Phase                                 | Scope                                                                                                                                                                                                                                   | Status  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **0: Foundation**                     | Repo, Vite + React + TS, lint/format/test, commit rules, CI, docs, empty canvas, engine scheduler                                                                                                                                       | ✅ Done |
| **1: MVP, "two hosts can ping"**      | Canvas editing (add, move, delete, connect), host + switch, Ethernet, MAC learning, ARP, IPv4, ICMP, host shell (`ip addr`, `ip link`, `ping`, `ip neigh`), simulation mode v1, IndexedDB save + JSON export/import, first guided tasks | ✅ Done |
| **1.5a: Device model**                | `DeviceSpec`, typed ports and cables, engine split into `Bridge`/`IpStack` modules, SVG faceplates with port LEDs, port-to-port cabling and port menu, lab file v2 with migration                                                       | ✅ Done |
| **1.5b: Device windows**              | Single click opens a movable window (several at once); Physical / Config / Desktop tabs; Terminal and IP Configuration apps; right-click menu                                                                                           | ✅ Done |
| **2: Routing basics**                 | Router (Linux-based), `ip route`, default gateway, `traceroute`, UDP, DHCP, DNS (`dig`), undo/redo, share-by-link                                                                                                                       | ✅ Done |
| **3: Services and apps**              | Lightweight TCP and socket API, virtual filesystem, Server device, HTTP + Web Browser, Text Editor, Mail (SMTP/POP3), Internet cloud, Packet Capture app                                                                                | ✅ Done |
| **4: Wireless**                       | Access point, home router, laptop, phone; SSID, WPA2, range on the canvas                                                                                                                                                               | ⏳ Next |
| **5: Managed switching and security** | VLANs, trunks, inter-VLAN routing, STP, link aggregation; NAT and firewall (`nft` + GUI); dynamic routing (OSPF, FRR-style); IPv6                                                                                                       |         |
| **6: Beyond**                         | WireGuard VPN, SSH, Bluetooth/IoT, real Linux node via v86 (WASM), pcap export, task editor, multiplayer over WebRTC                                                                                                                    |         |

## Guided task curriculum (draft)

Audience: beginners who know what a computer and a cable are.

1. Two hosts, one cable: assign IPs, ping.
2. A switch and four hosts: how does the MAC table fill?
3. A router between two subnets: default gateways.
4. Hand out addresses with DHCP.
5. Split a switch with VLANs.
6. Route between VLANs.
7. Static routes, then OSPF.
8. Reach the "internet" through NAT.
9. Block traffic with a firewall.
10. Site-to-site VPN with WireGuard.
11. Troubleshooting: here is a broken network, find the fault.
