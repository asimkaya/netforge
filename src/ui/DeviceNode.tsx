import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { formatCidr } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import { WIFI_RANGE } from '../engine/wifi.ts';
import { PORT_TYPE_LABEL, hasCarrier, peerOf, type Port } from '../engine/port.ts';
import { getLab } from './lab.ts';
import { portRole, vlanColor } from './vlanColors.ts';

export type DeviceNodeType = Node<
  {
    deviceId: string;
    version: number;
    activity: Record<string, number>;
    /** The current task step is about this device. */
    focused: boolean;
  },
  'device'
>;

/** Handle id used for "dropped on the device body": the canvas then asks which port. */
export const BODY_HANDLE = 'body';

const SOCKET = { w: 22, h: 16 };

/** Spanning Tree state of a switch port, when STP runs and the port is not forwarding. */
function stpHold(port: Port): string | null {
  const stp = port.device.bridge?.stp;
  if (!stp?.enabled || !hasCarrier(port)) return null;
  const state = stp.stateOf(port);
  return state === 'forwarding' ? null : state;
}

function portTitle(port: Port): string {
  const peer = peerOf(port);
  const hold = stpHold(port);
  const state = !port.adminUp
    ? 'disabled'
    : peer
      ? `to ${peer.device.name} ${peer.name}${hasCarrier(port) ? '' : ' (no carrier)'}${hold ? ` · STP ${hold}` : ''}`
      : 'free: drag to another port to add a cable';
  return `${port.name} · ${PORT_TYPE_LABEL[port.type]} · ${state}`;
}

function ledColor(port: Port): string {
  // Like a real switch: amber while Spanning Tree holds the port back.
  if (hasCarrier(port)) return stpHold(port) ? 'var(--nf-warn)' : 'var(--nf-ok)';
  if (port.link) return 'var(--nf-warn)';
  return 'color-mix(in srgb, var(--nf-hw-muted) 40%, transparent)';
}

/** One physical socket: a React Flow handle shaped like an RJ45 or SFP cage, plus its LED. */
function Socket({
  port,
  x,
  y,
  position,
  activity,
  label,
}: {
  port: Port;
  x: number;
  y: number;
  position: Position;
  activity: number | undefined;
  label?: string;
}) {
  const sfp = port.type === 'sfp';
  const role = portRole(port.device.bridge, port);
  const style: CSSProperties = {
    left: x,
    top: y,
    right: 'auto',
    bottom: 'auto',
    width: SOCKET.w,
    height: SOCKET.h,
    transform: 'none',
  };
  return (
    <>
      <span
        key={activity ?? 'idle'}
        className={`absolute h-1.5 w-1.5 rounded-full ${activity ? 'nf-led-blink' : ''}`}
        style={{ left: x + SOCKET.w / 2 - 3, top: y - 7, background: ledColor(port) }}
        aria-hidden
      />
      <Handle
        id={port.name}
        type="source"
        position={position}
        title={portTitle(port)}
        aria-label={portTitle(port)}
        data-testid={`port-${port.device.name}-${port.name}`}
        className={`z-10 !rounded-[3px] !border-[1.5px] !bg-(--nf-socket) hover:!border-(--nf-ok) ${
          sfp
            ? '!border-(--nf-cable-fiber)'
            : port.link
              ? '!border-(--nf-hw-muted)'
              : '!border-(--nf-hw-edge)'
        }`}
        style={style}
      >
        {/* RJ45 latch notch; SFP cages are plain rectangles. */}
        {!sfp && (
          <span className="pointer-events-none absolute bottom-0 left-1/2 h-1 w-2 -translate-x-1/2 rounded-t-[1px] bg-(--nf-hw-edge)" />
        )}
      </Handle>
      {role?.kind === 'access' && (
        <span
          aria-hidden
          className="pointer-events-none absolute h-[3px] rounded-[1px]"
          style={{
            left: x,
            top: y + SOCKET.h,
            width: SOCKET.w,
            background: vlanColor(role.vid) ?? undefined,
          }}
        />
      )}
      {role?.kind === 'trunk' &&
        role.vids.slice(0, 4).map((vid, i, shown) => (
          <span
            key={vid}
            aria-hidden
            className="pointer-events-none absolute h-[3px] w-[4px]"
            style={{
              left: x + SOCKET.w / 2 - (shown.length * 5 - 1) / 2 + i * 5,
              top: y + SOCKET.h,
              background: vlanColor(vid) ?? undefined,
            }}
          />
        ))}
      {label && (
        <span
          className="pointer-events-none absolute text-center font-(family-name:--font-label) text-[9px] text-(--nf-hw-muted)"
          style={{ left: x, top: y + SOCKET.h + (role ? 4 : 1), width: SOCKET.w }}
        >
          {label}
        </span>
      )}
    </>
  );
}

/** Wi-Fi radios have no socket: an invisible handle at the center anchors wireless links. */
function RadioHandles({ device }: { device: Device }) {
  return (
    <>
      {device.ports
        .filter((p) => p.type === 'wifi')
        .map((p) => (
          <Handle
            key={p.name}
            id={p.name}
            type="source"
            position={Position.Top}
            isConnectable={false}
            className="!pointer-events-none !opacity-0"
            style={{ left: '50%', top: '50%', width: 1, height: 1, transform: 'none' }}
          />
        ))}
    </>
  );
}

function WifiBadge({ device }: { device: Device }) {
  const radio = device.ports.find((p) => p.type === 'wifi');
  if (!radio) return null;
  const on = hasCarrier(radio);
  return (
    <span
      className={`absolute top-2 left-2 font-mono text-[11px] ${on ? 'text-(--nf-ok)' : 'text-(--nf-hw-muted)'}`}
      title={on ? `${radio.name}: connected to Wi-Fi` : `${radio.name}: not connected to Wi-Fi`}
      aria-label={on ? 'Wi-Fi connected' : 'Wi-Fi not connected'}
    >
      ((•))
    </span>
  );
}

function HostArt({ device, addr }: { device: Device; addr: string }) {
  const screen = (x: number, y: number, w: number, h: number) => (
    <>
      <rect x={x} y={y} width={w} height={h} rx="2" fill="var(--nf-term-bg)" />
      <text x={x + 5} y={y + 13} fill="var(--nf-term-prompt)" fontSize="8" className="font-mono">
        root@{device.name.slice(0, 10)}
      </text>
      <text x={x + 5} y={y + 25} fill="var(--nf-term-text)" fontSize="8" className="font-mono">
        {addr}
      </text>
    </>
  );
  switch (device.spec.id) {
    case 'phone':
      return (
        <svg viewBox="0 0 96 66" className="h-16 w-24" aria-hidden>
          <rect x="30" y="1" width="36" height="64" rx="6" fill="var(--nf-hw-edge)" />
          <rect x="33" y="7" width="30" height="50" rx="2" fill="var(--nf-term-bg)" />
          <text x="35" y="20" fill="var(--nf-term-prompt)" fontSize="6" className="font-mono">
            {device.name.slice(0, 8)}
          </text>
          <text x="35" y="30" fill="var(--nf-term-text)" fontSize="5" className="font-mono">
            {addr}
          </text>
        </svg>
      );
    case 'laptop':
      return (
        <svg viewBox="0 0 96 66" className="h-16 w-24" aria-hidden>
          <rect x="10" y="1" width="76" height="50" rx="4" fill="var(--nf-hw-edge)" />
          {screen(14, 5, 68, 42)}
          <path d="M2 53h92l-6 10H8z" fill="var(--nf-hw-edge)" />
        </svg>
      );
    case 'server':
      return (
        <svg viewBox="0 0 96 66" className="h-16 w-24" aria-hidden>
          <rect x="1" y="1" width="94" height="52" rx="5" fill="var(--nf-hw-edge)" />
          {screen(5, 5, 86, 28)}
          {[36, 42].map((y) => (
            <g key={y}>
              <rect x="10" y={y} width="76" height="4" rx="1" fill="var(--nf-socket)" />
              <circle
                cx="82"
                cy={y + 2}
                r="1.3"
                fill={device.httpd ? 'var(--nf-ok)' : 'var(--nf-hw-muted)'}
              />
            </g>
          ))}
          <rect x="8" y="53" width="80" height="12" rx="2" fill="var(--nf-hw-edge)" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 96 66" className="h-16 w-24" aria-hidden>
          <rect x="1" y="1" width="94" height="52" rx="5" fill="var(--nf-hw-edge)" />
          {screen(5, 5, 86, 44)}
          <rect
            x="10"
            y="36"
            width="5"
            height="7"
            fill="var(--nf-term-prompt)"
            className="nf-cursor"
          />
          <path d="M40 53h16l3 8H37z" fill="var(--nf-hw-edge)" />
          <rect x="30" y="61" width="36" height="4" rx="2" fill="var(--nf-hw-edge)" />
        </svg>
      );
  }
}

/** PCs, servers, laptops and phones: a drawing, the name, an Ethernet socket and Wi-Fi. */
function HostFace({ device, activity }: { device: Device; activity: Record<string, number> }) {
  const addr = device.ip?.allAddrs()[0];
  const wired = device.ports.find((p) => p.type === 'ethernet');
  const width = device.spec.id === 'phone' ? 'w-28' : 'w-40';
  const right = device.spec.id === 'phone' ? 112 : 160;
  return (
    <div className={`relative flex ${width} flex-col items-center px-3 pt-2 pb-2`}>
      <HostArt device={device} addr={addr ? formatCidr(addr) : 'no address'} />
      <span className="max-w-full truncate text-xs font-semibold text-(--nf-hw-text)">
        {device.name}
      </span>
      <WifiBadge device={device} />
      <RadioHandles device={device} />
      {wired && (
        // Top-right corner: cables usually come down from a switch above.
        <Socket
          port={wired}
          x={right - SOCKET.w - 8}
          y={12}
          position={Position.Top}
          activity={activity[wired.name]}
        />
      )}
    </div>
  );
}

/** An access point: antennas, its wired uplink and, while it runs, its Wi-Fi range. */
function ApFace({ device, activity }: { device: Device; activity: Record<string, number> }) {
  const uplink = device.ports.find((p) => p.type === 'ethernet');
  const clients = device.ports.filter((p) => p.type === 'wifi' && p.link).length;
  const on = device.hostapd !== null;
  return (
    <div className="relative flex w-40 flex-col items-center px-3 pt-2 pb-9">
      {on && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-(--nf-accent)/35 bg-(--nf-accent)/[0.04]"
          style={{ width: WIFI_RANGE * 2, height: WIFI_RANGE * 2 }}
        />
      )}
      <svg viewBox="0 0 96 40" className="h-10 w-24" aria-hidden>
        <path
          d="M30 22V6M66 22V6"
          stroke={on ? 'var(--nf-ok)' : 'var(--nf-hw-muted)'}
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect x="14" y="20" width="68" height="18" rx="5" fill="var(--nf-hw-edge)" />
        <circle cx="70" cy="29" r="2" fill={on ? 'var(--nf-ok)' : 'var(--nf-hw-muted)'} />
      </svg>
      <span className="max-w-full truncate text-xs font-semibold text-(--nf-hw-text)">
        {device.name}
      </span>
      <span className="text-[10px] text-(--nf-hw-muted)">
        {on ? (
          <>
            <span className="mr-1.5 text-(--nf-hw-text)">{device.hostapd?.ssid}</span>
            <span>{`${clients} client${clients === 1 ? '' : 's'}`}</span>
          </>
        ) : (
          'radio off'
        )}
      </span>
      <RadioHandles device={device} />
      {uplink && (
        <Socket
          port={uplink}
          x={80 - SOCKET.w / 2}
          y={84}
          position={Position.Bottom}
          activity={activity[uplink.name]}
          label={uplink.name.slice(3)}
        />
      )}
    </div>
  );
}

/** A home router: antennas and Wi-Fi range, the Internet (WAN) port and four LAN ports. */
function HomeRouterFace({
  device,
  activity,
}: {
  device: Device;
  activity: Record<string, number>;
}) {
  const wan = device.port('eth0');
  const lan = device.ports.filter((p) => p.type === 'ethernet' && p !== wan);
  const clients = device.ports.filter((p) => p.type === 'wifi' && p.link).length;
  const on = device.hostapd !== null;
  const pitch = SOCKET.w + 6;
  return (
    <div className="relative h-[92px] w-[200px]">
      {on && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-(--nf-accent)/35 bg-(--nf-accent)/[0.04]"
          style={{ width: WIFI_RANGE * 2, height: WIFI_RANGE * 2 }}
        />
      )}
      <div className="flex items-baseline gap-2 px-3 pt-1.5">
        <span className="truncate text-xs font-semibold text-(--nf-hw-text)">{device.name}</span>
        <span className="truncate text-[10px] text-(--nf-hw-muted)">
          {on ? (
            <>
              <span className="mr-1.5 text-(--nf-hw-text)">{device.hostapd?.ssid}</span>
              <span>{`${clients} client${clients === 1 ? '' : 's'}`}</span>
            </>
          ) : (
            'Wi-Fi off'
          )}
        </span>
      </div>
      <span className="absolute top-[30px] left-3 text-[9px] font-semibold text-(--nf-hw-text)">
        Internet
      </span>
      <span className="absolute top-[30px] left-[62px] text-[9px] text-(--nf-hw-muted)">LAN</span>
      {wan && (
        <Socket
          port={wan}
          x={12}
          y={44}
          position={Position.Bottom}
          activity={activity[wan.name]}
          label="WAN"
        />
      )}
      {lan.map((p, i) => (
        <Socket
          key={p.name}
          port={p}
          x={62 + i * pitch}
          y={44}
          position={Position.Bottom}
          activity={activity[p.name]}
          label={p.name.slice(3)}
        />
      ))}
      <RadioHandles device={device} />
    </div>
  );
}

function SwitchFace({ device, activity }: { device: Device; activity: Record<string, number> }) {
  const copper = device.ports.filter((p) => p.type === 'ethernet');
  const fiber = device.ports.filter((p) => p.type === 'sfp');
  const pitch = SOCKET.w + 6;
  // Wide enough for the ports and for the name line, whichever is longer.
  const width = Math.max(200, 16 + copper.length * pitch + 12 + fiber.length * pitch + 10);
  const y = 34;
  return (
    <div className="relative h-[74px]" style={{ width }}>
      <div className="flex items-baseline gap-2 px-3 pt-1.5">
        <span className="truncate text-xs font-semibold text-(--nf-hw-text)">{device.name}</span>
        <span className="flex gap-1.5 text-[10px] text-(--nf-hw-muted)">
          <span>{device.spec.label}</span>
          <span>{copper.length}× Ethernet</span>
          {fiber.length > 0 && <span>{fiber.length}× SFP</span>}
        </span>
      </div>
      {copper.map((p, i) => (
        <Socket
          key={p.name}
          port={p}
          x={16 + i * pitch}
          y={y}
          position={Position.Bottom}
          activity={activity[p.name]}
          label={p.name.slice(3)}
        />
      ))}
      {fiber.map((p, i) => (
        <Socket
          key={p.name}
          port={p}
          x={16 + copper.length * pitch + 12 + i * pitch}
          y={y}
          position={Position.Bottom}
          activity={activity[p.name]}
          label={p.name.slice(3)}
        />
      ))}
    </div>
  );
}

export function DeviceNode({ id, data, selected }: NodeProps<DeviceNodeType>) {
  const connection = useConnection();
  const isDropTarget = connection.inProgress && connection.fromNode.id !== id;
  const device = getLab().net.devices.get(data.deviceId);
  if (!device) return null;
  const kind = device.spec.id;
  const Face =
    kind === 'ap'
      ? ApFace
      : kind === 'homerouter'
        ? HomeRouterFace
        : kind === 'pc' || kind === 'server' || kind === 'laptop' || kind === 'phone'
          ? HostFace
          : SwitchFace;
  return (
    <div
      className={`relative rounded-md border bg-(--nf-hw) font-(family-name:--font-label) text-(--nf-hw-text) transition-colors ${
        selected
          ? 'border-(--nf-accent) shadow-[0_0_0_1px_var(--nf-accent)]'
          : 'border-(--nf-hw-edge)'
      } ${data.focused ? 'nf-focus' : ''}`}
      data-testid={`device-${device.name}`}
    >
      {/*
        The device body is a drop target for cables. It is always mounted so React Flow
        has measured it, but only catches the pointer while a cable is being dragged.
      */}
      <Handle
        id={BODY_HANDLE}
        type="target"
        position={Position.Top}
        isConnectableStart={false}
        className={`!absolute !inset-0 !z-[5] !h-full !w-full !transform-none !rounded-md !border-2 !border-dashed !bg-transparent ${
          isDropTarget ? '!border-(--nf-accent)' : '!pointer-events-none !border-transparent'
        }`}
      />
      <Face device={device} activity={data.activity} />
    </div>
  );
}
