import { NodeShape, type Graph, type NodeStream } from "@vhult/graph";
import type { GraphDataset } from "@vhult/graph-bench";

export const DOOM = {
  url: "https://jacobenget.com/doom.wasm/examples/browser/assets/doom.wasm",
  source: "https://github.com/jacobenget/doom.wasm",
  bytes: 4_559_928,
  width: 320,
  height: 200,
  spacing: 4,
  tile: 0.9,
  rate: 35,
} as const;

const KEYS: readonly (readonly [string, string])[] = [
  ["ArrowLeft", "KEY_LEFTARROW"],
  ["ArrowRight", "KEY_RIGHTARROW"],
  ["ArrowUp", "KEY_UPARROW"],
  ["ArrowDown", "KEY_DOWNARROW"],
  [",", "KEY_STRAFE_L"],
  [".", "KEY_STRAFE_R"],
  ["Control", "KEY_FIRE"],
  [" ", "KEY_USE"],
  ["Shift", "KEY_SHIFT"],
  ["Tab", "KEY_TAB"],
  ["Escape", "KEY_ESCAPE"],
  ["Enter", "KEY_ENTER"],
  ["Backspace", "KEY_BACKSPACE"],
  ["Alt", "KEY_ALT"],
];

interface DoomExports {
  memory: WebAssembly.Memory;
  initGame(): void;
  tickGame(): void;
  reportKeyDown(key: number): void;
  reportKeyUp(key: number): void;
  [name: string]: unknown;
}

let compiled: WebAssembly.Module | null = null;

export function screen(): GraphDataset {
  const { width: w, height: h, spacing: s } = DOOM;
  const count = w * h;
  const positions = new Float32Array(count * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      positions[i * 2] = (x - w / 2) * s;
      positions[i * 2 + 1] = (y - h / 2) * s;
    }
  }
  return {
    nodes: {
      count,
      positions,
      colors: new Uint32Array(count).fill(0xff000000),
      sizes: new Float32Array(count).fill(s * DOOM.tile),
      shapes: new Uint8Array(count).fill(NodeShape.square),
    },
    edges: { count: 0, indices: new Uint32Array(0) },
  };
}

export function askToDownload(root: HTMLElement): Promise<boolean> {
  if (compiled) return Promise.resolve(true);
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "doom-panel";
    const title = document.createElement("div");
    title.className = "doom-title";
    title.textContent = "DOOM";
    const body = document.createElement("p");
    body.textContent = `This story runs Doom (1993) inside the graph: ${(DOOM.width * DOOM.height).toLocaleString("en-US")} square nodes, one per pixel, their colours streamed ${DOOM.rate} times a second.`;
    const from = document.createElement("p");
    const link = document.createElement("a");
    link.href = DOOM.source;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "doom.wasm";
    from.append(
      "Playing it downloads ",
      link,
      ` by Jacob Enget (${(DOOM.bytes / 1e6).toFixed(1)} MB, the shareware game, GPL-2.0) from jacobenget.com. Nothing is downloaded until you press the button.`,
    );
    const button = document.createElement("button");
    const spinner = document.createElement("span");
    spinner.className = "doom-spinner";
    const label = document.createElement("span");
    label.textContent = "Download and play";
    button.append(spinner, label);
    const status = document.createElement("p");
    status.className = "doom-status";
    el.append(title, body, from, button, status);
    root.append(el);
    button.onclick = () => {
      button.disabled = true;
      el.classList.add("doom-busy");
      status.textContent = "";
      label.textContent = "Downloading 0%";
      download((f) => (label.textContent = `Downloading ${Math.round(f * 100)}%`))
        .then((module) => {
          compiled = module;
          el.remove();
          resolve(root.isConnected);
        })
        .catch((e: unknown) => {
          el.classList.remove("doom-busy");
          button.disabled = false;
          label.textContent = "Try again";
          status.textContent = `Download failed: ${e instanceof Error ? e.message : String(e)}`;
        });
    };
  });
}

async function download(progress: (fraction: number) => void): Promise<WebAssembly.Module> {
  const res = await fetch(DOOM.url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || DOOM.bytes;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress(Math.min(1, got / total));
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return WebAssembly.compile(bytes);
}

export class DoomGame {
  private exports!: DoomExports;
  private readonly keys = new Map<string, number>();
  private readonly held = new Set<number>();
  private frameWidth = 0;
  private frameHeight = 0;
  private raf = 0;
  private last = 0;
  private due = 0;
  private stopped = false;

  private constructor(private readonly stream: NodeStream) {}

  static async start(graph: Graph): Promise<DoomGame> {
    if (!compiled) throw new Error("Doom is not downloaded");
    const game = new DoomGame(graph.streamNodes({ colors: true }));
    const text = (ptr: number, length: number) => new TextDecoder().decode(new Uint8Array(game.exports.memory.buffer, ptr, length).slice());
    const imports = {
      loading: {
        onGameInit: (width: number, height: number) => {
          game.frameWidth = width;
          game.frameHeight = height;
        },
        wadSizes: () => {},
        readWads: () => {},
      },
      ui: { drawFrame: (ptr: number) => game.draw(ptr) },
      runtimeControl: { timeInMilliseconds: () => BigInt(Math.trunc(performance.now())) },
      console: {
        onInfoMessage: () => {},
        onErrorMessage: (ptr: number, length: number) => console.error(`[Doom] ${text(ptr, length)}`),
      },
      gameSaving: { sizeOfSaveGame: () => 0, readSaveGame: () => 0, writeSaveGame: () => 0 },
    };
    const instance = await WebAssembly.instantiate(compiled, imports);
    game.exports = instance.exports as DoomExports;
    for (const [key, name] of KEYS) game.keys.set(key, (game.exports[name] as WebAssembly.Global).value as number);
    addEventListener("keydown", game.down, true);
    addEventListener("keyup", game.up, true);
    addEventListener("blur", game.release);
    game.exports.initGame();
    game.raf = requestAnimationFrame(game.tick);
    return game;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.release();
    removeEventListener("keydown", this.down, true);
    removeEventListener("keyup", this.up, true);
    removeEventListener("blur", this.release);
  }

  private readonly tick = (now: number): void => {
    if (this.stopped) return;
    const step = 1000 / DOOM.rate;
    this.due = Math.min(this.due + (this.last === 0 ? step : now - this.last), step * 3);
    this.last = now;
    while (this.due >= step) {
      this.exports.tickGame();
      this.due -= step;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(ptr: number): void {
    const fw = this.frameWidth;
    const fh = this.frameHeight;
    if (fw === 0 || fh === 0) return;
    const src = new Uint8Array(this.exports.memory.buffer, ptr, fw * fh * 4);
    const out = this.stream.colors;
    const { width: w, height: h } = DOOM;
    for (let y = 0; y < h; y++) {
      const row = Math.floor((y * fh) / h) * fw;
      for (let x = 0; x < w; x++) {
        const k = (row + Math.floor((x * fw) / w)) * 4;
        out[y * w + x] = src[k + 2]! | (src[k + 1]! << 8) | (src[k]! << 16) | 0xff000000;
      }
    }
    this.stream.commit();
  }

  private key(e: KeyboardEvent): number | null {
    const mapped = this.keys.get(e.key);
    if (mapped !== undefined) return mapped;
    return e.key.length === 1 ? e.key.toLowerCase().charCodeAt(0) : null;
  }

  private readonly down = (e: KeyboardEvent): void => {
    const k = this.key(e);
    if (k === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat || this.held.has(k)) return;
    this.held.add(k);
    this.exports.reportKeyDown(k);
  };

  private readonly up = (e: KeyboardEvent): void => {
    const k = this.key(e);
    if (k === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!this.held.delete(k)) return;
    this.exports.reportKeyUp(k);
  };

  private readonly release = (): void => {
    for (const k of this.held) this.exports.reportKeyUp(k);
    this.held.clear();
  };
}
