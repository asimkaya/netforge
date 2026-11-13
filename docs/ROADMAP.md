# Roadmap

Each phase ends with a usable, deployed product.

| Phase                            | Scope                                                                                                                                                                                                                                   | Status  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **0: Foundation**                | Repo, Vite + React + TS, lint/format/test, commit rules, CI, docs, empty canvas, engine scheduler                                                                                                                                       | ✅ Done |
| **1: MVP, "two hosts can ping"** | Canvas editing (add, move, delete, connect), host + switch, Ethernet, MAC learning, ARP, IPv4, ICMP, host shell (`ip addr`, `ip link`, `ping`, `ip neigh`), simulation mode v1, IndexedDB save + JSON export/import, first guided tasks | ⏳ Next |
| **2: Routing basics**            | Router (Linux-based), `ip route`, default gateway, `traceroute`, DHCP, DNS (`dig`), undo/redo, share-by-link, PWA/offline                                                                                                               |         |
| **3: Layer 2 depth**             | VLANs (`ip link ... type vlan`), trunks, bridge VLAN filtering, inter-VLAN routing, STP, link aggregation                                                                                                                               |         |
| **4: Routing & services**        | Dynamic routing (OSPF, FRR-style), NAT and firewall (`nft`), HTTP server + simple browser, IPv6                                                                                                                                         |         |
| **5: Security & VPN**            | WireGuard (`wg`), GRE, IPsec (conceptual), stateful firewall, syslog/NTP                                                                                                                                                                |         |
| **6: Beyond**                    | Real Linux node via v86 (WASM), pcap export for Wireshark, BGP, task editor, multiplayer over WebRTC, physical view                                                                                                                     |         |

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
