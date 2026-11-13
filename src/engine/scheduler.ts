/**
 * Discrete-event scheduler with a virtual clock (milliseconds).
 * Events at the same time run in the order they were scheduled, so a
 * simulation is fully deterministic.
 */
export class Scheduler {
  #now = 0;
  #seq = 0;
  #heap: { at: number; seq: number; run: () => void }[] = [];
  /** Sequence numbers of cancelled events still sitting in the heap. */
  #cancelled = new Set<number>();

  get now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#heap.length - this.#cancelled.size;
  }

  /** Schedule `run` to fire `delay` ms after the current virtual time. Returns a handle. */
  schedule(delay: number, run: () => void): number {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(`delay must be a finite number >= 0, got ${delay}`);
    }
    const seq = this.#seq++;
    this.#heap.push({ at: this.#now + delay, seq, run });
    this.#siftUp(this.#heap.length - 1);
    return seq;
  }

  /** Cancels a scheduled event. Unknown or already-run handles are ignored. */
  cancel(handle: number): void {
    if (this.#heap.some((e) => e.seq === handle)) this.#cancelled.add(handle);
  }

  /** Run the next event. Returns false when the queue is empty. */
  step(): boolean {
    this.#dropCancelled();
    const next = this.#pop();
    if (!next) return false;
    this.#now = next.at;
    next.run();
    return true;
  }

  /** Run every event due at or before `time`, then set the clock to `time`. */
  runUntil(time: number): void {
    this.#dropCancelled();
    while (this.#heap[0] && this.#heap[0].at <= time) {
      this.step();
      this.#dropCancelled();
    }
    this.#now = Math.max(this.#now, time);
  }

  #dropCancelled(): void {
    for (let top = this.#heap[0]; top && this.#cancelled.has(top.seq); top = this.#heap[0]) {
      this.#cancelled.delete(top.seq);
      this.#pop();
    }
  }

  #less(a: number, b: number): boolean {
    const x = this.#heap[a];
    const y = this.#heap[b];
    if (!x || !y) return false;
    return x.at < y.at || (x.at === y.at && x.seq < y.seq);
  }

  #swap(a: number, b: number): void {
    const x = this.#heap[a];
    const y = this.#heap[b];
    if (!x || !y) return;
    this.#heap[a] = y;
    this.#heap[b] = x;
  }

  #siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(i, parent)) return;
      this.#swap(i, parent);
      i = parent;
    }
  }

  #pop() {
    const heap = this.#heap;
    const top = heap[0];
    const last = heap.pop();
    if (top && last && heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let min = i;
        if (l < heap.length && this.#less(l, min)) min = l;
        if (r < heap.length && this.#less(r, min)) min = r;
        if (min === i) break;
        this.#swap(i, min);
        i = min;
      }
    }
    return top;
  }
}
