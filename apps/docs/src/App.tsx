import content from "virtual:content";
import { useEffect, useRef, type ReactNode } from "react";
import { ApiContext, LATEST_API, useApiVersion, type Api } from "./content/api";
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
  api?: Api;
}

function route(path: string, api: Api | null | undefined): Route {
  if (path === "/") return { view: <Landing /> };
  const doc = /^\/docs\/([^/]+)\/?$/.exec(path);
  const page = doc ? content.pages[doc[1]] : undefined;
  if (page) return { view: <DocPage page={page} path={`/docs/${page.id}`} />, title: page.title };
  const ref = /^(?:\/v\d+)?\/api(?:\/([^/]+))?\/?$/.exec(path);
  if (ref && api === undefined) return { view: null };
  if (ref && api) {
    const suffix = api.latest ? "" : ` · ${api.version}`;
    if (!ref[1]) return { view: <ApiIndex path={api.base} />, title: `API reference${suffix}`, api };
    const entries = api.entriesOf(ref[1]);
    if (entries.length > 0) return { view: <ApiItem entries={entries} path={api.itemHref(entries[0].name)} />, title: `${entries[0].name}${suffix}`, api };
  }
  return { view: <NotFound />, title: "Page not found" };
}

export function App() {
  const { path, hash } = usePlace();
  const { view, title, api } = route(path, useApiVersion(/^\/(v\d+)\/api(\/|$)/.exec(path)?.[1]));
  const ready = view !== null;
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = title ? `${title} · ${content.site.name}` : `${content.site.name} · ${content.site.description}`;
  }, [title]);

  useEffect(() => {
    const target = hash ? document.getElementById(hash) : null;
    if (target) target.scrollIntoView();
    else scroll.current?.scrollTo(0, 0);
  }, [path, hash, ready]);

  return (
    <div className="frame">
      <Header path={path} />
      <div className="scroll" ref={scroll}>
        <main>
          <ApiContext value={api ?? LATEST_API}>{view}</ApiContext>
        </main>
        <footer className="footer">
          <Inline text={content.site.footer} />
        </footer>
      </div>
    </div>
  );
}
