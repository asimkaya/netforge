import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  useReactFlow,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react';
import { useRef, useState, type DragEvent } from 'react';
import type { Network } from '../engine/network.ts';
import { hasCarrier } from '../engine/port.ts';
import { isSpecId } from '../engine/specs.ts';
import { CableEdge, type CableEdgeType } from './CableEdge.tsx';
import { BODY_HANDLE, DeviceNode, type DeviceNodeType } from './DeviceNode.tsx';
import {
  addDevice,
  cable,
  getLab,
  moveDevice,
  notify,
  removeDevice,
  select,
  useLab,
} from './lab.ts';
import { PortMenu, type PortMenuState } from './PortMenu.tsx';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { cable: CableEdge };
export const DRAG_MIME = 'application/x-netforge-device';
/** Only the latest frames can still be blinking, so older trace entries are skipped. */
const ACTIVITY_WINDOW = 200;

function portOf(net: Network, device: string | undefined, port: string | null | undefined) {
  return (port && device && net.devices.get(device)?.port(port)) || null;
}

export function Canvas() {
  const { net, layout, selected, mode } = useLab();
  const [selectedCable, setSelectedCable] = useState<string | null>(null);
  const [menu, setMenu] = useState<PortMenuState | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  // Nodes are rebuilt from the store on every render, so keep React Flow's measurements.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});

  // In simulation mode, animate the frames delivered at the latest simulated instant.
  const lastTime = net.trace.at(-1)?.time;
  const recent = mode === 'simulation' ? net.trace.filter((t) => t.time === lastTime) : [];

  // Last frame seen on each port, so its LED blinks when a new one passes.
  const activity: Record<string, Record<string, number>> = {};
  for (const t of net.trace.slice(-ACTIVITY_WINDOW)) {
    for (const end of [t.from, t.to]) {
      (activity[end.device] ??= {})[end.port] = t.seq;
    }
  }

  const nodes: DeviceNodeType[] = [...net.devices.values()].map((d) => {
    const size = sizes[d.id];
    return {
      id: d.id,
      type: 'device',
      position: layout[d.id] ?? { x: 0, y: 0 },
      selected: d.id === selected,
      data: { deviceId: d.id, version: net.version, activity: activity[d.id] ?? {} },
      ...(size ? { measured: size } : {}),
    };
  });

  const edges: CableEdgeType[] = [...net.links.values()].map((l) => ({
    id: l.id,
    source: l.a.device.id,
    sourceHandle: l.a.name,
    target: l.b.device.id,
    targetHandle: l.b.name,
    type: 'cable',
    selected: l.id === selectedCable,
    data: {
      up: hasCarrier(l.a),
      medium: l.medium,
      packets: recent.filter((t) => t.linkId === l.id),
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

  /** A cable drag ended: on a port, cable it; on a device body, pick or ask for a port. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const from = portOf(net, state.fromHandle?.nodeId, state.fromHandle?.id);
    const to = state.toHandle;
    if (!from || !to) return;
    if (to.id !== BODY_HANDLE) {
      const port = portOf(net, to.nodeId, to.id);
      if (port) cable(from, port);
      return;
    }
    const target = net.devices.get(to.nodeId);
    if (!target) return;
    const fits = net.freePortsFor(target, from);
    const only = fits[0];
    if (fits.length === 1 && only) {
      cable(from, only);
      return;
    }
    if (fits.length === 0) {
      notify(
        `${target.name} has no free port that fits a cable from ${from.device.name} ${from.name}.`,
      );
      return;
    }
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    const box = wrapper.current?.getBoundingClientRect();
    if (!point || !box) return;
    setMenu({
      from,
      target,
      x: point.clientX - box.left,
      y: point.clientY - box.top,
    });
  };

  const onDrop = (event: DragEvent) => {
    const spec = event.dataTransfer.getData(DRAG_MIME);
    if (!isSpecId(spec)) return;
    event.preventDefault();
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addDevice(spec, { x: at.x - 70, y: at.y - 40 });
  };

  return (
    <div ref={wrapper} className="relative h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnectEnd={onConnectEnd}
        onPaneClick={() => select(null)}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={onDrop}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: 'var(--nf-accent)', strokeWidth: 2.5 }}
        deleteKeyCode={['Delete', 'Backspace']}
        colorMode="dark"
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        maxZoom={2}
        aria-label="Network topology canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
        <Controls />
      </ReactFlow>
      {menu && <PortMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
