const NO_SLOTS = new Int32Array(0);

export class IndexUploads {
  private pairBuf = new Uint32Array(128);
  private vals = new Uint32Array(64);
  private slot = NO_SLOTS;
  private n = 0;
  private words = 1;

  get count(): number {
    return this.n;
  }

  get slotCapacity(): number {
    return this.slot.length;
  }

  add(indices: Uint32Array, words: Uint32Array, wordsPerItem: number, slots: number): void {
    this.words = wordsPerItem;
    let top = -1;
    for (let j = 0; j < indices.length; j++) if (indices[j]! > top) top = indices[j]!;
    if (top >= this.slot.length) {
      const next = new Int32Array(Math.max(top + 1, Math.min(this.slot.length * 2, slots)));
      next.set(this.slot);
      this.slot = next;
    }
    const slot = this.slot;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      let at = slot[i]! - 1;
      if (at < 0) {
        at = this.n++;
        slot[i] = at + 1;
        this.grow(this.n);
        this.pairBuf[at * 2] = i;
        this.pairBuf[at * 2 + 1] = at;
      }
      const src = j * wordsPerItem;
      const dst = at * wordsPerItem;
      for (let k = 0; k < wordsPerItem; k++) this.vals[dst + k] = words[src + k]!;
    }
  }

  pairs(): Uint32Array {
    return this.pairBuf.subarray(0, this.n * 2);
  }

  values(): Uint32Array {
    return this.vals.subarray(0, this.n * this.words);
  }

  clear(): void {
    const pairs = this.pairBuf;
    const slot = this.slot;
    for (let k = 0; k < this.n; k++) slot[pairs[k * 2]!] = 0;
    this.n = 0;
  }

  reset(slots: number): void {
    this.clear();
    if (this.slot.length > slots) this.slot = NO_SLOTS;
  }

  private grow(n: number): void {
    if (n * 2 > this.pairBuf.length) {
      const next = new Uint32Array(Math.max(n * 2, this.pairBuf.length * 2));
      next.set(this.pairBuf);
      this.pairBuf = next;
    }
    if (n * this.words > this.vals.length) {
      const next = new Uint32Array(Math.max(n * this.words, this.vals.length * 2));
      next.set(this.vals);
      this.vals = next;
    }
  }
}
