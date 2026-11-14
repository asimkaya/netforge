import { useMemo, useState } from 'react';
import type { Device } from '../../engine/device.ts';
import { deviceScript } from '../../engine/script.ts';
import { SECONDARY } from '../apps/IpConfig.tsx';
import { useLab } from '../lab.ts';
import { Section } from './network-sections.tsx';

/** The device's configuration as the shell commands a real Linux machine would need. */
export function LinuxCommandsSection({ device }: { device: Device }) {
  const { net } = useLab();
  const text = useMemo(
    () => deviceScript(net, device).join('\n'),
    // The network's version changes with every edit; it is the cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [net, device, net.version],
  );
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text}\n`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Section title="Linux commands">
      <p className="text-xs text-(--nf-muted)">
        What you set up here, as commands for a real Linux machine. Read-only: change the settings
        above and this view follows.
      </p>
      <pre
        tabIndex={0}
        aria-label="Linux commands"
        className="max-h-64 overflow-auto rounded bg-(--nf-term-bg) p-2 font-mono text-[12px] whitespace-pre text-(--nf-term-text)"
      >
        {text}
      </pre>
      <button type="button" onClick={() => void copy()} className={SECONDARY}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </Section>
  );
}
