const READY = 0;
const HEADER_BYTES = 16;
const FRESH = 4;
const SLOT_MASK = 3;

export interface StreamSlot {
  positions: Float32Array;
  colors: Uint32Array;
}

const slotBytes = (count: number, positions: boolean, colors: boolean): number => count * ((positions ? 2 : 0) + (colors ? 1 : 0)) * 4;

export class StreamSlots {
  static create(count: number, positions: boolean, colors: boolean): StreamSlots {
    const slots = new StreamSlots(new SharedArrayBuffer(HEADER_BYTES + 3 * slotBytes(count, positions, colors)), count, positions, colors);
    Atomics.store(slots.header, READY, 1);
    return slots;
  }

  private readonly header: Int32Array;
  private readonly slots: readonly StreamSlot[];
  private back = 0;
  private front = 2;

  constructor(
    readonly buffer: SharedArrayBuffer,
    readonly count: number,
    readonly positions: boolean,
    readonly colors: boolean,
  ) {
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    const bytes = slotBytes(count, positions, colors);
    const words = positions ? count * 2 : 0;
    this.slots = [0, 1, 2].map((k) => {
      const at = HEADER_BYTES + k * bytes;
      return { positions: new Float32Array(buffer, at, words), colors: new Uint32Array(buffer, at + words * 4, colors ? count : 0) };
    });
  }

  get data(): StreamSlot {
    return this.slots[this.back]!;
  }

  commit(): void {
    this.back = Atomics.exchange(this.header, READY, this.back | FRESH) & SLOT_MASK;
  }

  get pending(): boolean {
    return (Atomics.load(this.header, READY) & FRESH) !== 0;
  }

  take(): StreamSlot | null {
    if (!this.pending) return null;
    this.front = Atomics.exchange(this.header, READY, this.front) & SLOT_MASK;
    return this.slots[this.front]!;
  }
}
