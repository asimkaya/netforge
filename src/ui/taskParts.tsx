import { useState, type ReactNode } from 'react';
import { getLab } from './lab.ts';
import { PRIMARY, SECONDARY } from './styles.ts';

export function Check({ label }: { label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  );
}

/** Renders `code` spans inside task text. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded-sm bg-(--nf-raised) px-1 font-mono text-[12px]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * A button for actions that replace the lab. With devices on the canvas it first asks,
 * right where it was clicked, instead of opening a browser dialog. With `keep` it offers a
 * third way: carry on with the network that is there.
 */
export function ReplaceButton({
  onConfirm,
  label,
  keep,
  replaceLabel = 'Replace',
  primary = false,
  children,
}: {
  onConfirm: () => void;
  /** Accessible name, when the visible text alone does not say what it starts. */
  label?: string;
  keep?: { label: string; onKeep: () => void };
  replaceLabel?: string;
  /** The emphasised look, for the one action the learner should take next. */
  primary?: boolean;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className={primary ? PRIMARY : SECONDARY}
        aria-label={label}
        onClick={() => (getLab().net.devices.size === 0 ? onConfirm() : setAsking(true))}
      >
        {children}
      </button>
    );
  }
  const answer = (action: () => void) => () => {
    setAsking(false);
    action();
  };
  return (
    <div
      role="alertdialog"
      aria-label={
        keep ? 'Which network should the task use?' : 'Replace the network on the canvas?'
      }
      className="w-full space-y-2 border-l-[3px] border-(--nf-warn) bg-(--nf-raised) p-2 text-xs"
    >
      <p>
        {keep
          ? 'There are devices on the canvas. Work on them, or start from the network this task expects? Loading it replaces yours; Undo brings yours back.'
          : 'This replaces the network on the canvas. Undo brings it back.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {keep && (
          <button type="button" className={PRIMARY} onClick={answer(keep.onKeep)}>
            {keep.label}
          </button>
        )}
        <button type="button" className={keep ? SECONDARY : PRIMARY} onClick={answer(onConfirm)}>
          {replaceLabel}
        </button>
        <button type="button" className={SECONDARY} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A step number that turns into a check mark when done. */
export function Marker({ n, state }: { n: number; state: 'done' | 'current' | 'todo' }) {
  const look =
    state === 'done'
      ? 'border-(--nf-accent) bg-(--nf-accent) text-(--nf-on-accent)'
      : state === 'current'
        ? 'border-(--nf-accent) text-(--nf-text)'
        : 'border-(--nf-border) text-(--nf-muted)';
  return (
    <span
      aria-hidden
      className={`font-label grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-[11px] leading-none font-semibold ${look}`}
    >
      {state === 'done' ? <Check /> : n}
    </span>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-1 overflow-hidden bg-(--nf-raised)" aria-hidden>
      <div
        className="h-full bg-(--nf-accent) transition-all"
        style={{ width: `${(Math.min(value, max) / max) * 100}%` }}
      />
    </div>
  );
}
