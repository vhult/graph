import type { SelectKey } from "../api/types";
import { MOD } from "../bridge/InputRing";

const NONE = new Uint32Array(0);

function minus(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length);
  let n = 0;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    while (j < b.length && b[j]! < v) j++;
    if (j >= b.length || b[j] !== v) out[n++] = v;
  }
  return out.subarray(0, n);
}

function union(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i]! : Infinity;
    const y = j < b.length ? b[j]! : Infinity;
    if (x <= y) {
      out[n++] = x;
      i++;
      if (x === y) j++;
    } else {
      out[n++] = y;
      j++;
    }
  }
  return out.subarray(0, n);
}

function sorted(list: Uint32Array): Uint32Array {
  const s = list.slice().sort();
  let n = 0;
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) s[n++] = s[i]!;
  return s.subarray(0, n);
}

export function shapeAdds(mods: number, key: SelectKey | null): boolean {
  if (key === "shift") return (mods & (MOD.CTRL | MOD.META)) !== 0;
  return (mods & MOD.SHIFT) !== 0;
}

export class Selection {
  added: Uint32Array = NONE;
  removed: Uint32Array = NONE;
  private list: Uint32Array = NONE;

  get nodes(): Uint32Array {
    return this.list;
  }

  load(nodes: Uint32Array): void {
    this.list = sorted(nodes);
    this.added = NONE;
    this.removed = NONE;
  }

  click(node: number | null, shift: boolean): void {
    if (node === null) {
      if (shift) this.set(this.list);
      else this.clear();
      return;
    }
    const one = Uint32Array.of(node);
    if (!shift) this.set(one);
    else if (this.has(node)) this.set(minus(this.list, one));
    else this.set(union(this.list, one));
  }

  shape(nodes: Uint32Array, shift: boolean): void {
    const inside = sorted(nodes);
    this.set(shift ? union(this.list, inside) : inside);
  }

  clear(): void {
    this.set(NONE);
  }

  private has(node: number): boolean {
    const l = this.list;
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (l[mid]! < node) lo = mid + 1;
      else hi = mid;
    }
    return lo < l.length && l[lo] === node;
  }

  private set(next: Uint32Array): void {
    this.added = minus(next, this.list);
    this.removed = minus(this.list, next);
    this.list = next;
  }
}
