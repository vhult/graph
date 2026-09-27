const NO_BITS = new Uint32Array(0);

export class LookList {
  list = new Uint32Array(16);
  count = 0;
  live = 0;
  version = 0;
  private listed = NO_BITS;

  constructor(
    private readonly bit: number,
    private readonly gone: number,
  ) {}

  private has(state: number): boolean {
    return (state & (this.bit | this.gone)) === this.bit;
  }

  update(i: number, old: number, next: number): void {
    const was = this.has(old);
    if (was === this.has(next)) return;
    if (was) {
      this.live--;
      return;
    }
    this.live++;
    const w = i >>> 5;
    const m = 1 << (i & 31);
    if (w >= this.listed.length) {
      const next = new Uint32Array(Math.max(w + 1, this.listed.length * 2));
      next.set(this.listed);
      this.listed = next;
    }
    const bits = this.listed[w]!;
    if ((bits & m) !== 0) return;
    this.listed[w] = bits | m;
    if (this.count === this.list.length) {
      const list = new Uint32Array(this.list.length * 2);
      list.set(this.list);
      this.list = list;
    }
    this.list[this.count++] = i;
    this.version++;
  }

  compact(state: Uint32Array): void {
    if (this.live === 0) {
      if (this.count > 0) this.reset();
      return;
    }
    if (this.count - this.live <= this.live) return;
    const list = this.list;
    let k = 0;
    for (let j = 0; j < this.count; j++) {
      const i = list[j]!;
      if (this.has(state[i] ?? 0)) list[k++] = i;
      else this.listed[i >>> 5] = this.listed[i >>> 5]! & ~(1 << (i & 31));
    }
    this.count = k;
    this.version++;
  }

  reset(): void {
    for (let j = 0; j < this.count; j++) this.listed[this.list[j]! >>> 5] = 0;
    this.count = 0;
    this.live = 0;
    this.version++;
  }

  entries(state: Uint32Array): Uint32Array {
    const out = new Uint32Array(this.live);
    let k = 0;
    for (let j = 0; j < this.count; j++) if (this.has(state[this.list[j]!] ?? 0)) out[k++] = this.list[j]!;
    return out;
  }
}
