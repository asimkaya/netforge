import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { TASKS } from '../tasks/tasks.ts';
import { continueTask } from './lab.ts';
import { PRIMARY, SECONDARY } from './styles.ts';
import type { Celebration as Info } from './taskProgress.ts';
import { Rich } from './taskParts.tsx';

const FOCUSABLE = 'button:not([disabled])';

/** Shown once when a guided chapter is finished. */
export function Celebration({
  info,
  onClose,
  onCenter,
  onStarted,
}: {
  info: Info;
  onClose: () => void;
  onCenter: () => void;
  onStarted: () => void;
}) {
  const heading = useId();
  const card = useRef<HTMLDivElement>(null);
  const at = TASKS.findIndex((t) => t.id === info.id);
  const task = TASKS[at];
  const following = TASKS[at + 1];

  useEffect(() => {
    const opener = document.activeElement;
    card.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  if (!task) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab' && card.current) {
      const items = [...card.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      const now = document.activeElement;
      if (!first || !last) return;
      if (e.shiftKey && (now === first || now === card.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && now === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 max-sm:items-end sm:p-6">
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="nf-pop w-full max-w-md space-y-3 border-t-4 border-(--nf-ok) bg-(--nf-surface) p-5 text-sm text-(--nf-text) shadow-xl outline-none sm:rounded-lg"
      >
        <h2 id={heading} className="text-xl font-semibold">
          Chapter complete!
        </h2>
        <p className="font-semibold">{task.title}</p>
        <p className="border-l-[3px] border-(--nf-ok) bg-(--nf-raised) p-3 text-xs">
          <Rich text={task.done} />
        </p>
        {info.promoted && (
          <p className="font-semibold text-(--nf-ok)">Promoted to {info.promoted}!</p>
        )}
        {following && <p className="text-xs text-(--nf-muted)">Unlocked: {following.title}</p>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          {following && (
            <button
              type="button"
              className={`${PRIMARY} col-span-2`}
              onClick={() => {
                continueTask(following.id);
                onStarted();
                onClose();
              }}
            >
              Next chapter: {following.title}
            </button>
          )}
          <button
            type="button"
            className={SECONDARY}
            onClick={() => {
              onClose();
              onCenter();
            }}
          >
            Open the Task center
          </button>
          <button type="button" className={SECONDARY} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
