import { useState } from 'react';
import type { Device } from '../../engine/device.ts';
import { associatedAp, connectWifi, disconnectWifi, scan } from '../../engine/wifi.ts';
import { getLab, useLab } from '../lab.ts';
import { FIELD, PRIMARY, SECONDARY } from './IpConfig.tsx';

/** Lists Wi-Fi networks in range and joins or leaves them, like a desktop Wi-Fi menu. */
export function Wifi({ device }: { device: Device }) {
  const { net } = useLab();
  const [chosen, setChosen] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const current = associatedAp(device);
  const networks = scan(net, device);

  const join = (ssid: string, secured: boolean) => {
    const error = connectWifi(getLab().net, device, ssid, secured ? password : null);
    setMessage(
      error ??
        `Connected to ${ssid}. Next, get an address: IP Configuration → Get an address automatically.`,
    );
    if (!error) {
      setChosen(null);
      setPassword('');
    }
  };

  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        {current?.hostapd ? (
          <>
            <span>
              Connected to <strong>{current.hostapd.ssid}</strong> via {current.name}.
            </span>
            <button
              type="button"
              onClick={() => {
                disconnectWifi(net, device);
                setMessage('Disconnected.');
              }}
              className={SECONDARY}
            >
              Disconnect
            </button>
          </>
        ) : (
          <span>Not connected.</span>
        )}
      </div>
      <h3 className="text-[10px] font-semibold tracking-wider text-(--nf-muted) uppercase">
        Networks in range
      </h3>
      {networks.length === 0 && (
        <p className="text-(--nf-muted)">
          No networks. Move closer to an access point (inside its dashed circle).
        </p>
      )}
      <ul className="space-y-1" aria-label="Wi-Fi networks">
        {networks.map((n) => (
          <li key={n.ap.id} className="rounded border border-(--nf-border) p-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{n.ssid}</span>
              <span className="text-(--nf-muted)">
                {n.signal}% · {n.secured ? 'WPA2' : 'open'} · {n.ap.name}
              </span>
              {current !== n.ap && (
                <button
                  type="button"
                  onClick={() => (n.secured ? setChosen(n.ap.id) : join(n.ssid, false))}
                  className={`${PRIMARY} ml-auto`}
                >
                  Connect
                </button>
              )}
            </div>
            {chosen === n.ap.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  join(n.ssid, true);
                }}
                className="mt-2 flex gap-2"
              >
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-label="Wi-Fi password"
                  className={FIELD}
                />
                <button type="submit" className={PRIMARY}>
                  Join
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {message && (
        <p role="status" className="text-(--nf-muted)">
          {message}
        </p>
      )}
      <p className="text-(--nf-muted)">
        Same as <code>nmcli dev wifi list</code> and{' '}
        <code>nmcli dev wifi connect SSID password PASS</code>.
      </p>
    </div>
  );
}
