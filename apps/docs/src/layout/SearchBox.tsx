import { useEffect, useRef, useState } from "react";

export const PLACEHOLDER = "Search the API  /";

type Search = typeof import("./Search").default;

let loaded: Search | undefined;
let loading: Promise<Search> | undefined;

function load(): Promise<Search> {
  loading ??= import("./Search").then((m) => (loaded = m.default));
  return loading;
}

export function SearchBox() {
  const box = useRef<HTMLDivElement>(null);
  const plain = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState<{ Search: Search; focus: boolean } | undefined>(() => (loaded ? { Search: loaded, focus: false } : undefined));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current?.querySelector("input");
      const target = e.target as HTMLElement | null;
      if (e.key !== "/" || !el || el.offsetParent === null) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const start = () => {
    load().then((Search) => setReady({ Search, focus: document.activeElement === plain.current }));
  };

  return (
    <div className="search" ref={box}>
      {ready ? (
        <ready.Search initial={query} focus={ready.focus} />
      ) : (
        <input
          ref={plain}
          className="search-input"
          placeholder={PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={start}
        />
      )}
    </div>
  );
}
