import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { useState, type DragEvent } from 'react';
import { hasCarrier } from '../engine/device.ts';
import { CableEdge, type CableEdgeType } from './CableEdge.tsx';
import { DeviceNode, type DeviceNodeType } from './DeviceNode.tsx';
import { addDevice, getLab, moveDevice, notify, removeDevice, select, useLab } from './lab.ts';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { cable: CableEdge };
export const DRAG_MIME = 'application/x-netforge-device';

export function Canvas() {
  const { net, layout, selected, mode } = useLab();
  const [selectedCable, setSelectedCable] = useState<string | null>(null);
  const flow = useReactFlow();
  // Nodes are rebuilt from the store on every render, so keep React Flow's measurements.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});

  // In simulation mode, animate the frames delivered at the latest simulated instant.
  const lastTime = net.trace.at(-1)?.time;
  const recent = mode === 'simulation' ? net.trace.filter((t) => t.time === lastTime) : [];

  const nodes: DeviceNodeType[] = [...net.devices.values()].map((d) => {
    const size = sizes[d.id];
    return {
      id: d.id,
      type: 'device',
      position: layout[d.id] ?? { x: 0, y: 0 },
      selected: d.id === selected,
      data: { deviceId: d.id, version: net.version },
      ...(size ? { measured: size } : {}),
    };
  });

  const edges: CableEdgeType[] = [...net.links.values()].map((l) => ({
    id: l.id,
    source: l.a.device.id,
    target: l.b.device.id,
    type: 'cable',
    selected: l.id === selectedCable,
    data: {
      up: hasCarrier(l.a),
      packets: recent.filter((t) => t.linkId === l.id),
      labelA: l.a.name,
      labelB: l.b.name,
    },
  }));

  const onNodesChange = (changes: NodeChange<DeviceNodeType>[]) => {
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) {
        const size = c.dimensions;
        setSizes((prev) => ({ ...prev, [c.id]: size }));
      } else if (c.type === 'position' && c.position) moveDevice(c.id, c.position);
      else if (c.type === 'select') {
        if (c.selected) select(c.id);
        else if (getLab().selected === c.id) select(null);
      } else if (c.type === 'remove') removeDevice(c.id);
    }
  };

  const onEdgesChange = (changes: EdgeChange<CableEdgeType>[]) => {
    for (const c of changes) {
      if (c.type === 'select') setSelectedCable(c.selected ? c.id : null);
      else if (c.type === 'remove') {
        const link = net.links.get(c.id);
        if (link) net.disconnect(link);
      }
    }
  };

  const onDrop = (event: DragEvent) => {
    const kind = event.dataTransfer.getData(DRAG_MIME);
    if (kind !== 'host' && kind !== 'switch') return;
    event.preventDefault();
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addDevice(kind, { x: at.x - 56, y: at.y - 40 });
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={({ source, target }) => {
        const a = net.devices.get(source);
        const b = net.devices.get(target);
        if (!a || !b) return;
        try {
          net.connect(a, b);
        } catch (error) {
          notify(error instanceof Error ? error.message : String(error));
        }
      }}
      onPaneClick={() => select(null)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
      connectionMode={ConnectionMode.Loose}
      deleteKeyCode={['Delete', 'Backspace']}
      colorMode="dark"
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      maxZoom={2}
      aria-label="Network topology canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      <Controls />
    </ReactFlow>
  );
}
