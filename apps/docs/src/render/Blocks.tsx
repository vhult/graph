import { useApi } from "../content/api";
import type { Block } from "../content/types";
import { Link } from "../router";
import { Code } from "./Code";
import { Inline } from "./Inline";

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function ApiList({ names }: { names: string[] }) {
  const api = useApi();
  return (
    <ul className="api-list">
      {names.map((name) => {
        const entry = api.entriesOf(name)[0];
        return (
          <li key={name}>
            <Link href={api.itemHref(name)}>
              <code>{api.labelOf(name)}</code>
            </Link>
            {entry && <span className="kind">{entry.kind}</span>}
            {entry && (
              <p>
                <Inline text={entry.doc.summary} />
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BlockView({ block }: { block: Block }) {
  if ("heading" in block) {
    return (
      <h2 id={slug(block.heading)}>
        <Inline text={block.heading} plain />
      </h2>
    );
  }
  if ("subheading" in block) {
    return (
      <h3 id={slug(block.subheading)}>
        <Inline text={block.subheading} plain />
      </h3>
    );
  }
  if ("code" in block) return <Code source={block.code} lang={block.lang} title={block.title} />;
  if ("list" in block) {
    return (
      <ul>
        {block.list.map((item, i) => (
          <li key={i}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    );
  }
  if ("note" in block) {
    return (
      <aside className={`note note-${block.kind ?? "info"}`}>
        <Inline text={block.note} />
      </aside>
    );
  }
  if ("table" in block) {
    return (
      <div className="table">
        <table>
          <thead>
            <tr>
              {block.table.columns.map((c, i) => (
                <th key={i}>
                  <Inline text={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if ("cards" in block) {
    return (
      <div className="cards">
        {block.cards.map((card, i) => {
          const body = (
            <>
              <strong>{card.title}</strong>
              <span>
                <Inline text={card.text} plain={card.href !== undefined} />
              </span>
            </>
          );
          return card.href ? (
            <Link key={i} className="card card-link" href={card.href}>
              {body}
            </Link>
          ) : (
            <div key={i} className="card">
              {body}
            </div>
          );
        })}
      </div>
    );
  }
  if ("points" in block) {
    return (
      <ol className="points">
        {block.points.map((p, i) => (
          <li key={i}>
            <span className="point-index">{String(i + 1).padStart(2, "0")}</span>
            <strong>{p.title}</strong>
            <span>
              <Inline text={p.text} />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  if ("api" in block) return <ApiList names={block.api} />;
  return (
    <p>
      <Inline text={block.text} />
    </p>
  );
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </>
  );
}
