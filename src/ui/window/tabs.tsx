import { useState, type ReactNode } from 'react';
import type { Device } from '../../engine/device.ts';
import { PORT_TYPE_LABEL, hasCarrier, peerOf, type Port } from '../../engine/port.ts';
import { Browser } from '../apps/Browser.tsx';
import { Capture } from '../apps/Capture.tsx';
import { DhcpBox, GatewayDns, IpConfig, PortForm } from '../apps/IpConfig.tsx';
import { Mail } from '../apps/Mail.tsx';
import { TextEditor } from '../apps/TextEditor.tsx';
import { Ipv6Box, RadvdSection } from '../apps/Ipv6Config.tsx';
import { Wifi } from '../apps/Wifi.tsx';
import {
  MailServerSection,
  RoutingSection,
  Section,
  ServicesSection,
  WebServerSection,
  WirelessSection,
} from './network-sections.tsx';
import { Terminal } from '../apps/Terminal.tsx';
import { FirewallSection } from './firewall-section.tsx';
import { OspfSection } from './ospf-section.tsx';
import { WireguardSection } from './wireguard-section.tsx';
import { LinuxCommandsSection } from './script-section.tsx';
import { ApplianceSection } from './appliance-section.tsx';
import { StpSection, SwitchVlanSection, VlanInterfacesSection } from './vlan-sections.tsx';
import { cable, hasDesktop, removeDevice, setWindowView, useLab, type AppId } from '../lab.ts';

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

function led(port: Port): { color: string; label: string } {
  if (hasCarrier(port)) return { color: 'bg-(--nf-ok)', label: 'link up' };
  if (port.link) return { color: 'bg-(--nf-warn)', label: 'no carrier' };
  return { color: 'bg-(--nf-muted)', label: 'no cable' };
}

/** Keyboard-friendly way to cable a free port: pick the other end from a list. */
function ConnectSelect({ port }: { port: Port }) {
  const { net } = useLab();
  const options = [...net.devices.values()]
    .filter((d) => d !== port.device)
    .flatMap((d) => net.freePortsFor(d, port));
  if (options.length === 0) return null;
  return (
    <select
      aria-label={`Connect ${port.name} to`}
      value=""
      onChange={(e) => {
        const [device, name] = e.target.value.split('/');
        const target = device && name ? net.devices.get(device)?.port(name) : undefined;
        if (target) cable(port, target);
      }}
      className="rounded border border-(--nf-border) bg-(--nf-surface) px-1 py-0.5 text-xs"
    >
      <option value="">Connect to…</option>
      {options.map((p) => (
        <option key={`${p.device.id}/${p.name}`} value={`${p.device.id}/${p.name}`}>
          {p.device.name} {p.name}
        </option>
      ))}
    </select>
  );
}

/** Hardware: ports, cables and what the switch has learned. */
export function PhysicalTab({ device }: { device: Device }) {
  const { net } = useLab();
  const fdb = device.bridge?.fdb() ?? [];
  return (
    <div className="space-y-4 p-4 text-sm">
      <Section title="Ports">
        <table className="w-full text-left text-xs">
          <thead className="text-(--nf-muted)">
            <tr>
              <th className="py-1 font-medium">Port</th>
              <th className="py-1 font-medium">Type</th>
              <th className="py-1 font-medium">MAC address</th>
              <th className="py-1 font-medium">Cable</th>
            </tr>
          </thead>
          <tbody>
            {device.ports.map((port) => {
              const peer = peerOf(port);
              const state = led(port);
              return (
                <tr key={port.name} className="border-t border-(--nf-border)">
                  <td className="py-1.5 font-mono">
                    <span
                      className={`mr-2 inline-block h-2 w-2 rounded-full ${state.color}`}
                      aria-label={state.label}
                    />
                    {port.name}
                  </td>
                  <td className="py-1.5 text-(--nf-muted)">{PORT_TYPE_LABEL[port.type]}</td>
                  <td className="py-1.5 font-mono text-(--nf-muted)">{port.mac}</td>
                  <td className="py-1.5">
                    {peer && port.link ? (
                      <span className="flex items-center gap-2">
                        → {peer.device.name} {peer.name}
                        <button
                          type="button"
                          onClick={() => port.link && net.disconnect(port.link)}
                          className="rounded border border-(--nf-border) px-1.5 hover:border-(--nf-bad) hover:text-(--nf-bad)"
                          aria-label={`Unplug the cable from ${port.name}`}
                        >
                          Unplug
                        </button>
                      </span>
                    ) : (
                      <ConnectSelect port={port} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      {device.bridge && (
        <Section title="MAC table (bridge fdb)">
          {fdb.length === 0 ? (
            <p className="text-xs text-(--nf-muted)">
              Nothing learned yet. Frames passing through teach the switch who is where.
            </p>
          ) : (
            <ul className="font-mono text-xs">
              {fdb.map((e) => (
                <li key={e.mac}>
                  {e.mac} <span className="text-(--nf-muted)">on {e.port.name}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}

function NameField({ device }: { device: Device }) {
  const { net } = useLab();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? device.name;
  const valid = HOSTNAME.test(value);
  const commit = () => {
    if (valid && value !== device.name) net.rename(device, value);
    setDraft(null);
  };
  return (
    <label className="block text-xs text-(--nf-muted)">
      Hostname
      <input
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-invalid={!valid}
        className={`mt-1 w-full max-w-xs rounded border bg-(--nf-surface) px-2 py-1 font-mono text-sm text-(--nf-text) ${
          valid ? 'border-(--nf-border)' : 'border-(--nf-bad)'
        }`}
      />
      {!valid && <span className="block text-(--nf-bad)">Letters, digits and dashes only.</span>}
    </label>
  );
}

/** Settings: name and which interfaces are switched on. */
export function ConfigTab({ device }: { device: Device }) {
  const { net } = useLab();
  const appliance = device.printer !== null || device.camera !== null;
  return (
    <div className="space-y-4 p-4 text-sm">
      <NameField key={device.id} device={device} />
      <Section title="Interfaces">
        <ul className="space-y-1">
          {device.interfaces().map((port) => (
            <li key={port.name} className="flex items-center justify-between gap-2 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={port.adminUp}
                  onChange={(e) => net.setPortUp(port, e.target.checked)}
                />
                <span className="font-mono">{port.name}</span>
                <span className="text-(--nf-muted)">{port.adminUp ? 'enabled' : 'disabled'}</span>
              </label>
              <code className="text-(--nf-muted)">
                ip link set {port.name} {port.adminUp ? 'down' : 'up'}
              </code>
            </li>
          ))}
        </ul>
      </Section>
      {appliance ? (
        <>
          <ApplianceSection device={device} />
          <Section title="Address">
            <DhcpBox device={device} />
            {device.ip?.ports.map((port) => (
              <PortForm key={port.name} device={device} port={port} />
            ))}
            <GatewayDns device={device} />
          </Section>
        </>
      ) : (
        <>
          {device.ip && !hasDesktop(device.spec.id) && (
            <Section title="Addresses">
              {device.ip.ports.map((port) => (
                <PortForm key={port.name} device={device} port={port} />
              ))}
              <Ipv6Box device={device} />
            </Section>
          )}
          <WirelessSection device={device} />
          <SwitchVlanSection device={device} />
          <StpSection device={device} />
          <VlanInterfacesSection device={device} />
          {(device.ip?.ports.length ?? 0) > 0 && <RoutingSection device={device} />}
          <OspfSection device={device} />
          <RadvdSection device={device} />
          <FirewallSection device={device} />
          <WireguardSection device={device} />
          <ServicesSection device={device} />
          <WebServerSection device={device} />
          <MailServerSection device={device} />
        </>
      )}
      <LinuxCommandsSection device={device} />
      <button
        type="button"
        onClick={() => removeDevice(device.id)}
        className="rounded border border-(--nf-border) px-3 py-1.5 text-xs hover:border-(--nf-bad) hover:text-(--nf-bad)"
      >
        Delete device
      </button>
    </div>
  );
}

/** Small line drawings for the desktop apps (stroke follows the text colour). */
function AppIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const APPS: { id: AppId; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    icon: (
      <AppIcon>
        <path d="m5 8 4 4-4 4M12 17h7" />
      </AppIcon>
    ),
    hint: 'Linux shell: ip, ping, …',
  },
  {
    id: 'ipconfig',
    label: 'IP Configuration',
    icon: (
      <AppIcon>
        <path d="M5 7h14M5 12h14M5 17h14" />
        <circle cx="9" cy="7" r="2" fill="var(--nf-term-bg)" />
        <circle cx="15" cy="12" r="2" fill="var(--nf-term-bg)" />
        <circle cx="8" cy="17" r="2" fill="var(--nf-term-bg)" />
      </AppIcon>
    ),
    hint: 'Set addresses without commands',
  },
  {
    id: 'browser',
    label: 'Web Browser',
    icon: (
      <AppIcon>
        <circle cx="12" cy="12" r="8" />
        <path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" />
      </AppIcon>
    ),
    hint: 'Open web pages over HTTP',
  },
  {
    id: 'editor',
    label: 'Text Editor',
    icon: (
      <AppIcon>
        <path d="M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16h6" />
      </AppIcon>
    ),
    hint: 'Edit files, like web pages',
  },
  {
    id: 'mail',
    label: 'Mail',
    icon: (
      <AppIcon>
        <rect x="4" y="6" width="16" height="12" rx="1" />
        <path d="m4 7 8 6 8-6" />
      </AppIcon>
    ),
    hint: 'Send and read email (SMTP, POP3)',
  },
  {
    id: 'wifi',
    label: 'Wi-Fi',
    icon: (
      <AppIcon>
        <path d="M4 10a11 11 0 0 1 16 0M7 13.5a7 7 0 0 1 10 0M10 17a3 3 0 0 1 4 0" />
      </AppIcon>
    ),
    hint: 'Join a wireless network',
  },
  {
    id: 'capture',
    label: 'Packet Capture',
    icon: (
      <AppIcon>
        <path d="M3 12h4l2-6 4 12 2-6h6" />
      </AppIcon>
    ),
    hint: 'See every frame this device sends and receives',
  },
];

function AppView({ device, app }: { device: Device; app: AppId }) {
  switch (app) {
    case 'terminal':
      return <Terminal deviceId={device.id} />;
    case 'ipconfig':
      return <IpConfig device={device} />;
    case 'browser':
      return <Browser device={device} />;
    case 'editor':
      return <TextEditor device={device} />;
    case 'mail':
      return <Mail device={device} />;
    case 'capture':
      return <Capture device={device} />;
    case 'wifi':
      return <Wifi device={device} />;
  }
}

/** The PC's desktop: an app grid, or the open app with a way back. */
export function DesktopTab({ device, app }: { device: Device; app: AppId | null }) {
  if (app) {
    const label = APPS.find((a) => a.id === app)?.label;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-(--nf-border) px-2 py-1 text-xs">
          <button
            type="button"
            onClick={() => setWindowView(device.id, { app: null })}
            className="rounded px-2 py-0.5 hover:bg-(--nf-raised)"
          >
            ← Desktop
          </button>
          <span className="font-semibold">{label}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <AppView device={device} app={app} />
        </div>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3 p-4">
      {APPS.filter((a) => a.id !== 'wifi' || device.ports.some((p) => p.type === 'wifi')).map(
        (a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setWindowView(device.id, { app: a.id })}
              title={a.hint}
              className="flex w-full flex-col items-center gap-2 rounded p-3 text-xs hover:bg-(--nf-raised)"
            >
              <span
                className="flex h-12 w-12 items-center justify-center rounded bg-(--nf-term-bg) text-(--nf-term-prompt)"
                aria-hidden
              >
                {a.icon}
              </span>
              {a.label}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
