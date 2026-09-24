const READY = 0;
const HEADER_BYTES = 16;
const FRESH = 4;
const SLOT_MASK = 3;

export class PositionStream {
  static create(count: number): PositionStream {
    const stream = new PositionStream(new SharedArrayBuffer(HEADER_BYTES + 3 * count * 8), count);
    Atomics.store(stream.header, READY, 1);
    return stream;
  }

  private readonly header: Int32Array;
  private readonly slots: readonly Float32Array[];
  private back = 0;
  private front = 2;

  constructor(
    readonly buffer: SharedArrayBuffer,
    readonly count: number,
  ) {
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.slots = [0, 1, 2].map((k) => new Float32Array(buffer, HEADER_BYTES + k * count * 8, count * 2));
  }

  get positions(): Float32Array {
    return this.slots[this.back]!;
  }

  commit(): void {
    this.back = Atomics.exchange(this.header, READY, this.back | FRESH) & SLOT_MASK;
  }

  get pending(): boolean {
    return (Atomics.load(this.header, READY) & FRESH) !== 0;
  }

  take(): Float32Array | null {
    if (!this.pending) return null;
    this.front = Atomics.exchange(this.header, READY, this.front) & SLOT_MASK;
    return this.slots[this.front]!;
  }
}
