import content from "virtual:content";
import { Link } from "../router";
import { GitHubButton, NpmBadge } from "./Integrations";

function active(path: string, href: string): boolean {
  if (!href.startsWith("/") || href === "/") return false;
  const section = href.split("/")[1];
  return path.split("/")[1] === section;
}

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 22 16 8l8 14Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="8" r="4.5" fill="#4c9aff" />
      <circle cx="8" cy="22" r="4.5" fill="#b57bff" />
      <circle cx="24" cy="22" r="4.5" fill="#36c98f" />
    </svg>
  );
}

export function Header({ path }: { path: string }) {
  const { site, version } = content;
  return (
    <header className="header">
      <div className="header-inner">
        <Link href="/" className="brand">
          <Mark />
          <span className="brand-name">{site.name}</span>
          <span className="version">{version}</span>
        </Link>
        <nav className="header-nav">
          {site.nav.map((link) => (
            <Link key={link.href} href={link.href} className={active(path, link.href) ? "active" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="header-integrations">
          <GitHubButton />
          <NpmBadge badge="version" />
        </div>
      </div>
    </header>
  );
}
