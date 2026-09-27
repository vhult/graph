import { useApi } from "../content/api";
import { Shell } from "../layout/Shell";
import { Blocks, slug } from "../render/Blocks";
import { Inline } from "../render/Inline";

export function ApiIndex({ path }: { path: string }) {
  const api = useApi();
  const toc = api.groups.map((g) => ({ id: slug(g.title), label: g.title }));
  return (
    <Shell area="api" path={path} toc={toc}>
      <p className="eyebrow">Reference</p>
      <h1>API</h1>
      <p className="lead">
        Every export of <code>@vhult/graph</code> {api.version}, {api.entries.length} in total. The groups follow the
        way you use the engine: <code>Graph.create</code> gives you a graph, and each part of it, like{" "}
        <code>graph.nodes</code> or <code>graph.camera</code>, has its own group.
      </p>
      {api.groups.map((g) => (
        <section key={g.id}>
          <h2 id={slug(g.title)}>{g.title}</h2>
          {g.intro && (
            <p>
              <Inline text={g.intro} />
            </p>
          )}
          {g.namespace && <Blocks blocks={[{ api: [g.namespace] }]} />}
          {g.types.length > 0 && (
            <>
              <p className="section-label">Types</p>
              <Blocks blocks={[{ api: g.types }]} />
            </>
          )}
          {g.values.length > 0 && (
            <>
              <p className="section-label">Values</p>
              <Blocks blocks={[{ api: g.values }]} />
            </>
          )}
        </section>
      ))}
    </Shell>
  );
}
