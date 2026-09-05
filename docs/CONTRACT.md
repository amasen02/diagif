### 6.1 Frozen contract: renderer <-> animation runtime <-> stages (`docs/CONTRACT.md`, Phase 0)

**A. Module packaging (browser + Node).** Every `src/renderer/*.js` file is UMD:

```js
(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { <name>: api });
})(typeof globalThis !== "undefined" ? globalThis : this, function (TechGif) {
  const pathGeometry = TechGif.pathGeometry || require("./path-geometry.js");   // one line per dependency
  /* ... */
  return api;
});
```

`src/renderer/manifest.json` fixes the load order: `["themes","icon-data","icons","svg-builder","path-geometry",
"code-tokens","edges","layout","render-static","timeline","animations","page-runtime"]`. `page.html` has exactly two
placeholders, `<!--INJECT:FONTS-->` (a `<style>` with `@font-face` data-URI rules) and `<!--INJECT:RUNTIME-->`
(one `<script>` per module, manifest order). `src/capture/page-source.js` `buildPageHtml() -> string` performs the
injection. No `<script src>`, no `fetch`, no `url(file)`, no `<image href="file:...">` anywhere.

**B. Global API (`page-runtime.js`, Phase 0, frozen):**

```js
window.__TECH_GIF__ = {
  mount(normalizedScene)          -> { width, height, warnings: [], geometrySelfCheck: [{edgeId, dom, ours, relErr}] }
  mountSvg(svgString, scene)      -> same (fixture path used by test/browser.test.js)
  seek(timeMs)                    -> void   // pure function of timeMs: reset() then apply
  frameCount(stepMs)              -> integer
  measureText(text, fontSpec)     -> px     // hidden <text>.getComputedTextLength(), used by wrapText in the browser
}
```

`mount` = `TechGif.renderStatic.render(scene, ctx)` (Job A; `ctx = { measureText, iconData }`) -> `{ svgString,
warnings }`; `#root.innerHTML = svgString`; then `TechGif.animations.attach(svgEl, scene, TechGif.timeline,
pathMetrics)` (Job B) -> `{ seek }`. `pathMetrics` is built by page-runtime from `TechGif.pathGeometry` over the
normalized scene: `{ length(edgeId) -> px, pointAt(edgeId, px) -> {x, y} }`. After mount, page-runtime self-checks
every `path.edge-path`: `|ours - el.getTotalLength()| / ours < 0.005`, else throws. Runtime exceptions propagate.

**C. DOM contract (emitted by Job A, queried by Job B):**

```text
svg#scene[data-scene-id][viewBox="0 0 800 H"][width=800][height=H]
  defs         (markers, gradients, filters, clipPaths)
  g#layer-bg
  g#layer-sections
  g#layer-edges     > g.edge[data-edge-id][data-reveal-id] > path.edge-path[data-edge-id]      (body; dashed when edge.dashed)
                                                          > path.edge-tip[data-edge-id]       (solid 12 px terminal, marker-end)
                                                          > g.edge-label[data-edge-id]
  g#layer-particles  (empty at mount; runtime appends circle.particle[data-anim-index][data-particle-index] (+ .particle-glow, .particle-trail))
  g#layer-nodes     > g.node[data-node-id][data-reveal-id][data-cx][data-cy] > .node-shadow, .node-shape, .node-icon, .node-badge
  g#layer-labels    > g.node-label[data-node-id]  (text with tspans), text.edge-label[...], text.typing-target[data-text-id][data-full-text]
  g#layer-annotations > g.annotation[data-annotation-id][data-reveal-id]
  g#layer-title
  g#layer-brand
```

Rules: (1) the static renderer never sets `transform`, `opacity`, `style` or `stroke-dashoffset` on any element
carrying `data-edge-id` / `data-node-id` / `data-reveal-id`; it sets `stroke-dasharray` only on `path.edge-path`
of edges with `dashed: true`. (2) `reset()` removes `transform|opacity|style|stroke-dashoffset` from every managed
element, restores `stroke-dasharray` to the static value recorded at attach, empties `#layer-particles`, and restores
`textContent` of typing targets from `data-full-text` (typing baseline = empty string). (3) pulse/highlight transform
= `translate(cx,cy) scale(s) translate(-cx,-cy)` from `data-cx/data-cy`. (4) marching-dash mutates
`path.edge-path` only (never `.edge-tip`). (5) particle placement uses `pathMetrics` only — never
`getPointAtLength`. (6) `typing.targetId` resolves to `[data-text-id]`; `reveal.targetIds` to `[data-reveal-id]`.

**D. Normalized scene** (`normalize-scene.js`, pure, sorted keys, fixture `test/fixtures/mcp-vs-skills.normalized.json`):
input + every schema default + `layout.sections[]` expanded + `annotations: []` default + `assets` inlined as data
URIs + per-animation derived fields from 6.3 (`cycles`, `travelMs`, `segStartMs[]`, `segDurMs[]`, `offsetsMs[]`,
`effectiveSpeedPxPerSec`, `effectivePeriodMs`, `holdMs`, `stepStartsMs[]`) + `timeline.grids = { "40": 100, "50": 80 }`
(frame counts per step). Colours are **not** resolved (themes.js resolves at render time). `normalized.warnings[]`
carries hint deviations (> 25 %).

`validate(scene)` and `validateScene(scene)` mutate the authored argument: schema defaults are applied in place.
The mind-map extension additionally materializes `nodes`, `edges`, `timeline.animations`, and
`layout.mindmap.placement`. Before validating a previously materialized mind map, the presence of
`placement` causes those three generated arrays to be cleared and `placement` to be deleted. Structural
validation then precedes materialization, followed by the existing semantic checks and URL-footer checks.
Authored mind maps supply empty generated arrays. `placement` is derived, never trusted input.
Repeated `validateScene(validateScene(s).scene)` must be valid and byte-identical, including `placement`.
Generated mind maps are complete stills: one marching-dash animation plus one sequential-highlight
steps through branches in authored order. Fractional `dwellMs = durationMs / branchCount` is supported;
the runtime uses `floor(t * branchCount / durationMs)` with no transition or narrative fade.
Root/branch/leaf boxes are 200x96, 152x84 and 200x64, with 20/17/15 px labels and at most two lines.
Two-line leaves grow to 76 px high. Fixed x coordinates are 32, 280 and 480; all edges run straight
from right to left anchors. Authored branch order runs top to bottom in a compact, vertically
centered cluster; the root centers on that cluster. Pitch rounds down to a 16 px multiple, and
sibling leaves stack 12 px apart. Boxes cannot overlap and edges cannot cross non-endpoint boxes.
Infeasible layouts throw `MindmapLayoutError`; eight branches with two leaves each cannot fit
the 800x1100 canvas. Golden fixtures record that density rejection as well as fitting placements.
Branch halos wrap the branch and its leaves with exactly 16 px padding and eight-digit fill alpha.
`normalizeScene(input)` clones the input and calls `assertValid`; it injects no authored content and leaves
its caller's object untouched. Non-mindmap normalization must remain byte-identical to the neutral baseline.

The `url-footer` extension reserves the bottom 60 px and emits `rect.brand-bar` at `y = H-60` and exactly
one text node with one tspan whose `textContent` equals `brand.url`. It uses body weight 600, 16 px,
`x=400`, `y=H-24`, middle anchoring, and `theme.link` on `theme.footer`. Its measured width is at most
736 px, with contrast at least 4.5 across all five themes. The URL is required and at most 72 characters;
name, tagline, CTA, logo, mascot, avatar, socials, URL color overrides and save icons are forbidden.
Configured URLs canonicalize to `https://www.linkedin.com/(in|company)/<handle>` without a trailing
slash; credentials, query strings and fragments are forbidden. Public scene files use `{ "style": "none" }`.

**E. Stage interfaces** (`batch.js` takes `{ capture, encode, verify }` injected; testable with stubs):

```ts
capture(scene, { workDir, stepMs, launchArgs })  -> { framesDir, framePaths: string[] /* frame_%04d.png, 1600 wide */,
                                                     seamPath, width, height, frameHashes: string[], identicalRanges: [[i,j]],
                                                     fonts: [{family, status}], browserVersion, playwrightVersion, os, launchArgs }
encode({ scene, framesDir, framePaths, stepMs, rung, outPath, reservedColors })
                                                 -> { gifPath, encoder, rung, candidate, bytes, argv }
verify({ gifPath, framesDir, expectedWidth, expectedHeight, expectedDurationMs, stepMs, maxBytes, strictFrameCount,
         reservedColors, lossy })               -> quality object (7.4)
```

Additive agent batch options (the stage signatures above remain frozen):

```js
runBatch(inputs, { capture, encode, verify }, {
  rootDir,
  outputDir,    // default path.join(rootDir, 'output')
  workRoot,     // default path.join(rootDir, 'work')
  manifestPath,
  ...existingOptions
}) // => Promise<{ exitCode, manifest, manifestPath }>
```

Agent renders set `outputDir` to `out/<slug>`, `workRoot` to `out/<slug>/work/a<n>`, and
`manifestPath` to `out/<slug>/steps/04-render-a<n>.manifest.json`. Promotion replaces an existing GIF
only after the candidate passes the gate, using the shared atomic rename helper.

**F. Fixture** `test/fixtures/contract.svg` (3 nodes, 2 edges: one straight dashed, one orthogonal) conforms to C;
`test/contract.test.js` asserts the required ids/classes/attributes on the fixture and, when
`src/renderer/render-static.js` exists, on `renderStatic.render(normalizedExample, nodeCtx).svgString`.


## P0 helper exports and fixture notes

The section above preserves the renderer interfaces and records the additive agent contracts.
These concrete CommonJS exports make the Phase 1 integration points explicit:

- `src/schema.js`: `validate(scene) -> boolean` applies Ajv defaults to its argument and exposes `validate.errors`; `validateScene(scene) -> {valid, errors, scene}` collects `{path, message}` errors; `assertValid(scene)` returns the same defaulted scene or throws. These accept authored scenes, not normalized scenes with derived properties.
- `src/normalize-scene.js`: `normalizeScene(input)` (alias `normalize`) clones its input, validates, derives metadata, and returns recursively sorted keys. It leaves input untouched. `assets` maps `art:<name>` to data URIs; brand asset properties are also replaced by those URIs. Themes resolve animation colors later. Pulse non-divisor periods emit a rounding warning even below the general 25 percent hint threshold, as required by the P0 test.
- `src/renderer/path-geometry.js`: `anchor`, `buildPath`, `forEdge(edge, nodes)`, `buildScenePaths(scene)` (edge-id to path object), `createPathMetrics(scene)` (the contract's length/pointAt interface, plus `paths` and `chainLength`), and `chainLength(edgeIds, paths)`.
- Geometry uses `M x,y L x,y` or `M x,y C x,y x,y x,y` strings. Positive curve offsets use the normal `(-dy, dx)` in scene coordinates. A loop endpoint is 12 px along that side's tangent; controls extend `size` px along its outward normal. `center` loop sides use the rightward normal.
- `src/python.js`: `await resolvePython() -> {command, executable, args: [], version, pillowVersion, discoveredVia}`. The probe returns Python's real `sys.executable`, so the `py -3` launcher flags are not needed for later spawns. `runProcess(command, args, options)` captures `{code, stdout, stderr}` and always uses `shell:false`.
- `src/paths.js`: `ROOT` (alias `root`), `forward`, `absolute`, `rootPath`, `scenePaths(id) -> {workDir, outputDir, outPath}`, `expandInputs(args) -> sorted absolute paths`. Dynamic globs are passed to fast-glob after slash normalization; literal paths are checked directly.
- `src/renderer/icon-data.js` exports `iconData = {lucide, brands, colors}`. Each icon dictionary value is inner SVG markup with no outer SVG. `colors` maps brand slug to `#RRGGBB`. Historical upstream revisions for removed icons are recorded per file in the icon manifest.
- `fonts/manifest.json` contains `files` for the eight TTF faces and a separate `licenses` array. Each face has `family`, `weightRole`, CSS `weight`, local `file`, upstream `path`, local `license`, and `sha256`.
- `config/defaults.json` provides `ladder` for gifski, `pillowLadder` for Pillow, and the shared frame/caps/palette/launch defaults. Rungs use `rung`, `stepMs`, `fps`, and `width`; rung 4 is `safeOnly`.
- The fixture SVG includes JSON in `metadata#fixture-scene`: parse its text, then normalize it before `mountSvg`. Its nodes are `mcp-host` (55,180,130,76), `mcp-client` (300,180,140,76), and `mcp-server` (555,335,150,90). Its paths `e-host-client` and `e-client-server` have lengths 115 and 277 px. Do not pair this fixture with the flagship scene's different third-node geometry.
- `page-source.js` injects available modules in manifest order while Phase 1 is incomplete. The runtime reports the missing module at mount. `mountSvg` needs `animations` and `timeline`; `mount` additionally needs `renderStatic`. Both APIs are synchronous and propagate errors. The runtime calls the attached seek function at time zero before returning.
- Node 24 on this Windows host requires `node --test` discovery instead of `node --test test/`. All later `test/*.test.js` files are discovered automatically.
