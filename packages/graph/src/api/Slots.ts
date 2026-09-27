import { GraphError } from "./errors";

/** A freed slot in a `compact` table. */
export const NO_INDEX = 0xffffffff;

export class Slots {
  slots = 0;
  count = 0;
  private live = new Uint8Array(16);
  private free: number[] = [];
  private mark = new Uint8Array(16);

  reset(count: number): void {
    this.live = new Uint8Array(Math.max(16, count));
    this.live.fill(1, 0, count);
    this.mark = new Uint8Array(this.live.length);
    this.free = [];
    this.slots = count;
    this.count = count;
  }

  isLive(i: number): boolean {
    return i >= 0 && i < this.slots && this.live[i] === 1;
  }

  take(n: number, reuse = true): Uint32Array {
    const out = new Uint32Array(n);
    let k = 0;
    while (reuse && k < n && this.free.length > 0) out[k++] = this.free.pop()!;
    const need = this.slots + (n - k);
    if (need > this.live.length) {
      const next = new Uint8Array(Math.max(need, this.live.length * 2));
      next.set(this.live);
      this.live = next;
      this.mark = new Uint8Array(next.length);
    }
    while (k < n) out[k++] = this.slots++;
    for (let j = 0; j < n; j++) this.live[out[j]!] = 1;
    this.count += n;
    return out;
  }

  release(indices: ArrayLike<number>): void {
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      if (!this.isLive(i)) continue;
      this.live[i] = 0;
      this.free.push(i);
      this.count--;
    }
  }

  check(indices: ArrayLike<number>, name: string): void {
    let bad = "";
    let j = 0;
    for (; j < indices.length; j++) {
      const i = indices[j]!;
      if (!Number.isInteger(i) || !this.isLive(i)) {
        bad = `${name}: index ${i} is not a live slot`;
        break;
      }
      if (this.mark[i] === 1) {
        bad = `${name}: index ${i} is listed twice`;
        break;
      }
      this.mark[i] = 1;
    }
    for (let k = 0; k < j; k++) this.mark[indices[k]!] = 0;
    if (bad) throw new GraphError("invalid-argument", bad);
  }

  compact(): Uint32Array {
    const remap = new Uint32Array(this.slots).fill(NO_INDEX);
    let n = 0;
    for (let i = 0; i < this.slots; i++) if (this.live[i] === 1) remap[i] = n++;
    this.reset(n);
    return remap;
  }
}
