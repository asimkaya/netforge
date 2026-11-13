import { inSubnet, type Cidr, type Ip } from './addr.ts';
import type { Fabric } from './device.ts';
import type { IpStack, UdpSocket } from './ip.ts';
import type { Ipv4Packet, UdpDatagram, WireguardMessage } from './packet.ts';
import type { Port } from './port.ts';

/**
 * WireGuard: a layer 3 tunnel. Packets routed to `wg0` go to the peer whose allowed IPs
 * contain their destination, sealed inside UDP to the peer's endpoint; what arrives is
 * accepted only from addresses the sending peer is allowed to use (cryptokey routing).
 * Simplified: keys are deterministic stand-ins for Curve25519, the handshake is one
 * round trip with no cookies or rekeying, and keepalives are not sent. See docs.
 */

export const WG_PORT = 51820;

export interface WgPeer {
  publicKey: string;
  endpoint: { ip: Ip; port: number } | null;
  allowedIps: Cidr[];
  keepalive: number | null;
  /** When the last handshake completed (virtual ms), or null. */
  lastHandshake: number | null;
  rxBytes: number;
  txBytes: number;
  /** Packets waiting for the handshake to finish. */
  queue: Ipv4Packet[];
  initiated: boolean;
}

// ----------------------------------------------------------------- keys

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] ?? '';
    out += B64[(n >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '=';
    out += i + 2 < bytes.length ? (B64[n & 63] ?? '') : '=';
  }
  return out;
}

/** 32 pseudo-random bytes from a seed text (FNV-1a, then xorshift). Deterministic. */
function bytesFrom(seed: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  let x = h || 1;
  return Array.from({ length: 32 }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x & 0xff;
  });
}

export function isKey(text: string): boolean {
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(text);
}

/** A private key, like `wg genkey`, from a seed that makes it unique in the lab. */
export function genKey(seed: string): string {
  const bytes = bytesFrom(seed);
  // Curve25519 private keys are clamped; keep the same bit pattern.
  bytes[0] = (bytes[0] ?? 0) & 248;
  bytes[31] = ((bytes[31] ?? 0) & 127) | 64;
  return base64(bytes);
}

/** The public key for a private key (a stand-in for Curve25519 scalar multiplication). */
export function publicKey(privateKey: string): string {
  return base64(bytesFrom(`public:${privateKey}`));
}

// --------------------------------------------------------------- tunnel

export class WireGuard {
  privateKey: string | null = null;
  listenPort: number | null = null;
  readonly peers: WgPeer[] = [];
  #socket: UdpSocket | null = null;

  constructor(
    readonly fabric: Fabric,
    readonly stack: IpStack,
    /** The `wg0` interface itself. */
    public port: Port | null = null,
  ) {}

  get publicKey(): string | null {
    return this.privateKey ? publicKey(this.privateKey) : null;
  }

  /** Opens the UDP socket (on the listen port, or a free one) once there is a key. */
  #bind(): void {
    if (this.#socket || !this.privateKey) return;
    const socket = this.stack.openUdp(
      (d, from) => this.#receive(d, from),
      undefined,
      this.listenPort ?? undefined,
    );
    if (typeof socket === 'string') return;
    this.#socket = socket;
    this.listenPort = socket.port;
  }

  setPrivateKey(key: string): void {
    this.privateKey = key;
    this.#bind();
    this.fabric.changed();
  }

  /** Returns an error in `wg` wording, or null. */
  setListenPort(port: number): string | null {
    if (this.listenPort === port) return null;
    this.#socket?.close();
    this.#socket = null;
    this.listenPort = port;
    this.#bind();
    if (this.privateKey && !this.#socket) return 'Unable to modify interface: Address in use';
    this.fabric.changed();
    return null;
  }

  peer(key: string): WgPeer {
    let p = this.peers.find((x) => x.publicKey === key);
    if (!p) {
      p = {
        publicKey: key,
        endpoint: null,
        allowedIps: [],
        keepalive: null,
        lastHandshake: null,
        rxBytes: 0,
        txBytes: 0,
        queue: [],
        initiated: false,
      };
      this.peers.push(p);
    }
    return p;
  }

  removePeer(key: string): void {
    const i = this.peers.findIndex((p) => p.publicKey === key);
    if (i >= 0) this.peers.splice(i, 1);
    this.fabric.changed();
  }

  stop(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  /** The peer whose allowed IPs contain `dst` (longest prefix wins). */
  route(dst: Ip): WgPeer | null {
    let best: { peer: WgPeer; prefix: number } | null = null;
    for (const peer of this.peers) {
      for (const net of peer.allowedIps) {
        if (inSubnet(dst, net) && (!best || net.prefix > best.prefix))
          best = { peer, prefix: net.prefix };
      }
    }
    return best?.peer ?? null;
  }

  /** Why a packet to `dst` cannot be sent, as the socket would report it; null if it can. */
  check(dst: Ip): string | null {
    const peer = this.route(dst);
    if (!this.privateKey || !peer) return 'Required key not available';
    if (!peer.endpoint) return 'Destination address required';
    return null;
  }

  /** Seals a packet for its peer, after a handshake if there is no session yet. */
  send(packet: Ipv4Packet): void {
    const peer = this.route(packet.dst);
    if (!peer?.endpoint || !this.privateKey || !this.#socket) return;
    if (peer.lastHandshake === null) {
      peer.queue.push(packet);
      if (!peer.initiated) {
        peer.initiated = true;
        this.#message(peer, { type: 'initiation' });
      }
      return;
    }
    this.#data(peer, packet);
  }

  #data(peer: WgPeer, inner: Ipv4Packet): void {
    peer.txBytes += 32 + innerLength(inner);
    this.#message(peer, { type: 'data', inner });
    this.fabric.changed();
  }

  #message(
    peer: WgPeer,
    body: { type: 'initiation' | 'response' } | { type: 'data'; inner: Ipv4Packet },
  ) {
    const { endpoint } = peer;
    if (!endpoint || !this.#socket || !this.publicKey) return;
    const msg: WireguardMessage = {
      app: 'wireguard',
      sender: this.publicKey,
      receiver: peer.publicKey,
      ...body,
    };
    this.#socket.send(endpoint.ip, endpoint.port, msg);
  }

  #receive(d: UdpDatagram, from: Ip): void {
    const m = d.data;
    if (m.app !== 'wireguard' || m.receiver !== this.publicKey) return;
    // Only configured peers are answered: everything else is silently dropped.
    const peer = this.peers.find((p) => p.publicKey === m.sender);
    if (!peer) return;
    const now = this.fabric.scheduler.now;
    if (m.type === 'initiation') {
      peer.endpoint = { ip: from, port: d.srcPort };
      peer.lastHandshake = now;
      this.#message(peer, { type: 'response' });
      this.fabric.changed();
      return;
    }
    if (m.type === 'response') {
      peer.lastHandshake = now;
      peer.initiated = false;
      const queued = peer.queue.splice(0);
      for (const packet of queued) this.#data(peer, packet);
      this.fabric.changed();
      return;
    }
    const inner = m.inner;
    if (!inner || peer.lastHandshake === null || !this.port) return;
    // Cryptokey routing: the peer may only send from its allowed IPs.
    if (!peer.allowedIps.some((net) => inSubnet(inner.src, net))) return;
    peer.endpoint = { ip: from, port: d.srcPort };
    peer.rxBytes += 32 + innerLength(inner);
    this.fabric.changed();
    this.stack.receiveTunneled(this.port, inner);
  }
}

function innerLength(p: Ipv4Packet): number {
  const l4 = p.payload;
  if (l4.kind === 'icmp') return 84;
  if (l4.kind === 'tcp') return 40 + (l4.data?.length ?? 0);
  return 60;
}
