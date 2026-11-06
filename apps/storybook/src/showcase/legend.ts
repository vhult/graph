import { lineSample, type WheelLine } from "../wheel";

export interface LegendItem {
  label: string;
  color: string;
  icon?: string;
  line?: WheelLine;
}

export class Legend {
  private readonly el: HTMLElement;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "legend";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "legend-toggle";
    toggle.textContent = "Legend";
    toggle.addEventListener("click", () => this.el.classList.toggle("legend-open"));
    this.body = document.createElement("div");
    this.body.className = "legend-body";
    this.el.append(toggle, this.body);
    if (!window.matchMedia("(max-width: 640px)").matches) this.el.classList.add("legend-open");
    parent.append(this.el);
  }

  set(kinds: readonly LegendItem[], relations: readonly LegendItem[]): void {
    const row = (graphic: string, label: string, color = "") => {
      const r = document.createElement("div");
      r.className = "legend-row";
      const g = document.createElement("span");
      g.className = "legend-graphic";
      if (color) g.style.color = color;
      g.innerHTML = graphic;
      const t = document.createElement("span");
      t.textContent = label;
      r.append(g, t);
      return r;
    };
    this.body.replaceChildren(
      ...kinds.map((k) => row(k.icon ?? "", k.label, k.color)),
      ...relations.map((r) => row(r.line ? lineSample(r.line) : "", r.label)),
    );
  }
}
