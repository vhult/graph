import type { ReactNode } from "react";
import { Inline } from "../render/Inline";
import { Link } from "../router";
import { Sidebar, type Area } from "./Sidebar";
import { ArchiveNote } from "./Versions";

export interface TocItem {
  id: string;
  label: string;
}

export function Shell({ area, path, toc = [], children }: { area: Area; path: string; toc?: TocItem[]; children: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar area={area} path={path} />
      <article className="doc">
        {area === "api" && <ArchiveNote path={path} />}
        {children}
      </article>
      <nav className="toc">
        {toc.length > 0 && (
          <>
            <p className="side-title">On this page</p>
            <ul>
              {toc.map((t) => (
                <li key={t.id}>
                  <Link href={`#${t.id}`}>
                    <Inline text={t.label} plain />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
    </div>
  );
}
