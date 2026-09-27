const NO_BITS = new Uint32Array(0);

export class IndexUploads {
  private bits = NO_BITS;
  private items = new Uint32Array(64);
  private n = 0;

  get count(): number {
    return this.n;
  }

  get capacity(): number {
    return this.bits.length * 32;
  }

  get list(): Uint32Array {
    return this.items;
  }

  add(indices: Uint32Array): void {
    if (indices.length === 0) return;
    let top = 0;
    for (let j = 0; j < indices.length; j++) if (indices[j]! > top) top = indices[j]!;
    if (top >>> 5 >= this.bits.length) {
      const next = new Uint32Array(Math.max((top >>> 5) + 1, this.bits.length * 2));
      next.set(this.bits);
      this.bits = next;
    }
    if (this.n + indices.length > this.items.length) {
      const next = new Uint32Array(Math.max(this.n + indices.length, this.items.length * 2));
      next.set(this.items);
      this.items = next;
    }
    const bits = this.bits;
    const items = this.items;
    let n = this.n;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      const w = i >>> 5;
      const m = 1 << (i & 31);
      if ((bits[w]! & m) !== 0) continue;
      bits[w] = bits[w]! | m;
      items[n++] = i;
    }
    this.n = n;
  }

  clear(): void {
    for (let k = 0; k < this.n; k++) this.bits[this.items[k]! >>> 5] = 0;
    this.n = 0;
  }

  reset(slots: number): void {
    this.clear();
    if (this.bits.length > (slots + 31) >>> 5) this.bits = NO_BITS;
  }
}
