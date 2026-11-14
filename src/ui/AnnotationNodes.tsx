import {
  NodeResizeControl,
  NodeResizer,
  ResizeControlVariant,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useState } from 'react';
import { LIMITS, type Note, type Zone } from './annotations.ts';
import { updateNote, updateZone } from './lab.ts';

export type NoteNodeType = Node<{ note: Note }, 'note'>;
export type ZoneNodeType = Node<{ zone: Zone }, 'zone'>;

const SELECTED = 'border-(--nf-accent) shadow-[0_0_0_1px_var(--nf-accent)]';

/** A text label on the canvas: double-click to edit, drag the right edge to resize. */
export function NoteNode({ data, selected }: NodeProps<NoteNodeType>) {
  const { note } = data;
  const [editing, setEditing] = useState(false);
  return (
    <div
      data-testid={`note-${note.id}`}
      onDoubleClick={() => setEditing(true)}
      className={`rounded-[4px] border bg-(--nf-surface) px-2.5 py-2 text-[13px] leading-snug break-words whitespace-pre-wrap ${
        selected ? SELECTED : 'border-(--nf-border)'
      }`}
    >
      {selected && (
        <NodeResizeControl
          position="right"
          variant={ResizeControlVariant.Line}
          minWidth={LIMITS.noteWidth.min}
          maxWidth={LIMITS.noteWidth.max}
        />
      )}
      {editing ? (
        <textarea
          aria-label="Note text"
          autoFocus
          defaultValue={note.text}
          maxLength={LIMITS.noteText}
          onBlur={(e) => {
            updateNote(note.id, { text: e.target.value });
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
          className="nodrag nowheel block min-h-12 w-full resize-none bg-transparent [field-sizing:content] outline-none"
        />
      ) : note.text ? (
        note.text
      ) : (
        <span className="text-(--nf-muted)">Double-click to write</span>
      )}
    </div>
  );
}

/** A labelled, tinted rectangle behind devices. Only its title bar and edges take the mouse. */
export function ZoneNode({ data, selected }: NodeProps<ZoneNodeType>) {
  const { zone } = data;
  const [editing, setEditing] = useState(false);
  const tint = `var(--nf-zone-${zone.tint + 1})`;
  return (
    <div
      data-testid={`zone-${zone.id}`}
      className="h-full w-full rounded-md border"
      style={{
        background: `color-mix(in srgb, ${tint} 14%, transparent)`,
        borderColor: selected ? 'var(--nf-accent)' : `color-mix(in srgb, ${tint} 55%, transparent)`,
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={LIMITS.zoneWidth.min}
        minHeight={LIMITS.zoneHeight.min}
        maxWidth={LIMITS.zoneWidth.max}
        maxHeight={LIMITS.zoneHeight.max}
      />
      <div className="nf-zone-title flex cursor-grab items-center gap-2 px-2.5 py-1.5">
        {editing ? (
          <input
            aria-label="Zone title"
            autoFocus
            defaultValue={zone.title}
            maxLength={LIMITS.zoneTitle}
            onBlur={(e) => {
              updateZone(zone.id, { title: e.target.value });
              setEditing(false);
            }}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
            className="nodrag min-w-0 flex-1 rounded-[4px] border border-(--nf-border) bg-(--nf-surface) px-1 font-(family-name:--font-label) text-[13px] font-medium"
          />
        ) : (
          <span
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
            className="min-w-0 flex-1 truncate font-(family-name:--font-label) text-[13px] font-medium"
          >
            {zone.title || 'Untitled zone'}
          </span>
        )}
        {selected && !editing && (
          <div role="group" aria-label="Zone tint" className="nodrag flex gap-1">
            {Array.from({ length: LIMITS.zoneTints }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Tint ${i + 1}`}
                aria-pressed={zone.tint === i}
                onClick={() => updateZone(zone.id, { tint: i })}
                className="h-3.5 w-3.5 rounded-[2px] border border-(--nf-border) aria-pressed:border-(--nf-text)"
                style={{ background: `var(--nf-zone-${i + 1})` }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
