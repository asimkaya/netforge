const BASE =
  'pointer-events-auto rounded px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--nf-accent)';
const PRIMARY = `${BASE} bg-(--nf-accent) text-(--nf-on-accent) hover:opacity-90`;
const SECONDARY = `${BASE} border border-(--nf-border) hover:bg-(--nf-raised)`;

/** Quiet hint shown while the lab has no devices. The wrapper lets drops through. */
export function EmptyCanvas({
  onOpenTasks,
  onOpenReadyNetworks,
}: {
  onOpenTasks: () => void;
  onOpenReadyNetworks: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center gap-1 text-center">
      <p className="font-(family-name:--font-label) text-xl font-semibold text-(--nf-text)">
        An empty bench.
      </p>
      <p className="text-sm text-(--nf-muted)">
        Drag a device from the left, or start with one of these:
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={onOpenTasks} className={PRIMARY}>
          Open the task center
        </button>
        <button type="button" onClick={onOpenReadyNetworks} className={SECONDARY}>
          Open a ready network
        </button>
      </div>
    </div>
  );
}
