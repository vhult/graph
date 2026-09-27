import { useState, type ReactNode } from "react";

const TS =
  /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(import|from|export|const|let|var|function|return|if|else|for|of|in|new|await|async|type|interface|class|extends|true|false|null|undefined|typeof|void)\b|\b([A-Z]\w*)\b/gm;

const SH = /(#.*$)|("(?:\\.|[^"\\\n])*"|'[^'\n]*')|^(\s*(?:npm|npx|node|pnpm|yarn))\b/gm;

const CLASSES = ["", "tok-comment", "tok-string", "tok-number", "tok-keyword", "tok-type"];
const SH_CLASSES = ["", "tok-comment", "tok-string", "tok-keyword"];

function highlight(source: string, lang: string): ReactNode[] {
  const shell = lang === "sh" || lang === "bash";
  const re = shell ? SH : lang === "ts" || lang === "js" || lang === "tsx" ? TS : null;
  if (!re) return [source];
  const classes = shell ? SH_CLASSES : CLASSES;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of source.matchAll(re)) {
    if (m.index > last) out.push(source.slice(last, m.index));
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    out.push(
      <span key={m.index} className={classes[group]}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push(source.slice(last));
  return out;
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    });
  };
  return (
    <button type="button" className="copy" onClick={copy}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function Code({ source, lang = "ts", title }: { source: string; lang?: string; title?: string }) {
  const text = source.replace(/\n+$/, "");
  return (
    <figure className="code">
      <figcaption>
        <span>{title ?? lang}</span>
        <CopyButton text={text} />
      </figcaption>
      <pre>
        <code>{highlight(text, lang)}</code>
      </pre>
    </figure>
  );
}

export function Example({ source }: { source: string }) {
  return (
    <details className="example">
      <summary>Example</summary>
      <Code source={source} />
    </details>
  );
}
