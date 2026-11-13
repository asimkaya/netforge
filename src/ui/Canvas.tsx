import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';

export function Canvas() {
  return (
    <ReactFlow nodes={[]} edges={[]} colorMode="dark" fitView aria-label="Network topology canvas">
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
