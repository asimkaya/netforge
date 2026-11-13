import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import { formatCidr } from '../engine/addr.ts';
import { Host } from '../engine/host.ts';
import { DeviceIcon } from './icons.tsx';
import { getLab, openTerminal } from './lab.ts';

export type DeviceNodeType = Node<{ deviceId: string; version: number }, 'device'>;

export function DeviceNode({ id, data, selected }: NodeProps<DeviceNodeType>) {
  const connection = useConnection();
  const isDropTarget = connection.inProgress && connection.fromNode.id !== id;
  const device = getLab().net.devices.get(data.deviceId);
  if (!device) return null;
  const addr = device instanceof Host ? device.allAddrs()[0] : undefined;
  return (
    <div
      className={`flex w-28 flex-col items-center gap-1 rounded-xl border bg-(--nf-surface) px-2 py-2 text-center shadow-sm transition-colors ${
        selected ? 'border-(--nf-accent)' : 'border-(--nf-border)'
      }`}
      onDoubleClick={() => openTerminal(device.id)}
      data-testid={`device-${device.name}`}
    >
      <DeviceIcon kind={device.kind} className="h-8 w-8 text-(--nf-accent)" />
      <span className="max-w-full truncate text-xs font-semibold">{device.name}</span>
      <span className="font-mono text-[10px] text-(--nf-muted)">
        {addr ? formatCidr(addr) : device.kind === 'switch' ? 'switch' : 'no address'}
      </span>
      {/* While a cable is being dragged, the whole device becomes a drop target. */}
      {isDropTarget && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectableStart={false}
          className="!absolute !inset-0 !h-full !w-full !transform-none !rounded-xl !border-2 !border-dashed !border-(--nf-accent) !bg-transparent"
        />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-(--nf-surface) !bg-(--nf-accent)"
        title="Drag to another device to connect a cable"
      />
    </div>
  );
}
