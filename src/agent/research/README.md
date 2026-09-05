# Research integration

`collectResearch(topic, options)` (aliases `research`, `collect`) returns
`{topic, retrievedAt, candidates, sources, extracts, diagnostics}`. Mock mode also
returns `factSheet`. `candidates` include `excerpt`; `sources` have only the source
schema fields. Each extract has `{sourceId, url, finalUrl, text, contentHash, cached}`.
Use the fetched `extracts`, not search snippets, in the research brain prompt.

Harness ports: `selectResearch(mode, config).collect(topic, options)` also adds
`contentHash` to collected source metadata for the harness resume hash;
`assertGrounded(sheet, collected)` validates and then updates `sheet.facts` in
place, as expected by the harness. Project collected sources to schema fields
when emitting a fact sheet or `run.sources`. These are collection metadata, not
model-authored fields.

Options: `mode: 'live'|'mock'`, `config`, `providers`, `allowHtmlSearch`, `fresh`,
`purpose: 'research'|'scout'`, `rootDir` / `cacheDir`, `signal`, `timeoutMs`,
`deadlineMs`, `extract: false` (candidate-only scouting), and `now` (clock function
or epoch milliseconds). `cache: false` disables disk caching. The network boundary
accepts injected `fetch`, `fetchPage`, `lookup`, and `request` functions for tests;
production callers should use their defaults. Provider fanout and page extraction
share a 90-second deadline. Adapter errors are isolated in diagnostics.

After schema validation, call `validateFactSheet(factSheet, extracts)` (alias
`groundFactSheet`). It returns a copy with `quoteOffset` and `extractHash` on each
fact, and throws `AgentResearchInsufficient` if any fact fails. `quoteOffset` is a
UTF-16 offset into `norm(extract.text)`, and `extractHash` hashes the UTF-8 bytes of
the stored extracted text. `factSheetForSchema` projects this result back to the
minimal fact fields in the plan for consumers that require that shape.

`getMockResearch(topic)` supplies deterministic sources, extracts and six facts
for `explain RAG`, `REST API optimisation techniques`, and `agentic AI`. Import its
`factSheet` in a mock brain rather than inventing independent quotes or source IDs.
`mock.scout()` returns the three canned candidates for mock scout domains. Mock
fixtures are explicitly synthetic and use example.com URLs; no fetch, DNS, spawn,
environment key reads, cache writes or wall clock reads occur in that path.

Page requests recheck every redirect and every DNS answer, use a checked-address
lookup and dedicated connection, and reject private addresses, non-HTML,
compressed responses, oversized bodies and incomplete responses. The one request
deadline includes DNS, redirects and streaming. IPv6 transition tunnels and
non-unicast ranges are rejected conservatively as well. Provider JSON uses native
fetch only against adapter-owned endpoints, manual redirects, timeouts and a
2 MiB streaming cap. `DIAGIF_OFFLINE=1` blocks network access before DNS.

Extraction uses linkedom when installed. The small internal tokenizer fallback
supports the specified removal, container preference, inline spacing, paragraph
boundaries, numeric entities and common named entities. It is not a full HTML5
parser. Production dependency request to Job E: **linkedom 0.18.12** (exact pin;
ISC). Verified registry integrity:
`sha512-jalJsOwIKuQJSeTvsgzPe9iJzyfVaEJiEXl+25EkKevsULHvMJzpNqwvj1jOESWdmgKDiXObyjOYwlUqG7wo1Q==`.

HN/GitHub JSON fixtures in `test/fixtures/research` are live recordings with
timestamps and request URLs. Optional keyed/OAuth and DDG fixtures are marked
synthetic. Unit tests never depend on credentials or live requests. DDG is disabled
unless `allowHtmlSearch` is true; automated HTML search may violate DDG terms and
may be challenged.
