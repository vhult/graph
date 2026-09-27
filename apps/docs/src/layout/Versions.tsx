import { LATEST_API, VERSIONS, apiOf, useApi, type Api } from "../content/api";
import { Link, navigate } from "../router";

function target(from: Api, to: Api, path: string): string {
  const name = path.slice(from.base.length + 1);
  return name && to.has(name) ? to.itemHref(name) : to.base;
}

export function VersionPicker({ path }: { path: string }) {
  const api = useApi();
  if (VERSIONS.length < 2) return null;
  const pick = (id: string) => {
    apiOf(id)?.then((to) => navigate(target(api, to, path)));
  };
  return (
    <label className="version-picker">
      <span className="side-title">Version</span>
      <select value={api.id} onChange={(e) => pick(e.target.value)}>
        {VERSIONS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.latest ? `${a.version} (latest)` : a.version}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ArchiveNote({ path }: { path: string }) {
  const api = useApi();
  if (api.latest) return null;
  return (
    <aside className="note note-warning">
      This is the API of version {api.version}. <Link href={target(api, LATEST_API, path)}>See the latest version</Link>.
    </aside>
  );
}
