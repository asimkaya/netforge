import { useState, type FormEvent } from 'react';
import { formatCidr, formatIp, networkOf, parseCidr, parseIp } from '../../engine/addr.ts';
import type { Device } from '../../engine/device.ts';
import { genKey, isKey, WG_PORT } from '../../engine/wireguard.ts';
import { FIELD, PRIMARY, SECONDARY } from '../apps/IpConfig.tsx';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

const NAME = 'wg0';

/** WireGuard: create wg0 with a fresh key, show its public key, add peers. */
export function WireguardSection({ device }: { device: Device }) {
  const { net } = useLab();
  const [address, setAddress] = useState('10.8.0.1/24');
  const [peerKey, setPeerKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [allowed, setAllowed] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ip = device.ip;
  if (!ip || !ip.forwarding || device.spec.id === 'internet') return null;
  const port = device.port(NAME);
  const wg = device.wireguard(port);

  const create = (e: FormEvent) => {
    e.preventDefault();
    const cidr = parseCidr(address);
    if (!cidr) {
      setError('Give the tunnel an address, e.g. 10.8.0.1/24.');
      return;
    }
    const failed = device.addWireguard(NAME);
    const created = device.port(NAME);
    const tunnel = device.wireguard(created);
    if (failed || !created || !tunnel) {
      setError(failed);
      return;
    }
    tunnel.setListenPort(WG_PORT);
    tunnel.setPrivateKey(genKey(`${device.id}:${net.scheduler.now}:ui`));
    ip.addAddress(created, cidr);
    net.setPortUp(created, true);
    setError(null);
  };

  const addPeer = (e: FormEvent) => {
    e.preventDefault();
    if (!wg || !port) return;
    const [host, portText] = endpoint.split(':');
    const endIp = host ? parseIp(host) : null;
    const nets = allowed.split(',').map((x) => parseCidr(x.trim()));
    if (!isKey(peerKey.trim()))
      return setError('The peer key must be its public key (44 characters).');
    if (endpoint && (endIp === null || !Number(portText)))
      return setError('Endpoint: IP:PORT, e.g. 198.51.100.100:51820.');
    if (nets.some((n) => n === null) || nets.length === 0)
      return setError('Allowed IPs: networks, e.g. 10.8.0.2/32, 192.168.2.0/24.');
    const peer = wg.peer(peerKey.trim());
    if (endIp !== null) peer.endpoint = { ip: endIp, port: Number(portText) };
    peer.allowedIps = nets.flatMap((n) => (n ? [{ ip: networkOf(n), prefix: n.prefix }] : []));
    // Like wg-quick: route the allowed networks into the tunnel.
    for (const n of peer.allowedIps) {
      if (ip.routeTo(n.ip)?.port !== port) ip.addRoute(n, null, port);
    }
    net.changed();
    setPeerKey('');
    setEndpoint('');
    setAllowed('');
    setError(null);
  };

  return (
    <Section title="WireGuard VPN">
      {!wg || !port ? (
        <form onSubmit={create} className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1">
            Tunnel address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className={`${FIELD} w-36`}
            />
          </label>
          <button type="submit" className={PRIMARY}>
            Create wg0
          </button>
          <p className="w-full text-(--nf-muted)">
            Creates a key pair and the tunnel interface. Then exchange public keys with the other
            side and add each other as peers.
          </p>
        </form>
      ) : (
        <div className="space-y-2 text-xs">
          <p>
            <span className="text-(--nf-muted)">Public key (give it to the other side): </span>
            <code className="break-all select-all" aria-label="WireGuard public key">
              {wg.publicKey}
            </code>
          </p>
          <p className="text-(--nf-muted)">
            {NAME} {ip.addrsOn(port).map(formatCidr).join(', ')}
            <span className="ml-3">listening on UDP {wg.listenPort}</span>
          </p>
          {wg.peers.length > 0 && (
            <ul aria-label="WireGuard peers" className="space-y-1">
              {wg.peers.map((p) => (
                <li key={p.publicKey} className="rounded border border-(--nf-border) p-2">
                  <code className="break-all">{p.publicKey}</code>
                  <div className="text-(--nf-muted)">
                    {p.endpoint ? `${formatIp(p.endpoint.ip)}:${p.endpoint.port}` : 'no endpoint'}
                    <span className="ml-3">allowed {p.allowedIps.map(formatCidr).join(', ')}</span>
                    <span className="ml-3">
                      {p.lastHandshake === null ? 'no handshake yet' : 'handshake done'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={SECONDARY}
                    onClick={() => wg.removePeer(p.publicKey)}
                  >
                    Remove peer
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addPeer} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              Peer public key
              <input
                value={peerKey}
                onChange={(e) => setPeerKey(e.target.value)}
                className={`${FIELD} w-80`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Endpoint
              <input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="198.51.100.100:51820"
                className={`${FIELD} w-44`}
              />
            </label>
            <label className="flex flex-col gap-1">
              Allowed IPs
              <input
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
                placeholder="10.8.0.2/32, 192.168.2.0/24"
                className={`${FIELD} w-56`}
              />
            </label>
            <button type="submit" className={PRIMARY}>
              Add peer
            </button>
          </form>
          <p className="text-(--nf-muted)">
            In the CLI: <code>wg show</code>, <code>wg-quick up wg0</code> with{' '}
            <code>/etc/wireguard/wg0.conf</code>.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-(--nf-bad)">
          {error}
        </p>
      )}
    </Section>
  );
}
