import content from "virtual:content";
import { useEffect, useRef, useState } from "react";
import { labelOf } from "../content/api";
import { Link } from "../router";

export type Area = "docs" | "api";

interface Item {
  label: string;
  href: string;
  code: boolean;
}

interface Part {
  title?: string;
  items: Item[];
}

interface Group {
  title: string;
  fold: boolean;
  parts: Part[];
}

function apiItem(name: string): Item {
  return { label: labelOf(name), href: `/api/${name}`, code: true };
}

function groups(area: Area): Group[] {
  if (area === "docs") {
    return content.site.docs.map((s) => ({
      title: s.section,
      fold: false,
      parts: [{ items: s.pages.map((id) => ({ label: content.pages[id].title, href: `/docs/${id}`, code: false })) }],
    }));
  }
  return [
    { title: "Reference", fold: false, parts: [{ items: [{ label: "Overview", href: "/api", code: false }] }] },
    ...content.api.map((g) => ({
      title: g.title,
      fold: true,
      parts: [
        { items: g.namespace ? [apiItem(g.namespace)] : [] },
        { title: "Types", items: g.types.map(apiItem) },
        { title: "Values", items: g.values.map(apiItem) },
      ].filter((p) => p.items.length > 0),
    })),
  ];
}

function holds(g: Group, path: string): boolean {
  return g.parts.some((p) => p.items.some((i) => i.href === path));
}

interface ListProps {
  list: Group[];
  path: string;
  open: Set<string>;
  toggle: (title: string) => void;
}

function List({ list, path, open, toggle }: ListProps) {
  return (
    <>
      {list.map((g) => {
        const shown = !g.fold || open.has(g.title);
        return (
          <div key={g.title} className="side-group">
            {g.fold ? (
              <button type="button" className={shown ? "side-title side-fold open" : "side-title side-fold"} onClick={() => toggle(g.title)}>
                {g.title}
              </button>
            ) : (
              <p className="side-title">{g.title}</p>
            )}
            {shown &&
              g.parts.map((part, i) => (
                <div key={i} className="side-part">
                  {part.title && <p className="side-sub">{part.title}</p>}
                  <ul>
                    {part.items.map((l) => (
                      <li key={l.href}>
                        <Link href={l.href} className={path === l.href ? "active" : undefined}>
                          {l.code ? <code>{l.label}</code> : l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({ area, path }: { area: Area; path: string }) {
  const aside = useRef<HTMLElement>(null);
  const list = groups(area);
  const [open, setOpen] = useState(() => new Set(list.filter((g) => holds(g, path)).map((g) => g.title)));
  const [seen, setSeen] = useState(path);

  if (seen !== path) {
    setSeen(path);
    const current = list.find((g) => g.fold && holds(g, path));
    if (current && !open.has(current.title)) setOpen(new Set(open).add(current.title));
  }

  useEffect(() => {
    const el = aside.current;
    const item = el?.querySelector<HTMLElement>("a.active");
    if (!el || !item) return;
    const top = item.offsetTop;
    if (top < el.scrollTop || top + item.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 3;
  }, [area, path]);

  const toggle = (title: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(title)) next.add(title);
      return next;
    });

  return (
    <>
      <aside className="sidebar" ref={aside}>
        <List list={list} path={path} open={open} toggle={toggle} />
      </aside>
      <details className="side-menu">
        <summary>Menu</summary>
        <List list={list} path={path} open={open} toggle={toggle} />
      </details>
    </>
  );
}
