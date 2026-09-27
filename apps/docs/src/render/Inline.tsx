import api from "virtual:api";
import type { ReactNode } from "react";
import { Link } from "../router";

const NAMES = new Set(api.entries.map((e) => e.name));

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function apiHref(code: string): string | undefined {
  const m = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/.exec(code);
  if (!m || !NAMES.has(m[1])) return undefined;
  return m[2] ? `/api/${m[1]}#${m[2]}` : `/api/${m[1]}`;
}

export function Inline({ text, plain = false }: { text: string; plain?: boolean }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const key = m.index;
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const href = plain ? undefined : apiHref(m[1]);
      out.push(
        href ? (
          <Link key={key} href={href} className="code-link">
            <code>{m[1]}</code>
          </Link>
        ) : (
          <code key={key}>{m[1]}</code>
        ),
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={key}>
          <Inline text={m[2]} plain={plain} />
        </strong>,
      );
    } else {
      out.push(
        <Link key={key} href={m[4]}>
          <Inline text={m[3]} plain />
        </Link>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
