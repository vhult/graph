import type { ReactNode } from "react";
import { groupOf, labelOf, textOf } from "../content/api";
import type { ApiDoc, ApiEntry, ApiMember, ApiMemberText, Token } from "../content/types";
import { Shell } from "../layout/Shell";
import { Example } from "../render/Code";
import { Inline } from "../render/Inline";
import { Link } from "../router";

const SECTIONS: { kind: ApiMember["kind"]; title: string }[] = [
  { kind: "constructor", title: "Constructor" },
  { kind: "property", title: "Properties" },
  { kind: "method", title: "Methods" },
];

function Signature({ tokens, block = false }: { tokens: Token[]; block?: boolean }) {
  const code = (
    <code>
      {tokens.map((t, i) =>
        t.ref ? (
          <Link key={i} href={`/api/${t.ref}`} className="ref">
            {t.text}
          </Link>
        ) : (
          t.text
        ),
      )}
    </code>
  );
  return block ? <pre className="signature">{code}</pre> : <div className="member-signature">{code}</div>;
}

function Text({ doc, text, between }: { doc: ApiDoc; text: ApiMemberText; between?: ReactNode }) {
  const description = text.description ?? doc.summary;
  return (
    <>
      {description &&
        description.split(/\n\s*\n/).map((para, i) => (
          <p key={i} className="description">
            <Inline text={para.trim()} />
          </p>
        ))}
      {between}
      {doc.tags.length > 0 && (
        <dl className="tags">
          {doc.tags.map((t, i) => (
            <div key={i}>
              <dt>@{t.tag}</dt>
              <dd>
                <Inline text={t.text} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {text.example && <Example source={text.example} />}
    </>
  );
}

function Member({ member, text }: { member: ApiMember; text: ApiMemberText }) {
  const flags = [member.static && "static", member.readonly && "readonly", member.optional && "optional"].filter(
    (f): f is string => typeof f === "string",
  );
  return (
    <section className="member" id={member.name}>
      <h3>
        <a href={`#${member.name}`}>
          <code>{member.name}</code>
        </a>
        {flags.map((f) => (
          <span key={f} className="kind">
            {f}
          </span>
        ))}
      </h3>
      <Signature tokens={member.signature} />
      <Text doc={member.doc} text={text} />
    </section>
  );
}

function Entry({ entry, first }: { entry: ApiEntry; first: boolean }) {
  const text = textOf(entry.name);
  return (
    <div className="entry">
      {!first && (
        <p className="entry-kind">
          <span className="kind">{entry.kind}</span>
        </p>
      )}
      <Text doc={entry.doc} text={first ? text : {}} between={<Signature tokens={entry.signature} block />} />
      {SECTIONS.map((s) => {
        const members = entry.members.filter((m) => m.kind === s.kind);
        if (members.length === 0) return null;
        return (
          <div key={s.kind}>
            <h2 id={s.title.toLowerCase()}>{s.title}</h2>
            {members.map((m, i) => (
              <Member key={`${m.name}-${i}`} member={m} text={text.members?.[m.name] ?? {}} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function ApiItem({ entries, path }: { entries: ApiEntry[]; path: string }) {
  const name = entries[0].name;
  const label = labelOf(name);
  const group = groupOf(name);
  const toc = entries.flatMap((e) => e.members.map((m) => ({ id: m.name, label: `\`${m.name}\`` })));
  return (
    <Shell area="api" path={path} toc={toc}>
      <p className="eyebrow">
        {group ? group.title : "API"} · {entries.map((e) => e.kind).join(" and ")}
      </p>
      <h1>
        <code>{label}</code>
      </h1>
      {label !== name && (
        <p className="type-name">
          Type <code>{name}</code>
        </p>
      )}
      {entries.map((e, i) => (
        <Entry key={e.kind} entry={e} first={i === 0} />
      ))}
    </Shell>
  );
}
