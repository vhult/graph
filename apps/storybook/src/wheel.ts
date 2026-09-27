import type { Graph, Hit } from "@vhult/graph";

export interface WheelLine {
  pattern?: "solid" | "dashed" | "dotted" | "dashDot" | "double";
  tapered?: boolean;
  directed?: boolean;
  width: number;
  color: string;
}

export interface WheelPick {
  from: number;
  line: WheelLine;
  prompt: string;
  done: (target: number) => void;
}

export interface WheelAction {
  label: string;
  color: string;
  icon?: string;
  line?: WheelLine;
  danger?: boolean;
  current?: boolean;
  run: () => WheelPick | void;
}

export interface WheelMenu {
  title: string;
  items: readonly WheelAction[];
}

export interface WheelOptions {
  menu: (hit: Hit) => WheelMenu | null;
  position: (node: number) => { x: number; y: number } | null;
}

export interface Wheel {
  readonly busy: boolean;
  detach(): void;
}

const SVG = "http://www.w3.org/2000/svg";
const INNER = 42;
const MARGIN = 8;
const CHAR_PX = 5.4;
const DANGER = "#ff6b6b";
const TRASH = `<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M9 2h6l1 2h5v2H3V4h5zM5 8h14l-1.2 14H6.2zM9 11v8h1.6v-8zM13.4 11v8H15v-8z"/></svg>`;
const DASH: Record<string, (u: number) => string> = {
  dashed: (u) => `${3 * u} ${2 * u}`,
  dotted: (u) => `0 ${2 * u}`,
  dashDot: (u) => `${3 * u} ${1.5 * u} 0 ${1.5 * u}`,
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function fit(text: string, px: number, charPx = CHAR_PX): string {
  const max = Math.max(3, Math.floor(px / charPx));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function lineShape(x1: number, y1: number, x2: number, y2: number, line: WheelLine): string {
  const w = Math.max(line.width, 1);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const u = Math.max(w, 2);
  const c = line.color;
  let body: string;
  if (line.tapered) {
    const a = w / 2;
    const b = w / 8;
    body = `<polygon fill="${c}" points="${x1 + nx * a},${y1 + ny * a} ${x2 + nx * b},${y2 + ny * b} ${x2 - nx * b},${y2 - ny * b} ${x1 - nx * a},${y1 - ny * a}"/>`;
  } else if (line.pattern === "double") {
    const o = w / 3;
    const seg = (s: number) => `<line x1="${x1 + nx * o * s}" y1="${y1 + ny * o * s}" x2="${x2 + nx * o * s}" y2="${y2 + ny * o * s}" stroke="${c}" stroke-width="${w / 3}"/>`;
    body = seg(1) + seg(-1);
  } else {
    const dash = DASH[line.pattern ?? "solid"]?.(u);
    const cap = line.pattern === "dotted" || line.pattern === "dashDot" ? "round" : "butt";
    body = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="${cap}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
  }
  if (!line.directed) return body;
  const h = Math.max(w * 2.5, 7);
  const bx = x2 - ((x2 - x1) / len) * h;
  const by = y2 - ((y2 - y1) / len) * h;
  return body + `<polygon fill="${c}" points="${x2},${y2} ${bx + nx * h * 0.5},${by + ny * h * 0.5} ${bx - nx * h * 0.5},${by - ny * h * 0.5}"/>`;
}

export function lineSample(line: WheelLine, width = 36, height = 14): string {
  const y = height / 2;
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${lineShape(2, y, width - 2, y, line)}</svg>`;
}

function slicePath(i: number, n: number, r0: number, r1: number): string {
  if (n === 1) return `M0 ${-r1}A${r1} ${r1} 0 1 1 0 ${r1}A${r1} ${r1} 0 1 1 0 ${-r1}ZM0 ${-r0}A${r0} ${r0} 0 1 0 0 ${r0}A${r0} ${r0} 0 1 0 0 ${-r0}Z`;
  const step = (Math.PI * 2) / n;
  const a0 = -Math.PI / 2 + (i - 0.5) * step;
  const a1 = a0 + step;
  const p = (a: number, r: number) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  const large = step > Math.PI ? 1 : 0;
  return `M${p(a0, r1)}A${r1} ${r1} 0 ${large} 1 ${p(a1, r1)}L${p(a1, r0)}A${r0} ${r0} 0 ${large} 0 ${p(a0, r0)}Z`;
}

function centerText(text: string): string {
  const lines = text.split("\n").slice(0, 2);
  const width = (INNER - 7) * 2;
  const top = lines.length === 1 ? 4 : -3;
  return lines.map((l, k) => `<tspan x="0" y="${top + k * 13}"${k > 0 ? ' class="wheel-center-sub"' : ""}>${escape(fit(l, width, k > 0 ? 4.9 : 6.2))}</tspan>`).join("");
}

export function attachWheel(graph: Graph, root: HTMLElement, opts: WheelOptions): Wheel {
  let state: "idle" | "open" | "picking" | "ending" = "idle";
  let touch = false;
  let menu: HTMLElement | null = null;
  let pick: WheelPick | null = null;
  let pointer = { x: 0, y: 0 };

  const layer = document.createElement("div");
  layer.className = "wheel-layer";
  const link = document.createElementNS(SVG, "svg");
  link.classList.add("wheel-link");
  const toast = document.createElement("div");
  toast.className = "wheel-toast";
  layer.append(link, toast);
  root.append(layer);

  const local = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const drawLink = () => {
    const p = pick ? opts.position(pick.from) : null;
    if (state !== "picking" || !pick || !p) {
      link.innerHTML = "";
      return;
    }
    const s = graph.camera.toScreen(p.x, p.y);
    link.innerHTML = `<circle class="wheel-link-from" cx="${s.x}" cy="${s.y}" r="10"/>` + lineShape(s.x, s.y, pointer.x, pointer.y, { ...pick.line, width: Math.max(pick.line.width, 2) });
  };

  const close = () => {
    menu?.remove();
    menu = null;
    if (state === "open") state = "idle";
  };

  const endPick = () => {
    state = "ending";
    pick = null;
    link.innerHTML = "";
    toast.classList.remove("wheel-toast-on");
    queueMicrotask(() => {
      if (state === "ending") state = "idle";
    });
  };

  const startPick = (p: WheelPick, at: { x: number; y: number }) => {
    state = "picking";
    pick = p;
    pointer = at;
    toast.textContent = touch ? `Tap a node to ${p.prompt} · tap empty space to cancel` : `Click a node to ${p.prompt} · Esc or empty space cancels`;
    toast.classList.add("wheel-toast-on");
    drawLink();
  };

  const open = (h: Hit) => {
    close();
    if (state === "picking") endPick();
    const m = opts.menu(h);
    if (!m || m.items.length === 0) return;
    state = "open";
    const items = m.items;
    const n = items.length;
    const outer = n <= 4 ? 88 : n <= 6 ? 100 : 116;
    const w = root.clientWidth;
    const hgt = root.clientHeight;
    const reach = outer + MARGIN;
    const cx = Math.min(Math.max(h.screenX, reach), Math.max(reach, w - reach));
    const cy = Math.min(Math.max(h.screenY, reach), Math.max(reach, hgt - reach));
    const mid = (INNER + outer) / 2;
    const step = (Math.PI * 2) / n;
    const room = n === 1 ? outer : Math.min(2 * (mid + 13) * Math.sin(step / 2), outer) - 8;

    const backdrop = document.createElement("div");
    backdrop.className = "wheel-backdrop";
    let pressed = false;
    backdrop.addEventListener("pointerdown", (e) => {
      pressed = true;
      if (e.target === backdrop) {
        e.preventDefault();
        close();
      }
    });
    backdrop.addEventListener("contextmenu", (e) => e.preventDefault());

    const svg = document.createElementNS(SVG, "svg");
    svg.classList.add("wheel");
    const size = outer * 2 + 8;
    svg.setAttribute("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.style.left = `${cx - size / 2}px`;
    svg.style.top = `${cy - size / 2}px`;
    let html = "";
    items.forEach((item, i) => {
      const a = -Math.PI / 2 + i * step;
      const x = n === 1 ? 0 : Math.cos(a) * mid;
      const y = n === 1 ? -mid : Math.sin(a) * mid;
      const color = item.danger ? DANGER : item.color;
      const graphic = item.line
        ? `<g transform="translate(${x - 15} ${y - 13})">${lineShape(0, 6, 30, 6, { ...item.line, width: Math.min(Math.max(item.line.width, 2), 5) })}</g>`
        : (item.icon ?? (item.danger ? TRASH : "")).replace(/^<svg /, `<svg x="${x - 10}" y="${y - 19}" width="20" height="20" color="${color}" `);
      const label = `${item.current ? "✓ " : ""}${item.label}`;
      const cls = `wheel-slice${item.danger ? " wheel-danger" : ""}${item.current ? " wheel-current" : ""}`;
      html +=
        `<g class="${cls}" data-i="${i}" style="--c:${color}"><path d="${slicePath(i, n, INNER, outer)}"/>` +
        `${graphic}<text x="${x}" y="${y + 13}">${escape(fit(label, room))}</text></g>`;
    });
    html += `<g class="wheel-center"><circle r="${INNER - 4}"/><text>${centerText(m.title)}</text></g>`;
    svg.innerHTML = html;
    const center = svg.querySelector(".wheel-center text")!;
    const sliceOf = (e: Event) => (e.target as Element).closest<SVGGElement>(".wheel-slice");
    svg.addEventListener("pointerover", (e) => {
      const g = sliceOf(e);
      if (g) center.innerHTML = centerText(items[Number(g.dataset.i)]!.label);
    });
    svg.addEventListener("pointerout", (e) => {
      if (sliceOf(e)) center.innerHTML = centerText(m.title);
    });
    svg.addEventListener("click", (e) => {
      if (!pressed) return;
      const g = sliceOf(e);
      if (!g) {
        if ((e.target as Element).closest(".wheel-center")) close();
        return;
      }
      const item = items[Number(g.dataset.i)]!;
      if (item.current) return;
      close();
      const next = item.run();
      if (next) startPick(next, { x: h.screenX, y: h.screenY });
    });
    backdrop.append(svg);
    layer.append(backdrop);
    menu = backdrop;
  };

  const offMenu = graph.on("contextMenu", open);
  const offClick = graph.on("click", (h) => {
    if (state !== "picking" || !pick) return;
    const p = pick;
    endPick();
    if (h.node !== null && h.node !== p.from) p.done(h.node);
  });
  const offView = graph.on("view", () => {
    if (state === "picking") drawLink();
  });
  const onDown = (e: PointerEvent) => {
    touch = e.pointerType !== "mouse";
    if (state === "picking") {
      pointer = local(e);
      drawLink();
    }
  };
  const onMove = (e: PointerEvent) => {
    if (state !== "picking") return;
    pointer = local(e);
    drawLink();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (menu) close();
    else if (state === "picking") endPick();
  };
  root.addEventListener("pointerdown", onDown, true);
  root.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("keydown", onKey);

  return {
    get busy() {
      return state !== "idle";
    },
    detach() {
      offMenu();
      offClick();
      offView();
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
      layer.remove();
    },
  };
}
