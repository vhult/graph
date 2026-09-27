import content from "virtual:content";
import type { Page } from "../content/types";
import { Shell } from "../layout/Shell";
import { Blocks, slug } from "../render/Blocks";
import { Inline } from "../render/Inline";
import { Link } from "../router";

const ORDER = content.site.docs.flatMap((s) => s.pages);

export function DocPage({ page, path }: { page: Page; path: string }) {
  const toc = page.blocks.flatMap((b) => ("heading" in b ? [{ id: slug(b.heading), label: b.heading }] : []));
  const at = ORDER.indexOf(page.id);
  const prev = at > 0 ? content.pages[ORDER[at - 1]] : undefined;
  const next = at < ORDER.length - 1 ? content.pages[ORDER[at + 1]] : undefined;
  return (
    <Shell area="docs" path={path} toc={toc}>
      <h1>{page.title}</h1>
      {page.description && (
        <p className="lead">
          <Inline text={page.description} />
        </p>
      )}
      <Blocks blocks={page.blocks} />
      <nav className="pager">
        {prev ? (
          <Link href={`/docs/${prev.id}`} className="pager-prev">
            <span>Previous</span>
            {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.id}`} className="pager-next">
            <span>Next</span>
            {next.title}
          </Link>
        )}
      </nav>
    </Shell>
  );
}
