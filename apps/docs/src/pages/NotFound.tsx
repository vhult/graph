import { Link } from "../router";

export function NotFound() {
  return (
    <div className="not-found">
      <h1>Page not found</h1>
      <p>
        <Link href="/">Back to the home page</Link>
      </p>
    </div>
  );
}
