import content from "virtual:content";
import { useEffect, useRef } from "react";
import type { Badge } from "../content/types";

const LABEL = "labelColor=1b1e25&style=flat-square";

function badgeUrl(badge: Badge, pkg: string): string {
  const base = "https://img.shields.io";
  if (badge === "version") return `${base}/npm/v/${pkg}?${LABEL}&color=4c9aff&logo=npm&label=npm`;
  if (badge === "downloads") return `${base}/npm/dw/${pkg}?${LABEL}&color=2c313b`;
  if (badge === "license") return `${base}/npm/l/${pkg}?${LABEL}&color=2c313b`;
  return `${base}/npm/unpacked-size/${pkg}?${LABEL}&color=2c313b`;
}

const ALT: Record<Badge, string> = {
  version: "npm version",
  downloads: "npm downloads per week",
  license: "license",
  size: "unpacked size",
};

export function NpmBadge({ badge }: { badge: Badge }) {
  const pkg = content.site.npm;
  return (
    <a className="badge" href={`https://www.npmjs.com/package/${pkg}`} target="_blank" rel="noreferrer">
      <img src={badgeUrl(badge, pkg)} alt={ALT[badge]} height={20} />
    </a>
  );
}

export function Badges() {
  return (
    <div className="badges">
      {content.site.badges.map((b) => (
        <NpmBadge key={b} badge={b} />
      ))}
    </div>
  );
}

export function GitHubButton() {
  const host = useRef<HTMLSpanElement>(null);
  const repo = content.site.github;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    const a = document.createElement("a");
    a.href = `https://github.com/${repo}`;
    a.textContent = "Star";
    a.setAttribute("data-icon", "octicon-star");
    a.setAttribute("data-show-count", "true");
    a.setAttribute("data-color-scheme", "no-preference: dark; light: dark; dark: dark;");
    a.setAttribute("aria-label", `Star ${repo} on GitHub`);
    el.replaceChildren(a);
    void import("github-buttons").then(({ render }) =>
      render(a, (button) => {
        if (live && a.isConnected) a.replaceWith(button);
      }),
    );
    return () => {
      live = false;
      el.replaceChildren();
    };
  }, [repo]);

  return <span className="gh-button" ref={host} />;
}
