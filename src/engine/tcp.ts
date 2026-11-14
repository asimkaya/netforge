import type { Ip } from './addr.ts';
import type { Fabric } from './device.ts';
import type { DropWhy } from './drops.ts';
import type { Ipv4Packet, TcpFlag, TcpSegment, UnreachableCode } from './packet.ts';

/** Linux retries a SYN with doubling waits; three tries here, 1 s then 2 s then 4 s. */
const SYN_TRIES = 3;
const SYN_FIRST_WAIT_MS = 1000;

export type TcpError = 'refused' | 'timeout' | 'unreachable';

/** Linux wording for each error, as `connect()` would report it. */
export const TCP_ERROR_TEXT: Record<TcpError, string> = {
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  unreachable: 'No route to host',
};

export interface TcpHandlers {
  /** The connection is established (client side). */
  onOpen?(conn: TcpConnection): void;
  onData(text: string, conn: TcpConnection): void;
  /** The other side closed (or we did and the close finished). */
  onClose?(conn: TcpConnection): void;
  onError?(error: TcpError, conn: TcpConnection): void;
}

type State = 'syn-sent' | 'established' | 'closing' | 'closed';

export interface TcpConnection {
  readonly localIp: Ip;
  readonly localPort: number;
  readonly remoteIp: Ip;
  readonly remotePort: number;
  readonly state: State;
  /** Sends one application message as one segment. */
  send(text: string): void;
  /** Starts a graceful close (FIN). */
  close(): void;
}

/** What the TCP layer needs from the IP stack below it. */
export interface TcpHost {
  readonly fabric: Fabric;
  ownsIp(ip: Ip): boolean;
  /** Source address the stack would use toward `dst`, or null without a route. */
  sourceFor(dst: Ip): Ip | null;
  sendPacket(dst: Ip, payload: TcpSegment, src: Ip): string | null;
  /** Records a discarded packet (see drops.ts). */
  noteDrop(why: DropWhy, packet: Ipv4Packet): void;
}

class Connection implements TcpConnection {
  state: State;
  /** Next sequence number we send, and the next one we expect. */
  sndNext: number;
  rcvNext = 0;
  timer: number | null = null;
  tries = 0;

  constructor(
    readonly layer: TcpLayer,
    readonly localIp: Ip,
    readonly localPort: number,
    readonly remoteIp: Ip,
    readonly remotePort: number,
    public handlers: TcpHandlers,
    isn: number,
    state: State,
  ) {
    this.sndNext = isn;
    this.state = state;
  }

  segment(flags: TcpFlag[], data?: string): void {
    const seg: TcpSegment = {
      kind: 'tcp',
      srcPort: this.localPort,
      dstPort: this.remotePort,
      flags,
      seq: this.sndNext,
      ack: flags.includes('ACK') ? this.rcvNext : 0,
      ...(data === undefined ? {} : { data }),
    };
    this.layer.host.sendPacket(this.remoteIp, seg, this.localIp);
    this.sndNext += (data?.length ?? 0) + (flags.includes('SYN') || flags.includes('FIN') ? 1 : 0);
  }

  send(text: string): void {
    if (this.state !== 'established') return;
    // shortcut: no retransmission or windowing for data; links here don't lose packets once
    // a connection is up. Add them if lossy links are ever simulated.
    this.segment(['PSH', 'ACK'], text);
  }

  close(): void {
    if (this.state === 'established') {
      this.state = 'closing';
      this.segment(['FIN', 'ACK']);
    } else if (this.state === 'syn-sent') {
      this.finish();
    }
  }

  stopTimer(): void {
    if (this.timer !== null) this.layer.host.fabric.scheduler.cancel(this.timer);
    this.timer = null;
  }

  finish(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.stopTimer();
    this.layer.forget(this);
  }

  fail(error: TcpError): void {
    if (this.state === 'closed') return;
    this.finish();
    this.handlers.onError?.(error, this);
  }
}

/** A small TCP: three-way handshake, data, FIN close, RST for closed ports, SYN retries. */
export class TcpLayer {
  readonly #listeners = new Map<number, (conn: TcpConnection) => TcpHandlers>();
  readonly #conns = new Map<string, Connection>();
  /** Servers this host has opened a connection to (used by guided tasks and challenges). */
  readonly connectedTo = new Set<Ip>();
  #nextPort = 40000;
  #nextIsn = 1000;

  constructor(readonly host: TcpHost) {}

  #key(localPort: number, remoteIp: Ip, remotePort: number): string {
    return `${localPort}|${remoteIp}|${remotePort}`;
  }

  forget(conn: Connection): void {
    this.#conns.delete(this.#key(conn.localPort, conn.remoteIp, conn.remotePort));
    this.host.fabric.changed();
  }

  #isn(): number {
    const isn = this.#nextIsn;
    this.#nextIsn += 1000;
    return isn;
  }

  /** Accepts connections on `port`. Returns a stop function, or an error message. */
  listen(port: number, accept: (conn: TcpConnection) => TcpHandlers): (() => void) | string {
    if (this.#listeners.has(port)) return 'Address already in use';
    this.#listeners.set(port, accept);
    return () => {
      this.#listeners.delete(port);
    };
  }

  isListening(port: number): boolean {
    return this.#listeners.has(port);
  }

  /** Opens a connection. Returns it, or an error message when there is no route. */
  connect(dst: Ip, port: number, handlers: TcpHandlers): TcpConnection | string {
    const src = this.host.sourceFor(dst);
    if (src === null) return 'Network is unreachable';
    let local = this.#nextPort++;
    while (this.#conns.has(this.#key(local, dst, port))) local = this.#nextPort++;
    const conn = new Connection(this, src, local, dst, port, handlers, this.#isn(), 'syn-sent');
    this.#conns.set(this.#key(local, dst, port), conn);
    const trySyn = () => {
      if (conn.state !== 'syn-sent') return;
      if (conn.tries >= SYN_TRIES) {
        conn.fail('timeout');
        return;
      }
      const wait = SYN_FIRST_WAIT_MS * 2 ** conn.tries++;
      conn.sndNext = conn.sndNext - (conn.tries > 1 ? 1 : 0);
      conn.segment(['SYN']);
      conn.timer = this.host.fabric.scheduler.schedule(wait, trySyn);
    };
    trySyn();
    return conn;
  }

  /** An ICMP error about one of our segments (e.g. no route to the server). */
  icmpError(original: Ipv4Packet, code: UnreachableCode | 'ttl'): void {
    const seg = original.payload;
    if (seg.kind !== 'tcp') return;
    const conn = this.#conns.get(this.#key(seg.srcPort, original.dst, seg.dstPort));
    if (conn?.state === 'syn-sent' && code !== 'ttl') conn.fail('unreachable');
  }

  receive(packet: Ipv4Packet): void {
    const seg = packet.payload;
    if (seg.kind !== 'tcp') return;
    const conn = this.#conns.get(this.#key(seg.dstPort, packet.src, seg.srcPort));
    const has = (f: TcpFlag) => seg.flags.includes(f);
    if (!conn) {
      if (has('SYN') && !has('ACK')) this.#accept(packet, seg);
      else if (!has('RST')) this.#reset(packet, seg);
      return;
    }
    if (has('RST')) {
      conn.fail(conn.state === 'syn-sent' ? 'refused' : 'refused');
      return;
    }
    if (conn.state === 'syn-sent') {
      if (has('SYN') && has('ACK')) {
        conn.stopTimer();
        conn.rcvNext = seg.seq + 1;
        conn.state = 'established';
        this.connectedTo.add(conn.remoteIp);
        conn.segment(['ACK']);
        this.host.fabric.changed();
        conn.handlers.onOpen?.(conn);
      }
      return;
    }
    const length = seg.data?.length ?? 0;
    if (length > 0) {
      conn.rcvNext = seg.seq + length;
      conn.segment(['ACK']);
      if (seg.data !== undefined) conn.handlers.onData(seg.data, conn);
    }
    if (has('FIN')) {
      conn.rcvNext = seg.seq + length + 1;
      if (conn.state === 'closing') {
        // Our FIN was answered with theirs: acknowledge and we're done.
        conn.segment(['ACK']);
        conn.finish();
        conn.handlers.onClose?.(conn);
      } else {
        // They closed first: acknowledge and close our side in the same segment.
        conn.state = 'closing';
        conn.segment(['FIN', 'ACK']);
        conn.handlers.onClose?.(conn);
      }
    } else if (conn.state === 'closing' && has('ACK') && length === 0 && seg.ack === conn.sndNext) {
      conn.finish();
    }
  }

  #accept(packet: Ipv4Packet, seg: TcpSegment): void {
    const accept = this.#listeners.get(seg.dstPort);
    if (!accept || !this.host.ownsIp(packet.dst)) {
      if (!accept && this.host.ownsIp(packet.dst))
        this.host.noteDrop({ reason: 'no-listener' }, packet);
      this.#reset(packet, seg);
      return;
    }
    const conn = new Connection(
      this,
      packet.dst,
      seg.dstPort,
      packet.src,
      seg.srcPort,
      { onData: () => {} },
      this.#isn(),
      'established',
    );
    conn.rcvNext = seg.seq + 1;
    this.#conns.set(this.#key(seg.dstPort, packet.src, seg.srcPort), conn);
    conn.segment(['SYN', 'ACK']);
    conn.handlers = accept(conn);
    this.host.fabric.changed();
  }

  /** Answers a segment nobody wants with RST, like a closed port. */
  #reset(packet: Ipv4Packet, seg: TcpSegment): void {
    if (!this.host.ownsIp(packet.dst)) return;
    const rst: TcpSegment = {
      kind: 'tcp',
      srcPort: seg.dstPort,
      dstPort: seg.srcPort,
      flags: ['RST', 'ACK'],
      seq: 0,
      ack: seg.seq + (seg.data?.length ?? 0) + (seg.flags.includes('SYN') ? 1 : 0),
    };
    this.host.sendPacket(packet.src, rst, packet.dst);
  }

  /** Open connections, for `ss`. */
  connections(): TcpConnection[] {
    return [...this.#conns.values()];
  }

  listeningPorts(): number[] {
    return [...this.#listeners.keys()].sort((a, b) => a - b);
  }
}
