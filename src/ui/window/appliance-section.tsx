import type { Device } from '../../engine/device.ts';
import { formatIp } from '../../engine/addr.ts';
import { CAMERA_PORT, PRINTER_PORT, STREAM_PORT } from '../../engine/appliances.ts';
import { SECONDARY } from '../styles.ts';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

/** What a printer or an IP camera does, and how to try it from another device. */
export function ApplianceSection({ device }: { device: Device }) {
  useLab();
  const addr = device.ip?.allAddrs()[0];
  const host = addr ? formatIp(addr.ip) : 'ADDRESS';
  const { printer, camera } = device;
  if (printer) {
    return (
      <Section title="Printing">
        <p className="flex items-center gap-3 text-xs">
          <span>
            Pages printed: <span className="font-mono">{printer.pages}</span>
          </span>
          <button type="button" onClick={() => printer.reset()} className={SECONDARY}>
            Reset counter
          </button>
        </p>
        <p className="text-xs text-(--nf-muted)">
          Print from a PC&apos;s terminal:{' '}
          <code className="font-mono">
            nc {host} {PRINTER_PORT} &lt; FILE
          </code>
          . Every connection that sends data is one print job. The status page is at{' '}
          <code className="font-mono">http://{host}/</code>.
        </p>
      </Section>
    );
  }
  if (camera) {
    return (
      <Section title="Streaming">
        <p className="text-xs">
          Viewers connected: <span className="font-mono">{camera.viewers}</span>
        </p>
        <p className="text-xs text-(--nf-muted)">
          Watch from a PC&apos;s terminal:{' '}
          <code className="font-mono">
            nc {host} {CAMERA_PORT}
          </code>{' '}
          (Ctrl+C stops). While someone watches, the camera sends one UDP packet per second to port{' '}
          {STREAM_PORT} of the viewer; a firewall rule can block it. The live view page is at{' '}
          <code className="font-mono">http://{host}/</code>.
        </p>
      </Section>
    );
  }
  return null;
}
