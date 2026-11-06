import content from "virtual:content";
import { useEffect, useRef, useState } from "react";
import { useApi, type Api } from "../content/api";
import { Link } from "../router";
import { SearchBox } from "./SearchBox";
import { VersionPicker } from "./Versions";

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

function apiItem(api: Api, name: string): Item {
  return { label: api.labelOf(name), href: api.itemHref(name), code: true };
}

function groups(area: Area, api: Api): Group[] {
  if (area === "docs") {
    return content.site.docs.map((s) => ({
      title: s.section,
      fold: false,
      parts: [{ items: s.pages.map((id) => ({ label: content.pages[id].title, href: `/docs/${id}`, code: false })) }],
    }));
  }
  return [
    { title: "Reference", fold: false, parts: [{ items: [{ label: "Overview", href: api.base, code: false }] }] },
    ...api.groups.map((g) => ({
      title: g.title,
      fold: true,
      parts: [
        { items: g.namespace ? [apiItem(api, g.namespace)] : [] },
        { title: "Types", items: g.types.map((name) => apiItem(api, name)) },
        { title: "Values", items: g.values.map((name) => apiItem(api, name)) },
      ].filter((p) => p.items.length > 0),
    })),
  ];
}

function partKey(g: Group, part: Part): string {
  return `${g.title}/${part.title}`;
}

function openKeys(list: Group[], path: string): string[] {
  const keys: string[] = [];
  for (const g of list) {
    for (const part of g.parts) {
      if (!part.items.some((i) => i.href === path)) continue;
      if (g.fold) keys.push(g.title);
      if (part.title) keys.push(partKey(g, part));
    }
  }
  return keys;
}

interface ListProps {
  list: Group[];
  path: string;
  open: Set<string>;
  toggle: (key: string) => void;
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
              g.parts.map((part, i) => {
                const key = partKey(g, part);
                const items = !part.title || open.has(key);
                return (
                  <div key={i} className="side-part">
                    {part.title && (
                      <button type="button" className={items ? "side-sub side-fold open" : "side-sub side-fold"} onClick={() => toggle(key)}>
                        {part.title}
                      </button>
                    )}
                    {items && (
                      <ul>
                        {part.items.map((l) => (
                          <li key={l.href}>
                            <Link href={l.href} className={path === l.href ? "active" : undefined}>
                              {l.code ? <code>{l.label}</code> : l.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </>
  );
}

function Menu({ area, ...props }: ListProps & { area: Area }) {
  if (area !== "api") return <List {...props} />;
  return (
    <>
      <List {...props} list={props.list.slice(0, 1)} />
      <SearchBox />
      <List {...props} list={props.list.slice(1)} />
    </>
  );
}

export function Sidebar({ area, path }: { area: Area; path: string }) {
  const aside = useRef<HTMLElement>(null);
  const api = useApi();
  const list = groups(area, api);
  const [open, setOpen] = useState(() => new Set(openKeys(list, path)));
  const [seen, setSeen] = useState(path);

  if (seen !== path) {
    setSeen(path);
    const keys = openKeys(list, path).filter((k) => !open.has(k));
    if (keys.length > 0) setOpen(new Set([...open, ...keys]));
  }

  useEffect(() => {
    const el = aside.current;
    const item = el?.querySelector<HTMLElement>("a.active");
    if (!el || !item) return;
    const top = item.offsetTop;
    if (top < el.scrollTop || top + item.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 3;
  }, [area, path]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <aside className="sidebar" ref={aside}>
        {area === "api" && <VersionPicker path={path} />}
        <Menu area={area} list={list} path={path} open={open} toggle={toggle} />
      </aside>
      <details className="side-menu">
        <summary>Menu</summary>
        {area === "api" && <VersionPicker path={path} />}
        <Menu area={area} list={list} path={path} open={open} toggle={toggle} />
      </details>
    </>
  );
}
