import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useApi } from "../content/api";
import { markRange, search, type SearchHit } from "../content/search";
import { navigate } from "../router";
import { PLACEHOLDER } from "./SearchBox";

function Marked({ text, query }: { text: string; query: string }) {
  const range = markRange(text, query);
  if (!range) return <>{text}</>;
  const [from, to] = range;
  return (
    <>
      {text.slice(0, from)}
      <mark>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

export default function ApiSearch({ initial, focus }: { initial: string; focus: boolean }) {
  const api = useApi();
  const [query, setQuery] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const hits = search(api, query);

  useEffect(() => {
    const el = input.current;
    if (!focus || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focus]);

  const pick = (hit: SearchHit | null) => {
    if (!hit) return;
    setQuery("");
    input.current?.blur();
    navigate(hit.href);
  };

  return (
    <Combobox immediate value={null} onChange={pick} onClose={() => setQuery("")}>
        <ComboboxInput
          ref={input}
          className="search-input"
          placeholder={PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          displayValue={() => query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <ComboboxOptions anchor="bottom start" className="search-results">
            {hits.length === 0 && <div className="search-empty">No match</div>}
            {hits.map((hit) => (
              <ComboboxOption key={`${query}:${hit.href}`} value={hit} className="search-hit">
                <span className="search-crumbs">
                  {hit.crumbs.map((c, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span className="search-sep"> › </span>}
                      {i === 0 ? c : <Marked text={c} query={query} />}
                    </Fragment>
                  ))}
                </span>
                {hit.text && <span className="search-text">{hit.text}</span>}
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        )}
    </Combobox>
  );
}
