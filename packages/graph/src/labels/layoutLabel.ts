import { LABEL_CONSTANTS } from "../data/Layouts";

const { LABEL_GLYPHS } = LABEL_CONSTANTS;

export const ELLIPSIS = 0x2026;

export interface TextRun {
  readonly codes: Uint32Array;
  readonly pens: Uint16Array;
  count: number;
  width: number;
}

export function createRun(): TextRun {
  return { codes: new Uint32Array(LABEL_GLYPHS), pens: new Uint16Array(LABEL_GLYPHS), count: 0, width: 0 };
}

const starts = new Float64Array(LABEL_GLYPHS + 1);

export function layoutLabel(text: string, advance: (code: number) => number, maxWidth: number, inset: number, run: TextRun): number {
  const limit = maxWidth - 2 * inset;
  let n = 0;
  let pen = 0;
  let cut = false;
  for (let k = 0; k < text.length; k++) {
    let code = text.charCodeAt(k);
    if (code >= 0xd800 && code < 0xdc00 && k + 1 < text.length) {
      code = text.codePointAt(k)!;
      k++;
    }
    const a = advance(code);
    if (n === LABEL_GLYPHS || pen + a > limit) {
      cut = true;
      break;
    }
    run.codes[n] = code;
    starts[n] = pen;
    n++;
    pen += a;
  }
  starts[n] = pen;
  if (cut) {
    const e = advance(ELLIPSIS);
    let m = Math.min(n, LABEL_GLYPHS - 1);
    while (m > 0 && starts[m]! + e > limit) m--;
    run.codes[m] = ELLIPSIS;
    starts[m + 1] = starts[m]! + e;
    n = m + 1;
    pen = starts[n]!;
  }
  for (let i = 0; i < n; i++) run.pens[i] = Math.round(starts[i]!);
  run.count = n;
  run.width = n === 0 ? 0 : Math.min(0xffff, Math.ceil(pen) + 2 * inset);
  return run.width;
}
