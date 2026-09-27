import api from "virtual:api";
import content from "virtual:content";
import { useEffect, useRef, type ReactNode } from "react";
import { Header } from "./layout/Header";
import { ApiIndex } from "./pages/ApiIndex";
import { ApiItem } from "./pages/ApiItem";
import { DocPage } from "./pages/DocPage";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { Inline } from "./render/Inline";
import { usePlace } from "./router";

interface Route {
  view: ReactNode;
  title?: string;
}

function route(path: string): Route {
  if (path === "/") return { view: <Landing /> };
  if (path === "/api" || path === "/api/") return { view: <ApiIndex path="/api" />, title: "API reference" };
  const doc = /^\/docs\/([^/]+)\/?$/.exec(path);
  const page = doc ? content.pages[doc[1]] : undefined;
  if (page) return { view: <DocPage page={page} path={`/docs/${page.id}`} />, title: page.title };
  const item = /^\/api\/([^/]+)\/?$/.exec(path);
  const entries = item ? api.entries.filter((e) => e.name === item[1]) : [];
  if (entries.length > 0) return { view: <ApiItem entries={entries} path={`/api/${entries[0].name}`} />, title: entries[0].name };
  return { view: <NotFound />, title: "Page not found" };
}

export function App() {
  const { path, hash } = usePlace();
  const { view, title } = route(path);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = title ? `${title} · ${content.site.name}` : `${content.site.name} · ${content.site.description}`;
  }, [title]);

  useEffect(() => {
    const target = hash ? document.getElementById(hash) : null;
    if (target) target.scrollIntoView();
    else scroll.current?.scrollTo(0, 0);
  }, [path, hash]);

  return (
    <div className="frame">
      <Header path={path} />
      <div className="scroll" ref={scroll}>
        <main>{view}</main>
        <footer className="footer">
          <Inline text={content.site.footer} />
        </footer>
      </div>
    </div>
  );
}
