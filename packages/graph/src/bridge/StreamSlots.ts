const READY = 0;
const HEADER_BYTES = 16;
const FRESH = 4;
const SLOT_MASK = 3;

export interface StreamSlot {
  positions: Float32Array;
  colors: Uint32Array;
  zIndex: Uint8Array;
  zWords: Uint32Array;
}

const zBytes = (count: number, zIndex: boolean): number => (zIndex ? Math.ceil(count / 4) * 4 : 0);
const slotBytes = (count: number, positions: boolean, colors: boolean, zIndex: boolean): number =>
  count * ((positions ? 2 : 0) + (colors ? 1 : 0)) * 4 + zBytes(count, zIndex);

export class StreamSlots {
  static create(count: number, positions: boolean, colors: boolean, zIndex = false): StreamSlots {
    const slots = new StreamSlots(new SharedArrayBuffer(HEADER_BYTES + 3 * slotBytes(count, positions, colors, zIndex)), count, positions, colors, zIndex);
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
    readonly zIndex = false,
  ) {
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    const bytes = slotBytes(count, positions, colors, zIndex);
    const words = positions ? count * 2 : 0;
    const colorWords = colors ? count : 0;
    this.slots = [0, 1, 2].map((k) => {
      const at = HEADER_BYTES + k * bytes;
      return {
        positions: new Float32Array(buffer, at, words),
        colors: new Uint32Array(buffer, at + words * 4, colorWords),
        zIndex: new Uint8Array(buffer, at + (words + colorWords) * 4, zIndex ? count : 0),
        zWords: new Uint32Array(buffer, at + (words + colorWords) * 4, zBytes(count, zIndex) / 4),
      };
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
