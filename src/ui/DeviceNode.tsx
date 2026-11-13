import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { formatCidr } from '../engine/addr.ts';
import type { Device } from '../engine/device.ts';
import { PORT_TYPE_LABEL, hasCarrier, peerOf, type Port } from '../engine/port.ts';
import { getLab } from './lab.ts';

export type DeviceNodeType = Node<
  { deviceId: string; version: number; activity: Record<string, number> },
  'device'
>;

/** Handle id used for "dropped on the device body": the canvas then asks which port. */
export const BODY_HANDLE = 'body';

const SOCKET = { w: 22, h: 16 };

function portTitle(port: Port): string {
  const peer = peerOf(port);
  const state = !port.adminUp
    ? 'disabled'
    : peer
      ? `to ${peer.device.name} ${peer.name}${hasCarrier(port) ? '' : ' (no carrier)'}`
      : 'free: drag to another port to add a cable';
  return `${port.name} · ${PORT_TYPE_LABEL[port.type]} · ${state}`;
}

function ledColor(port: Port): string {
  if (hasCarrier(port)) return '#22c55e';
  if (port.link) return '#f59e0b';
  return '#334155';
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
        className={`z-10 !rounded-[3px] !border-[1.5px] !bg-[#05080f] hover:!border-(--nf-accent) ${
          sfp ? '!border-amber-500' : port.link ? '!border-slate-400' : '!border-slate-600'
        }`}
        style={style}
      >
        {/* RJ45 latch notch; SFP cages are plain rectangles. */}
        {!sfp && (
          <span className="pointer-events-none absolute bottom-0 left-1/2 h-1 w-2 -translate-x-1/2 rounded-t-[1px] bg-slate-700" />
        )}
      </Handle>
      {label && (
        <span
          className="pointer-events-none absolute text-center font-mono text-[9px] text-(--nf-muted)"
          style={{ left: x, top: y + SOCKET.h + 1, width: SOCKET.w }}
        >
          {label}
        </span>
      )}
    </>
  );
}

function PcFace({ device, activity }: { device: Device; activity: Record<string, number> }) {
  const addr = device.ip?.allAddrs()[0];
  const port = device.ports[0];
  return (
    <div className="relative flex w-40 flex-col items-center px-3 pt-2 pb-2">
      <svg viewBox="0 0 96 66" className="h-16 w-24" aria-hidden>
        <rect x="1" y="1" width="94" height="52" rx="5" fill="#1e293b" />
        <rect x="5" y="5" width="86" height="44" rx="2" fill="#0b1f36" />
        <text x="10" y="18" fill="#38bdf8" fontSize="8" fontFamily="monospace">
          root@{device.name.slice(0, 10)}
        </text>
        <text x="10" y="30" fill="#94a3b8" fontSize="8" fontFamily="monospace">
          {addr ? formatCidr(addr) : 'no address'}
        </text>
        <rect x="10" y="36" width="5" height="7" fill="#38bdf8" className="nf-cursor" />
        <path d="M40 53h16l3 8H37z" fill="#334155" />
        <rect x="30" y="61" width="36" height="4" rx="2" fill="#334155" />
      </svg>
      <span className="max-w-full truncate text-xs font-semibold">{device.name}</span>
      {port && (
        // Top-right corner: cables usually come down from a switch above.
        <Socket
          port={port}
          x={160 - SOCKET.w - 8}
          y={12}
          position={Position.Top}
          activity={activity[port.name]}
        />
      )}
    </div>
  );
}

function SwitchFace({ device, activity }: { device: Device; activity: Record<string, number> }) {
  const copper = device.ports.filter((p) => p.type === 'ethernet');
  const fiber = device.ports.filter((p) => p.type === 'sfp');
  const pitch = SOCKET.w + 6;
  const width = 16 + copper.length * pitch + 12 + fiber.length * pitch + 10;
  const y = 34;
  return (
    <div className="relative h-[74px]" style={{ width }}>
      <div className="flex items-baseline gap-2 px-3 pt-1.5">
        <span className="truncate text-xs font-semibold">{device.name}</span>
        <span className="text-[10px] text-(--nf-muted)">
          {copper.length}× Ethernet · {fiber.length}× SFP
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
  const Face = device.spec.id === 'pc' ? PcFace : SwitchFace;
  return (
    <div
      className={`relative rounded-xl border bg-(--nf-surface) shadow-sm transition-colors ${
        selected ? 'border-(--nf-accent)' : 'border-(--nf-border)'
      }`}
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
        className={`!absolute !inset-0 !z-[5] !h-full !w-full !transform-none !rounded-xl !border-2 !border-dashed !bg-transparent ${
          isDropTarget ? '!border-(--nf-accent)' : '!pointer-events-none !border-transparent'
        }`}
      />
      <Face device={device} activity={data.activity} />
    </div>
  );
}
