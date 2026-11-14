import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from '@xyflow/react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { Network } from '../engine/network.ts';
import { hasCarrier, type Link } from '../engine/port.ts';
import { isSpecId } from '../engine/specs.ts';
import { NoteNode, ZoneNode, type NoteNodeType, type ZoneNodeType } from './AnnotationNodes.tsx';
import { NOTE_ID, ZONE_ID } from './annotations.ts';
import { CableEdge, type CableEdgeType } from './CableEdge.tsx';
import { BODY_HANDLE, DeviceNode, type DeviceNodeType } from './DeviceNode.tsx';
import {
  addDevice,
  cable,
  exists,
  getLab,
  moveAnnotation,
  moveDevice,
  notify,
  openWindow,
  removeAnnotation,
  removeDevice,
  select,
  updateNote,
  updateZone,
  setSelection,
  useLab,
} from './lab.ts';
import { copySelection, pasteClipboard } from './clipboard.ts';
import { EmptyCanvas } from './EmptyCanvas.tsx';
import type { Tab } from './TaskPanel.tsx';
import { startFirstTask } from './taskStart.ts';
import { useTaskFocus } from './taskProgress.ts';
import { portRole, vlanColor, vlansInUse } from './vlanColors.ts';
import { DeviceMenu, PortMenu, type DeviceMenuState, type PortMenuState } from './PortMenu.tsx';

const nodeTypes = { device: DeviceNode, note: NoteNode, zone: ZoneNode };
type CanvasNode = DeviceNodeType | NoteNodeType | ZoneNodeType;
const edgeTypes = { cable: CableEdge };
export const DRAG_MIME = 'application/x-netforge-device';
/** Default device window size (matches Windows.tsx) and its distance from the device. */
const WINDOW = { w: 600, h: 440, gap: 24 };
/** Only the latest frames can still be blinking, so older trace entries are skipped. */
const ACTIVITY_WINDOW = 200;

function portOf(net: Network, device: string | undefined, port: string | null | undefined) {
  return (port && device && net.devices.get(device)?.port(port)) || null;
}

/** The VLAN colour of a copper cable whose switch end is an access port, else null. */
function cableVlanColor(l: Link): string | null {
  if (l.medium !== 'copper') return null;
  for (const end of [l.a, l.b]) {
    const role = portRole(end.device.bridge, end);
    if (role?.kind === 'access') return vlanColor(role.vid);
  }
  return null;
}

export function Canvas({ onShowPanel }: { onShowPanel: (tab?: Tab) => void }) {
  const { net, layout, notes, zones, selection, mode, why } = useLab();
  const [selectedCable, setSelectedCable] = useState<string | null>(null);
  const [menu, setMenu] = useState<PortMenuState | null>(null);
  const [deviceMenu, setDeviceMenu] = useState<DeviceMenuState | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  const focus = useTaskFocus();
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

  const vlans = vlansInUse([...net.devices.values()].map((d) => d.bridge));

  const deviceNodes: DeviceNodeType[] = [...net.devices.values()].map((d) => {
    const size = sizes[d.id];
    return {
      id: d.id,
      type: 'device',
      position: layout[d.id] ?? { x: 0, y: 0 },
      selected: selection.includes(d.id),
      data: {
        deviceId: d.id,
        version: net.version,
        activity: activity[d.id] ?? {},
        // Task highlights and the device a failure explanation points at.
        focused: (focus?.devices.includes(d.id) ?? false) || why?.explanation.deviceId === d.id,
      },
      ...(size ? { measured: size } : {}),
    };
  });

  // Zones sit behind everything (only their title bar and edges take the mouse); notes on top.
  const zoneNodes: ZoneNodeType[] = zones.map((zone) => ({
    id: zone.id,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    width: zone.w,
    height: zone.h,
    zIndex: -1,
    className: 'nf-zone',
    dragHandle: '.nf-zone-title',
    selected: selection.includes(zone.id),
    data: { zone },
  }));
  const noteNodes: NoteNodeType[] = notes.map((note) => {
    const size = sizes[note.id];
    return {
      id: note.id,
      type: 'note',
      position: { x: note.x, y: note.y },
      width: note.w,
      zIndex: 2,
      selected: selection.includes(note.id),
      data: { note },
      ...(size ? { measured: size } : {}),
    };
  });
  const nodes: CanvasNode[] = [...zoneNodes, ...deviceNodes, ...noteNodes];

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
      vlanColor: cableVlanColor(l),
      packets: recent.filter((t) => t.linkId === l.id),
    },
  }));

  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    // Picks and drops arrive one node at a time; apply them as one selection change.
    let picked = getLab().selection;
    for (const c of changes) {
      if (c.type === 'add' || c.type === 'replace') continue;
      const isDevice = !NOTE_ID.test(c.id) && !ZONE_ID.test(c.id);
      if (c.type === 'dimensions' && c.dimensions) {
        const { width, height } = c.dimensions;
        if (c.setAttributes && NOTE_ID.test(c.id)) updateNote(c.id, { w: Math.round(width) });
        else if (c.setAttributes && ZONE_ID.test(c.id)) {
          updateZone(c.id, { w: Math.round(width), h: Math.round(height) });
        } else setSizes((prev) => ({ ...prev, [c.id]: { width, height } }));
      } else if (c.type === 'position' && c.position) {
        if (isDevice) moveDevice(c.id, c.position);
        else moveAnnotation(c.id, c.position);
      } else if (c.type === 'select') {
        picked = picked.filter((id) => id !== c.id);
        if (c.selected) picked = [...picked, c.id];
      } else if (c.type === 'remove') {
        if (isDevice) removeDevice(c.id);
        else removeAnnotation(c.id);
      }
    }
    setSelection(picked.filter(exists));
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
    if (point) setMenu({ from, target, ...at(point) });
  };

  const at = (event: { clientX: number; clientY: number }) => {
    const box = wrapper.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  /** Where a new window goes: next to the clicked device, on the side with more room. */
  const beside = (node: Element | null) => {
    const box = wrapper.current?.getBoundingClientRect();
    const rect = node?.getBoundingClientRect();
    if (!box || !rect) return undefined;
    const left = rect.left - box.left;
    const right = rect.right - box.left;
    const x =
      left + rect.width / 2 < box.width / 2 ? right + WINDOW.gap : left - WINDOW.w - WINDOW.gap;
    const clamp = (v: number, max: number) => Math.max(8, Math.min(v, max));
    return {
      x: clamp(x, box.width - WINDOW.w - 8),
      y: clamp(rect.top - box.top - 40, box.height - WINDOW.h - 8),
    };
  };

  // Ctrl/Cmd+A, C and V work on the canvas, but not while the keys go to a text field or a
  // device window, and Ctrl+C leaves selected text to the browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element;
      const key = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !['a', 'c', 'v'].includes(key)) return;
      if (target.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) {
        return;
      }
      if (key === 'a') {
        const lab = getLab();
        setSelection([
          ...lab.zones.map((z) => z.id),
          ...lab.net.devices.keys(),
          ...lab.notes.map((n) => n.id),
        ]);
      } else if (key === 'c') {
        if (window.getSelection()?.toString()) return;
        copySelection();
      } else pasteClipboard();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrop = (event: DragEvent) => {
    const spec = event.dataTransfer.getData(DRAG_MIME);
    if (!isSpecId(spec)) return;
    event.preventDefault();
    const drop = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addDevice(spec, { x: drop.x - 70, y: drop.y - 40 });
  };

  return (
    <div
      ref={wrapper}
      className="relative h-full"
      onKeyDown={(e) => {
        // Enter on a focused device opens its window, like a click.
        const id = (e.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
        if (e.key === 'Enter' && id) openWindow(id);
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnectEnd={onConnectEnd}
        onNodeClick={(event, node) => {
          // Ctrl/Cmd+click edits the selection; it does not open a window.
          if (event.ctrlKey || event.metaKey || event.shiftKey || node.type !== 'device') return;
          openWindow(node.id, {}, beside((event.target as Element).closest('.react-flow__node')));
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          const device = net.devices.get(node.id);
          if (device) setDeviceMenu({ device, ...at(event) });
        }}
        onPaneClick={() => select(null)}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={onDrop}
        elevateNodesOnSelect={false}
        selectionMode={SelectionMode.Full}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{ stroke: 'var(--nf-accent)', strokeWidth: 2.5 }}
        deleteKeyCode={['Delete', 'Backspace']}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        maxZoom={2}
        aria-label="Network topology canvas"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="var(--nf-grid)" />
        <Controls />
      </ReactFlow>
      {net.devices.size === 0 && (
        <EmptyCanvas
          onStartTask={() => {
            startFirstTask(flow);
            onShowPanel();
          }}
          onOpenReadyNetworks={() => onShowPanel('networks')}
        />
      )}
      {vlans.length > 0 && (
        <ul
          aria-label="VLAN colours"
          className="pointer-events-none absolute right-3 bottom-3 z-[1] space-y-1 rounded-[4px] border border-(--nf-border) bg-(--nf-surface) px-2.5 py-2 text-xs"
        >
          {vlans.map((vid) => (
            <li key={vid} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ background: vlanColor(vid) ?? undefined }}
              />
              VLAN {vid}
            </li>
          ))}
        </ul>
      )}
      {menu && <PortMenu menu={menu} onClose={() => setMenu(null)} />}
      {deviceMenu && <DeviceMenu menu={deviceMenu} onClose={() => setDeviceMenu(null)} />}
    </div>
  );
}
