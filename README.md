# diagif

Turn a technical topic into a grounded diagram, a looping GIF and a draft post.
The agent retains sources and intermediate artifacts, validates model proposals,
inspects the scene in Chromium and gates the encoded result before delivery.
All outputs stay on your machine. No command publishes a post.

## Get started from source

Use Node 24 or later and Python 3.12. Git selects tracked files for the public-file
sanitisation check; ripgrep is optional because a Node scanner is included.
Clone the source repository and run these commands at its root:

```sh
npm ci
python -m pip install -r requirements.txt
npx playwright install chromium
node src/cli.js doctor
node bin/diagif.js make "explain RAG" --brain mock --dry-run
```

On Linux, also run `npx playwright install-deps chromium`. On Windows, use
`py -3 -m pip install -r requirements.txt` if `python` does not select your intended
installation, or set `TECH_GIFS_PYTHON` to its executable. The renderer probes
Pillow support and avoids the Windows Store alias.

Playwright 1.62.0, Ajv 8.20.0, fast-glob 3.3.3 and linkedom 0.18.13 are pinned. Chromium is a separate
one-time download. Fonts and icons are bundled with their upstream licences;
`npm run fonts` and `npm run icons` restore missing assets using pinned hashes.
Rendering runs offline once dependencies, assets and Chromium are available.
Live research and hosted model providers require network access.

The first command above produces a mock fact sheet, brief, draft post and run
record. Remove `--dry-run` to include a scene, GIF, contact sheet and critic:

```sh
node bin/diagif.js make "explain RAG" --brain mock
node bin/diagif.js mindmap "agentic AI" --brain mock
node bin/diagif.js --help
```

The package exposes the same CLI as `diagif` when installed. The source checkout
also contains tests and developer documentation that are excluded from the npm
package. Six measured release examples are linked below.

## Make, inspect and resume

```sh
node bin/diagif.js make "REST API optimisation techniques" --brain mock --dry-run
node bin/diagif.js make "explain RAG" --brain mock --resume-slug explain-rag
node bin/diagif.js make "explain RAG" --brain mock --fresh --max-model-calls 28
node bin/diagif.js scout --domain "REST API" --count 5
node bin/diagif.js scout --make --count 2 --brain mock
node bin/diagif.js doctor
```

A run writes under `out/<slug>/` by default. Full runs retain `<slug>.gif`,
`<slug>.gif.contact.png`, `post.md`, `run.json`, `scene.json` and `steps/` evidence.
Dry runs stop after the brief and post. Use `--out DIR` to choose another output
root. The draft post contains a hook, a short explanation, a call to action and
hashtags; review it alongside the supporting sources.

Resume reuses accepted steps only when their recorded inputs match. A changed
brand invalidates scene generation onward; `--fresh` bypasses research caches and
invalidates the run from research onward. Failed proposals, render candidates and
quality reports remain available for diagnosis. Existing delivered GIFs are
replaced only after the replacement passes the gate.

Every model attempt consumes the call budget before dispatch. The default cap is
28 calls, including retries and critic repair. `--max-model-calls` accepts 1-200;
scout can also cap all child runs with `--max-total-model-calls` (1-2000).
Topic text is limited to 180 characters and scout count to 1-10.

## Models, research and configuration

Available brains are `mock`, `codex-cli`, `claude-cli`, `openai` and `anthropic`.
Local CLI brains use separately installed, authenticated tools. Set `DIAGIF_CODEX`
or `DIAGIF_CLAUDE` to a real executable or supported JavaScript entry point if
discovery fails. Windows command shims cannot be spawned directly.

Hosted brains require their provider key in the environment (`OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`) and an explicit model through config or `--model`. Do not put
credentials in scene files or configuration. Model availability and prices are
not inferred; cost remains unknown unless a provider supplies it or you configure
rates. `doctor` checks availability without making a model call.

Config is discovered from the current directory upward, or selected with
`--config FILE`. It controls the brain, enabled research providers, brand and
limits. A minimal user config is:

```json
{
  "version": 1,
  "brain": { "provider": "mock" },
  "brand": { "style": "none" }
}
```

Save it as `diagif.config.json`; this personal file is ignored by Git.
Defaults apply to omitted fields. Run records retain redacted configuration and
step evidence, not keyed-provider request bodies.

Default live research uses Hacker News, GitHub and public pages. Optional keyed
providers are Brave (the recommended keyed default), Exa and Tavily, enabled with
`BRAVE_API_KEY`, `EXA_API_KEY` or `TAVILY_API_KEY`. Reddit requires app-only OAuth
credentials (`REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`). Provider failures and
rate limits are reported as diagnostics, never invented as empty successful data.
DuckDuckGo HTML search is off by default and requires `--allow-html-search`; the
project treats automated HTML search as contrary to that service's terms and it
may be challenged. Prefer the documented API providers.

Quotes must occur in their cited extracted text after normalisation. Every diagram
text slot maps to grounded facts or explicit authoring. This establishes provenance;
it does not establish that a source is correct. Research needs at least six grounded
facts. Page fetching rejects private network targets, checks redirects and limits
response sizes. Caches expire after seven days for research and six hours for scout.

Mock brain implies mock research; `--research mock` can select fixtures separately.
For a strict offline dry run in PowerShell:

```powershell
$env:DIAGIF_OFFLINE = '1'
node bin/diagif.js make "explain RAG" --brain mock --dry-run
Remove-Item Env:DIAGIF_OFFLINE
```

The mock topics are `explain RAG`, `REST API optimisation techniques` and
`agentic AI`. Mock runs use no network or paid model calls. Scout scores are
labelled **heuristic virality**: an ordering aid, not a success prediction.
A critic without vision records readability and hook checks as `unmeasured`;
`delivered-with-warnings` is not a claim of visual review.

## Personal brand and mind maps

```sh
node bin/diagif.js brand --url https://www.linkedin.com/in/example/
node bin/diagif.js brand --clear
```

The brand command writes only your config. A configured footer displays exactly
one canonical LinkedIn profile or company URL, without a trailing slash, at 16 px.
It must be at most 72 characters and fit the measured footer width. Public scenes
use `brand: {"style":"none"}`. To make a separate branded scene copy, use:

```sh
node scripts/apply-brand.js scenes/mcp-vs-skills.json --out branded --config diagif.config.json
```

Mind maps use an 800 by 1100 canvas with four to eight branches and one or two
leaves per branch. Author labels and relationships; placement, connectors and
ambient marching dashes and branch highlights are generated. The complete map is visible from frame zero. Authored maps contain no node coordinates. See the
[contract](docs/CONTRACT.md) for the schema and materialisation rules.

When authoring a scene, node rows should span the content zone. If the diagram
has fewer than three rows, increase row spacing to fill roughly y 150..900
(within the actual content zone), or add a summary annotation band at the bottom.
This is composition guidance, not a validation gate.

## Use the renderer directly

The existing renderer CLI supports `doctor`, `validate`, `preview-svg`, `preview`,
`debug-frame`, `capture`, `encode`, `verify` and `render`:

```sh
node src/cli.js validate 'scenes/*.json'
node src/cli.js render scenes/mcp-vs-skills.json
node src/cli.js render 'scenes/*.json' --max-parallel-scenes 2
npm run gallery
```

Renderer outputs go under `output/`, while frames and candidates stay under
`work/`. The local gallery is `output/index.html`; its Markdown table and summary
are generated alongside it. `config/domains.json` supplies gallery domain labels.
Subset renders replace the default manifest with that subset; use a separate
`--manifest FILE` when retaining a previous full gallery manifest.

Pillow is the guaranteed encoder. Optional gifski and gifsicle are discovered
through `TECH_GIFS_GIFSKI` / `TECH_GIFS_GIFSICLE`, `tools/bin/`, then PATH. They are
separately downloaded tools and are never distributed in the package. The optional
`node scripts/fetch-tools.js` checks pinned archives, member hashes and platform
compatibility; POSIX gifsicle installation uses your package manager. CI never
runs this download script.

Rendering starts with a 25 fps capture and can recapture at 20 fps when needed.
The primary is 800 px wide. The project targets 5,000,000 bytes with an
8,000,000-byte hard cap and at most 250 decoded frames; these are project budgets,
not a guarantee of current upload limits. A separate safe variant may be narrower.
The gate checks duration, delays, loop metadata, seam hashes, static-region flicker
and colours. Read the quality report's `failures` array and inspect the contact
sheet. Frame hashing is deterministic on the same machine and Chromium build.

## Examples and documentation

Six neutral GIFs rendered and measured on 2026-09-05. Each is smaller than
600,000 bytes and passes the quality gate. Contact sheets were visually reviewed.

- [MCP versus skills](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/mcp-vs-skills.gif)
- [Cursor pagination](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/rest-cursor-pagination.gif)
- [SQL index prefixes](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/sql-leftmost-prefix.gif)
- [Deployment strategies](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/blue-green-canary-rolling.gif)
- [OAuth PKCE](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/oauth-pkce.gif)
- [Agentic AI mind map](https://raw.githubusercontent.com/amasen02/diagif/main/docs/examples/agentic-ai.gif)

Read the [renderer contract](docs/CONTRACT.md), [renderer design](docs/DESIGN.md),
[research methodology](docs/RESEARCH.md) and [render summary](docs/RENDER-SUMMARY.md).

## Validation and exit codes

```sh
npm test
node --test test/sanitize.test.js
node scripts/sanitize-public-docs.js --check
npm pack --dry-run --json
```

The agent uses these exit codes; the lower-level renderer retains its own CLI
status convention.

| Code | Meaning |
| --- | --- |
| 0 | Delivered, delivered with warnings, or completed dry run |
| 2 | Invalid usage or configuration arguments |
| 3 | Provider unavailable, authentication failure or quota |
| 4 | Schema, proposal repair, truncation, refusal or wire-schema failure |
| 5 | Render or quality gate failure |
| 6 | Model-call budget exhausted |
| 7 | Resume mismatch or ambiguous slug |
| 8 | Insufficient grounded research or offline restriction |

CI runs tests, two Pillow renders, an offline mock dry run and sanitisation on
Windows and Linux. An optional `--denylist FILE` extends sanitisation with literal
private identifiers without copying that file into the repository.

## Review and sharing

Inspect the image, verify the technical claims and edit the draft before sharing.
Add a text explanation and a static alternative or suitable playback controls
where you embed animation. The GIF file cannot enforce a host's playback behaviour.

Project code is MIT licensed. Bundled fonts, icons and dependencies retain their
licences, listed in `THIRD_PARTY_NOTICES.md`. Brand marks identify products and
imply no affiliation or endorsement. Development and release guidance is in
`CONTRIBUTING.md`.

Source and issue tracker: https://github.com/amasen02/diagif

<!-- scene-schema-field-table:start -->

## Scene schema field examples

This index mirrors every property in the current scene schema. Values are illustrative; use [the contract](docs/CONTRACT.md) and `src/schema/scene.schema.json` for constraints.

| Field | Example |
| --- | --- |
| `id` | `example` |
| `canvas` | `example` |
| `canvas.width` | `example` |
| `canvas.height` | `example` |
| `theme` | `example` |
| `grain` | `example` |
| `title` | `example` |
| `title.text` | `example` |
| `title.lines` | `example` |
| `title.font` | `example` |
| `title.size` | `example` |
| `title.align` | `example` |
| `title.x` | `example` |
| `title.y` | `example` |
| `title.accentWords` | `example` |
| `title.accentWords[].word` | `example` |
| `title.accentWords[].colorRole` | `example` |
| `title.accentWords[].color` | `example` |
| `title.strikeWords` | `example` |
| `title.chipWords` | `example` |
| `title.chipWords[].word` | `example` |
| `title.chipWords[].fill` | `example` |
| `title.chipWords[].textColor` | `example` |
| `title.shadow` | `example` |
| `title.shadow.kind` | `example` |
| `title.shadow.dx` | `example` |
| `title.shadow.dy` | `example` |
| `title.shadow.color` | `example` |
| `title.subtitle` | `example` |
| `title.subtitle.text` | `example` |
| `title.subtitle.font` | `example` |
| `title.subtitle.size` | `example` |
| `title.subtitle.prefix` | `example` |
| `brand` | `example` |
| `brand.style` | `example` |
| `brand.name` | `example` |
| `brand.tagline` | `example` |
| `brand.ctaPrefix` | `example` |
| `brand.ctaBold` | `example` |
| `brand.url` | `example` |
| `brand.urlColorRole` | `example` |
| `brand.logoAsset` | `example` |
| `brand.mascotAsset` | `example` |
| `brand.mascot` | `example` |
| `brand.mascot.x` | `example` |
| `brand.mascot.y` | `example` |
| `brand.mascot.w` | `example` |
| `brand.avatarAsset` | `example` |
| `brand.showSaveIcon` | `example` |
| `brand.socials` | `example` |
| `brand.socials[].network` | `example` |
| `brand.socials[].handle` | `example` |
| `layout` | `example` |
| `layout.kind` | `example` |
| `layout.dividerY` | `example` |
| `layout.labels` | `example` |
| `layout.divider` | `example` |
| `layout.divider.style` | `example` |
| `layout.divider.colorRole` | `example` |
| `layout.sections` | `example` |
| `layout.sections[].id` | `example` |
| `layout.sections[].header` | `example` |
| `layout.sections[].headerStyle` | `example` |
| `layout.sections[].y` | `example` |
| `layout.sections[].h` | `example` |
| `layout.sections[].colorRole` | `example` |
| `layout.sections[].labelAlign` | `example` |
| `layout.columns` | `example` |
| `layout.columns[].id` | `example` |
| `layout.columns[].header` | `example` |
| `layout.columns[].x` | `example` |
| `layout.columns[].y` | `example` |
| `layout.columns[].w` | `example` |
| `layout.columns[].h` | `example` |
| `layout.columns[].accentFrom` | `example` |
| `layout.columns[].accentTo` | `example` |
| `layout.columns[].innerPanel` | `example` |
| `layout.columns[].innerPanel.x` | `example` |
| `layout.columns[].innerPanel.y` | `example` |
| `layout.columns[].innerPanel.w` | `example` |
| `layout.columns[].innerPanel.h` | `example` |
| `layout.columns[].innerPanel.fill` | `example` |
| `layout.mindmap` | `example` |
| `layout.mindmap.root` | `example` |
| `layout.mindmap.root.id` | `example` |
| `layout.mindmap.root.label` | `example` |
| `layout.mindmap.root.icon` | `example` |
| `layout.mindmap.root.icon.name` | `example` |
| `layout.mindmap.root.icon.source` | `example` |
| `layout.mindmap.root.icon.size` | `example` |
| `layout.mindmap.root.icon.colorRole` | `example` |
| `layout.mindmap.branches` | `example` |
| `layout.mindmap.branches[].id` | `example` |
| `layout.mindmap.branches[].label` | `example` |
| `layout.mindmap.branches[].icon` | `example` |
| `layout.mindmap.branches[].icon.name` | `example` |
| `layout.mindmap.branches[].icon.source` | `example` |
| `layout.mindmap.branches[].icon.size` | `example` |
| `layout.mindmap.branches[].icon.colorRole` | `example` |
| `layout.mindmap.branches[].colorRole` | `example` |
| `layout.mindmap.branches[].leaves` | `example` |
| `layout.mindmap.branches[].leaves[].id` | `example` |
| `layout.mindmap.branches[].leaves[].label` | `example` |
| `layout.mindmap.branches[].leaves[].icon` | `example` |
| `layout.mindmap.branches[].leaves[].icon.name` | `example` |
| `layout.mindmap.branches[].leaves[].icon.source` | `example` |
| `layout.mindmap.branches[].leaves[].icon.size` | `example` |
| `layout.mindmap.branches[].leaves[].icon.colorRole` | `example` |
| `layout.mindmap.placement` | `example` |
| `nodes` | `example` |
| `nodes[].id` | `example` |
| `nodes[].label` | `example` |
| `nodes[].secondaryLabel` | `example` |
| `nodes[].labelRotate` | `example` |
| `nodes[].labelAlign` | `example` |
| `nodes[].icon` | `example` |
| `nodes[].icon.name` | `example` |
| `nodes[].icon.source` | `example` |
| `nodes[].icon.size` | `example` |
| `nodes[].icon.colorRole` | `example` |
| `nodes[].badge` | `example` |
| `nodes[].customSvgPath` | `example` |
| `nodes[].x` | `example` |
| `nodes[].y` | `example` |
| `nodes[].w` | `example` |
| `nodes[].h` | `example` |
| `nodes[].shape` | `example` |
| `nodes[].colorRole` | `example` |
| `nodes[].style` | `example` |
| `nodes[].style.fill` | `example` |
| `nodes[].style.stroke` | `example` |
| `nodes[].style.textColor` | `example` |
| `nodes[].style.iconColor` | `example` |
| `nodes[].style.strokeWidth` | `example` |
| `nodes[].style.elevation` | `example` |
| `edges` | `example` |
| `edges[].id` | `example` |
| `edges[].from` | `example` |
| `edges[].to` | `example` |
| `edges[].pathType` | `example` |
| `edges[].fromAnchor` | `example` |
| `edges[].toAnchor` | `example` |
| `edges[].waypoints` | `example` |
| `edges[].waypoints[].x` | `example` |
| `edges[].waypoints[].y` | `example` |
| `edges[].curveOffset` | `example` |
| `edges[].loop` | `example` |
| `edges[].loop.side` | `example` |
| `edges[].loop.size` | `example` |
| `edges[].label` | `example` |
| `edges[].label.text` | `example` |
| `edges[].label.t` | `example` |
| `edges[].label.side` | `example` |
| `edges[].label.pill` | `example` |
| `edges[].colorRole` | `example` |
| `edges[].style` | `example` |
| `edges[].strokeWidth` | `example` |
| `edges[].dashed` | `example` |
| `edges[].arrow` | `example` |
| `annotations` | `example` |
| `annotations[].id` | `example` |
| `annotations[].kind` | `example` |
| `annotations[].x` | `example` |
| `annotations[].y` | `example` |
| `annotations[].w` | `example` |
| `annotations[].h` | `example` |
| `annotations[].text` | `example` |
| `annotations[].maxWidth` | `example` |
| `annotations[].font` | `example` |
| `annotations[].fontSize` | `example` |
| `annotations[].align` | `example` |
| `annotations[].colorRole` | `example` |
| `annotations[].target` | `example` |
| `annotations[].targetAnchor` | `example` |
| `annotations[].curve` | `example` |
| `annotations[].arrow` | `example` |
| `annotations[].attachTo` | `example` |
| `annotations[].number` | `example` |
| `annotations[].language` | `example` |
| `annotations[].lines` | `example` |
| `annotations[].lines[].text` | `example` |
| `annotations[].lines[].band` | `example` |
| `annotations[].lines[].badge` | `example` |
| `annotations[].lines[].badge.n` | `example` |
| `annotations[].lines[].badge.side` | `example` |
| `annotations[].header` | `example` |
| `annotations[].rows` | `example` |
| `timeline` | `example` |
| `timeline.durationMs` | `example` |
| `timeline.fps` | `example` |
| `timeline.loop` | `example` |
| `timeline.strictFrameCount` | `example` |
| `timeline.animations` | `example` |
| `timeline.animations[kind=particle-flow].kind` | `example` |
| `timeline.animations[kind=particle-flow].edgeIds` | `example` |
| `timeline.animations[kind=particle-flow].count` | `example` |
| `timeline.animations[kind=particle-flow].cyclesPerLoop` | `example` |
| `timeline.animations[kind=particle-flow].speedPxPerSec` | `example` |
| `timeline.animations[kind=particle-flow].staggerMs` | `example` |
| `timeline.animations[kind=particle-flow].colorRole` | `example` |
| `timeline.animations[kind=particle-flow].color` | `example` |
| `timeline.animations[kind=particle-flow].size` | `example` |
| `timeline.animations[kind=particle-flow].glow` | `example` |
| `timeline.animations[kind=particle-flow].trail` | `example` |
| `timeline.animations[kind=particle-flow].fadeMs` | `example` |
| `timeline.animations[kind=marching-dash].kind` | `example` |
| `timeline.animations[kind=marching-dash].edgeIds` | `example` |
| `timeline.animations[kind=marching-dash].dash` | `example` |
| `timeline.animations[kind=marching-dash].gap` | `example` |
| `timeline.animations[kind=marching-dash].cyclesPerLoop` | `example` |
| `timeline.animations[kind=marching-dash].speedPxPerSec` | `example` |
| `timeline.animations[kind=sequential-highlight].kind` | `example` |
| `timeline.animations[kind=sequential-highlight].order` | `example` |
| `timeline.animations[kind=sequential-highlight].dwellMs` | `example` |
| `timeline.animations[kind=sequential-highlight].transitionMs` | `example` |
| `timeline.animations[kind=sequential-highlight].scale` | `example` |
| `timeline.animations[kind=pulse].kind` | `example` |
| `timeline.animations[kind=pulse].nodeIds` | `example` |
| `timeline.animations[kind=pulse].cyclesPerLoop` | `example` |
| `timeline.animations[kind=pulse].periodMs` | `example` |
| `timeline.animations[kind=pulse].scale` | `example` |
| `timeline.animations[kind=typing].kind` | `example` |
| `timeline.animations[kind=typing].targetId` | `example` |
| `timeline.animations[kind=typing].mirrorTargetId` | `example` |
| `timeline.animations[kind=typing].text` | `example` |
| `timeline.animations[kind=typing].startMs` | `example` |
| `timeline.animations[kind=typing].durationMs` | `example` |
| `timeline.animations[kind=typing].exitMs` | `example` |
| `timeline.animations[kind=typing].loopBehavior` | `example` |
| `timeline.animations[kind=reveal].kind` | `example` |
| `timeline.animations[kind=reveal].targetIds` | `example` |
| `timeline.animations[kind=reveal].startMs` | `example` |
| `timeline.animations[kind=reveal].durationMs` | `example` |
| `timeline.animations[kind=reveal].exitMs` | `example` |
| `timeline.animations[kind=reveal].loopBehavior` | `example` |
| `timeline.animations[kind=reveal].mode` | `example` |

<!-- scene-schema-field-table:end -->
