# Render summary

Measured 2026-09-05 from a fresh neutral render. All 29 authored scenes completed the real capture, encoder ladder, promotion and quality stages. The six distributed examples also passed the quality gate and were visually reviewed as contact sheets.

**29 scenes OK / 0 failed; 10,979,521 bytes total.** Bytes are measured from GIF files; KB means 1,000 bytes.

The batch started at `2026-09-05T12:11:29.769Z` and completed at `2026-09-05T12:54:54.663Z`. Every scene has `brand: {"style":"none"}`, an empty `failures` array, a passing seam check and zero static-region flicker. The full batch manifest, frames, quality reports and local gallery stay in ignored renderer directories.

## Distributed examples

Each copied GIF was remeasured with PowerShell `(Get-Item).Length` and compared byte-for-byte with its passing source artifact. The set covers five subject domains plus the MCP smoke scene. Total: 1,757,716 bytes (including the refreshed mind map below).

| Example | Domain | Bytes | Dimensions | Decoded frames | Duration (ms) | Failures |
| --- | --- | ---: | --- | ---: | ---: | --- |
| [mcp-vs-skills](examples/mcp-vs-skills.gif) | smoke scene | 240481 | 800 x 1000 | 100 | 4000 | `[]` |
| [rest-cursor-pagination](examples/rest-cursor-pagination.gif) | REST API | 110135 | 800 x 1000 | 175 | 7000 | `[]` |
| [sql-leftmost-prefix](examples/sql-leftmost-prefix.gif) | SQL | 193347 | 800 x 1000 | 175 | 7000 | `[]` |
| [blue-green-canary-rolling](examples/blue-green-canary-rolling.gif) | DevOps | 254201 | 800 x 1000 | 150 | 6000 | `[]` |
| [oauth-pkce](examples/oauth-pkce.gif) | application security | 505123 | 800 x 1000 | 150 | 6000 | `[]` |
| [agentic-ai](examples/agentic-ai.gif) | AI / agentic AI | 454429 | 800 x 1100 | 150 | 6000 | `[]` |

All six contact sheets were inspected for readable labels, visible motion and neutral branding. This is a visual review of these artifacts, not a model vision-critic claim.

### Example SHA-256

| File | SHA-256 |
| --- | --- |
| mcp-vs-skills.gif | `ef96d658f3befb2699437e24f3ca04a4b0c12f6bee08721d7e3f45b9db1a9586` |
| rest-cursor-pagination.gif | `2db8caca656031c005080c632004d8a416176a027691eb41b5a9034b7c3a264e` |
| sql-leftmost-prefix.gif | `57253480721324d69d7aa42609b325f3b96f0a40d488c58e9935867c42d771a4` |
| blue-green-canary-rolling.gif | `f65a458362bf5de3689671df834cbfba2bffcde9b4ef8916f9eff8993dd4310c` |
| oauth-pkce.gif | `a969b44430d3ad455f04512a73e8e684d62d4c95f536e7517e65c8fba42a2d7e` |
| agentic-ai.gif | `b133d0700eb6b253e80856eb0c302a69d11c8e9f820e26cccf3c575444ed7dc1` |

## Full neutral scene batch

| Scene | Domain | Bytes | Frames | Duration (ms) | Encoder / candidate | Seam | Static flicker |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: |
| agent-context-cost | token / cost optimisation | 548922 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| agent-model-harness | AI / agentic AI | 395203 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| agent-prompt-injection-rule-two | application security | 378376 | 175 | 7000 | gifski / stabilized-o3 | OK | 0 |
| angular-defer-hydration | Angular | 112941 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| angular-signals-zoneless | Angular | 457343 | 100 | 4000 | gifski / stabilized-o3 | OK | 0 |
| blue-green-canary-rolling | DevOps | 254201 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| cache-stampede-single-flight | performance optimisation | 484500 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| cloud-resilience-ladder | Cloud | 917108 | 200 | 8000 | gifski / stabilized-o3 | OK | 0 |
| dotnet-di-lifetimes | .NET | 378084 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| dotnet-timeout | .NET | 154834 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| gitops-push-pull | DevOps | 275833 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| graphrag-vs-vector-rag | GraphRAG | 414627 | 200 | 8000 | gifski / stabilized-o3 | OK | 0 |
| hallucination-four-layer | hallucination prevention | 857415 | 200 | 8000 | gifski / stabilized-o3 | OK | 0 |
| mcp-vs-skills | smoke scene | 240481 | 100 | 4000 | gifski / stabilized-lossy | OK | 0 |
| modular-monolith | software architectures | 372682 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| oauth-code-flow | fixture | 106602 | 100 | 4000 | gifski / stabilized-lossy | OK | 0 |
| oauth-pkce | application security | 505123 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| react-loop | smoke scene | 543180 | 100 | 4000 | gifski / stabilized-o3 | OK | 0 |
| react-observe-loop | AI / agentic AI | 154301 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| rest-cursor-pagination | REST API | 110135 | 175 | 7000 | gifski / stabilized-lossy | OK | 0 |
| rest-idempotency-keys | REST API | 354174 | 200 | 8000 | gifski / stabilized-lossy | OK | 0 |
| serverless-containers-vms | Cloud | 370305 | 150 | 6000 | gifski / stabilized-o3 | OK | 0 |
| solid-before-after | fixture | 131409 | 5 | 6000 | gifski / native | OK | 0 |
| solid-strategy | SOLID / design patterns | 657562 | 125 | 5000 | gifski / stabilized-o3 | OK | 0 |
| solid-vertical-slices | SOLID / design patterns | 495043 | 150 | 6000 | gifski / stabilized-lossy | OK | 0 |
| sql-execution-order | smoke scene | 412395 | 160 | 6400 | gifski / stabilized-lossy | OK | 0 |
| sql-leftmost-prefix | SQL | 193347 | 175 | 7000 | gifski / stabilized-lossy | OK | 0 |
| sql-logical-order | SQL | 472546 | 200 | 8000 | gifski / stabilized-lossy | OK | 0 |
| transactional-outbox | software architectures | 230849 | 175 | 7000 | gifski / stabilized-lossy | OK | 0 |

## Mind-map renderer follow-up (2026-09-05, FIX3)

The new left-to-right render of `test/fixtures/agent-mock-mindmap.json` passes the unchanged quality gate. The example `docs/examples/agentic-ai.gif` is refreshed byte-for-byte from the passing 25 fps primary artifact. It is **454,429 bytes**, below the separate 600,000-byte example cap, so a lower frame rate is unnecessary.

| Measured render | Bytes | Dimensions | Decoded frames | Delays | Duration (ms) | Failures | Loop seam | Static flicker |
| --- | ---: | --- | ---: | --- | ---: | --- | --- | ---: |
| 25 fps, distributed example | 454429 | 800 x 1100 | 150 | 40 ms x 150 | 6000 | `[]` | true | 0 |
| 20 fps, rung 3 comparison | 375979 | 800 x 1100 | 120 | 50 ms x 120 | 6000 | `[]` | true | 0 |

Both use gifski with the shared-palette stabilization and lossless O3 optimization. Both report `staticRegionMaxDiff: 0`. The 25 fps native candidate (567,407 bytes) failed static flicker and was not promoted. The 20 fps comparison was recaptured on its own 50 ms grid with no caller-supplied output width; it was not made by dropping frames from the 25 fps GIF.

The root is at x=32, y=528, 200x96. Branches are at x=280, y=368/480/592/704, 152x84; leaves are at x=480, 200x64. Two-line leaves grow to 76 px. Branch pitch is 112 px and the compact cluster is 420 px high. Straight, dashed arrowed edges connect right anchors to left anchors; every branch retains its color role. Halos wrap each branch and its leaves with 16 px padding and fill-only alpha. The two animations remain marching dashes and sequential highlight, with the whole diagram visible immediately and no exit fade.

Decoded PNGs were individually inspected at full 800 px width:

- Frame 0 (0 ms): complete nine-box diagram, title, root bot icon and all eight connectors; every label readable; Plan has the enlarged emphasis.
- Frame 50 (2,000 ms): Act has the enlarged emphasis; the full diagram remains visible, with short connectors and unchanged label legibility.
- Frame 100 (4,000 ms): Observe has the enlarged emphasis; all four branch/leaf pairs remain connected and readable.
- Frame 149 (5,960 ms): Evaluate has the enlarged emphasis. Root, title and other boxes retain full brightness; there is no closing dimming.

The root sits beside the middle rows rather than in an isolated vertical band. Empty canvas remains above and below the intentionally centered cluster, with no large empty band separating the root from its branch rows. Emphasis visibly advances in authored order across the four inspected frames.

All eight mind-map goldens were regenerated. Six retain full geometry/browser assertions (zone bounds, no overlaps or non-endpoint crossings, integer coordinates, even sizes, two label lines maximum). The two eight-branch/two-leaf fixtures now record `MindmapLayoutError`: their leaves alone need 1,120 px before row gaps, exceeding the available zone. No box size or fit gate was reduced to accept them. Mixed 64/76 px leaf heights and exact compact-cluster coordinates have additional regressions.

The retained 20 fps ladder regression exercises rungs 3 and 4 at non-default canvas height without caller width and checks output dimensions 800x1100 and 720x990. Short-edge regressions assert that label pills clear both endpoints at a 32 px gap. Both the README and scene-authoring prompt retain the requested soft composition rule; the prompt distinguishes generated compact mind maps from authored scene rows.

Caption drafting now deterministically reconciles list-count words and numerals with actual top-level Markdown items. Tests cover the reported four-item/six-stage mismatch, formatted and compound number words, unordered and nested lists, fenced examples, unrelated technical quantities, and persistence without an extra model call.

## Reproduce the neutral batch

```sh
node src/cli.js validate 'scenes/*.json'
node src/cli.js render 'scenes/*.json'
node scripts/build-gallery.js
```

Use a separate manifest when rendering fixtures or subsets so the full 29-scene record is preserved. Optional encoder versions in this run were gifski 1.34.0 and gifsicle 1.95; Chromium came from Playwright 1.62.0 and Python was 3.12 with Pillow 12.1.1. Encoder binaries are not distributed.

## Local validation

Final FIX3 `npm test` exited 0: **762 tests, 760 passed, no failures, two skips** (the POSIX-only check on Windows and the opt-in real-brain smoke). The run included real offline CLI delivery, retry/repair, resume, scout children, mind-map rendering, browser contracts and encoder quality gates. No live model call was added for caption consistency.

`node src/cli.js validate scenes/*.json` exited 0 with all 29 scenes OK. `git add -A` followed by `git diff --cached --check` exited 0; vendored license text remains unchanged, with license-only whitespace exemptions in `.gitattributes`. The refreshed example was checked byte-for-byte against its passing primary render. No commit, push or publication was performed.
