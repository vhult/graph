const EDGE_BIT = 0x80000000;

export interface LiveLabel {
  index: number;
  slot: number;
  run: number;
  start: number;
  fadeOut: boolean;
  mark: number;
}

export class LiveLabels {
  readonly entries: LiveLabel[] = [];
  added = 0;
  faded = 0;
  shownCount = 0;
  private readonly byIndex = new Map<number, LiveLabel>();
  private readonly free: number[] = [];
  private stamp = 0;

  constructor(
    private readonly slots: number,
    private readonly fadeS: number,
  ) {
    for (let s = slots - 1; s >= 0; s--) this.free.push(s);
  }

  clearEdges(): void {
    for (let k = this.entries.length - 1; k >= 0; k--) if ((this.entries[k]!.index & EDGE_BIT) !== 0) this.remove(k);
    this.countShown();
  }

  alpha(e: LiveLabel, now: number): number {
    const a = Math.min(1, Math.max(0, (now - e.start) / this.fadeS));
    return e.fadeOut ? 1 - a : a;
  }

  update(shown: Uint32Array, count: number, now: number, build: (user: number, slot: number, index: number) => number): void {
    const stamp = ++this.stamp;
    for (let k = 0; k < count; k++) {
      const e = this.byIndex.get(shown[2 * k]!);
      if (!e) continue;
      e.mark = stamp;
      if (e.fadeOut) {
        e.start = now - this.alpha(e, now) * this.fadeS;
        e.fadeOut = false;
      }
    }
    for (const e of this.entries) {
      if (e.mark === stamp || e.fadeOut) continue;
      e.start = now - (1 - this.alpha(e, now)) * this.fadeS;
      e.fadeOut = true;
      this.faded++;
    }
    for (let k = 0; k < count; k++) {
      const index = shown[2 * k]!;
      if (this.byIndex.has(index)) continue;
      const slot = this.takeSlot(now);
      if (slot < 0) return;
      const run = build(shown[2 * k + 1]!, slot, index);
      if (run === 0) {
        this.free.push(slot);
        continue;
      }
      const e: LiveLabel = { index, slot, run, start: now, fadeOut: false, mark: stamp };
      this.entries.push(e);
      this.byIndex.set(index, e);
      this.added++;
    }
    this.countShown();
  }

  private countShown(): void {
    this.shownCount = 0;
    for (const e of this.entries) if (!e.fadeOut) this.shownCount++;
  }

  settle(now: number): boolean {
    let removed = false;
    for (let k = this.entries.length - 1; k >= 0; k--) {
      const e = this.entries[k]!;
      if (e.fadeOut && this.alpha(e, now) === 0) {
        this.remove(k);
        removed = true;
      }
    }
    return removed;
  }

  animatingUntil(): number {
    let until = 0;
    for (const e of this.entries) until = Math.max(until, e.start + this.fadeS);
    return until;
  }

  clear(): void {
    for (let k = this.entries.length - 1; k >= 0; k--) this.remove(k);
    this.shownCount = 0;
  }

  private takeSlot(now: number): number {
    const slot = this.free.pop();
    if (slot !== undefined) return slot;
    let pick = -1;
    let lowest = Infinity;
    this.entries.forEach((e, k) => {
      if (!e.fadeOut) return;
      const a = this.alpha(e, now);
      if (a < lowest) {
        lowest = a;
        pick = k;
      }
    });
    if (pick < 0) return -1;
    this.remove(pick);
    return this.free.pop()!;
  }

  private remove(k: number): void {
    const e = this.entries[k]!;
    const last = this.entries.pop()!;
    if (last !== e) this.entries[k] = last;
    this.byIndex.delete(e.index);
    this.free.push(e.slot);
  }
}
