export interface Link {
  label: string;
  href: string;
}

export interface Action extends Link {
  primary?: boolean;
}

export interface Card {
  title: string;
  text: string;
  href?: string;
}

export interface Point {
  title: string;
  text: string;
}

export interface Table {
  columns: string[];
  rows: string[][];
}

export type Block =
  | { text: string }
  | { heading: string }
  | { subheading: string }
  | { code: string; lang?: string; title?: string }
  | { list: string[] }
  | { note: string; kind?: "info" | "warning" }
  | { table: Table }
  | { cards: Card[] }
  | { points: Point[] }
  | { api: string[] };

export interface Page {
  id: string;
  title: string;
  description?: string;
  blocks: Block[];
}

export interface Landing {
  tagline: string;
  lead: string;
  install: string;
  actions: Action[];
  code: string;
  codeTitle: string;
  blocks: Block[];
}

export interface DocsSection {
  section: string;
  pages: string[];
}

export type Badge = "version" | "downloads" | "license" | "size";

export interface Site {
  name: string;
  description: string;
  github: string;
  npm: string;
  badges: Badge[];
  nav: Link[];
  landing: Landing;
  docs: DocsSection[];
  api: string[];
  footer: string;
}

export interface ApiMemberText {
  description?: string;
  example?: string;
}

export interface ApiText extends ApiMemberText {
  label?: string;
  members?: Record<string, ApiMemberText>;
}

export interface ApiGroup {
  id: string;
  title: string;
  intro?: string;
  namespace?: string;
  types: string[];
  values: string[];
  docs: Record<string, ApiText>;
}

export interface Content {
  version: string;
  site: Site;
  pages: Record<string, Page>;
  api: ApiGroup[];
}

export interface Token {
  text: string;
  ref?: string;
}

export interface ApiTag {
  tag: string;
  text: string;
}

export interface ApiDoc {
  summary: string;
  tags: ApiTag[];
}

export interface ApiMember {
  name: string;
  kind: "property" | "method" | "constructor";
  signature: Token[];
  doc: ApiDoc;
  optional: boolean;
  readonly: boolean;
  static: boolean;
}

export interface ApiEntry {
  name: string;
  kind: "class" | "interface" | "type" | "function" | "const";
  label?: string;
  signature: Token[];
  doc: ApiDoc;
  members: ApiMember[];
}

export interface ApiModel {
  entries: ApiEntry[];
}
