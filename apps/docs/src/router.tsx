import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

export function isAppPath(href: string): boolean {
  const path = href.split("#")[0];
  return path === "/" || path === "/api" || path.startsWith("/api/") || path.startsWith("/docs/");
}

export function navigate(href: string): void {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export interface Place {
  path: string;
  hash: string;
}

function place(): Place {
  return { path: location.pathname, hash: decodeURIComponent(location.hash.slice(1)) };
}

export function usePlace(): Place {
  const [current, setCurrent] = useState(place);
  useEffect(() => {
    const onPop = () => setCurrent(place());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return current;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export function Link({ href, onClick, ...rest }: LinkProps) {
  const external = /^https?:/.test(href);
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!isAppPath(href)) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={click} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...rest} />;
}
