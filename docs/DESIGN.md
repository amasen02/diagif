# Renderer design

The renderer converts an authored scene into a self-contained SVG composition,
deterministic PNG frames and a verified looping GIF. This document describes the
base renderer architecture. [CONTRACT.md](CONTRACT.md) is the authority for exact
interfaces and subsequent additive extensions.

## Boundaries and data flow

```text
authored JSON -> schema + semantic validation -> normalised scene
             -> static SVG + periodic animation runtime
             -> Chromium mount, seek and capture
             -> encoder candidates -> decoded quality gate -> promotion
```

Host-side code is CommonJS. Renderer modules are UMD so the same implementation
runs under Node tests and inside Chromium without a bundler. Their load order is
fixed by `src/renderer/manifest.json`: themes, icon-data, icons, svg-builder,
path-geometry, code-tokens, edges, layout, render-static, timeline, animations,
page-runtime. Fonts and module sources are injected into the page as data URIs
and inline scripts. Rendering requires no remote resources or file URLs.

Validation uses the authored scene schema with defaults, then checks reference
integrity, geometry, content zones, label budgets and animation timing. The
normaliser clones its input, expands sections, embeds assets, derives timing
metadata and returns consistently ordered keys. Authored files must not contain
normalised-only metadata. Unknown icons and missing fonts fail explicitly.

## Composition and geometry

Geometry uses final CSS pixels on an 800 px-wide canvas, with a 32 px horizontal
margin, a 110 px title zone and a footer reservation where the brand style needs
one. Static SVG has separate layers for background, sections, edges, particles,
nodes, labels, annotations, title and brand. Managed IDs and data attributes are
part of the contract shared by the renderer and animation runtime.

The SVG builder escapes attributes and text. Labels wrap through a shared
measurement interface: estimates in pure Node tests and measured SVG text in the
browser. Themes supply colour and font roles; bundled font files keep layout
independent of a user's system fonts. Split comparisons, columns and freeform
layouts share the same node, edge and annotation primitives.

`path-geometry.js` supplies anchors, path strings, lengths and points. Straight
and orthogonal paths use direct arithmetic; cubic paths use a sampled chord
table. Particles and arrow tips use that same geometry. Chromium independently
checks path length at mount, requiring relative error below 0.005. Dashed edges
have a separate solid terminal segment so the arrowhead cannot fall into a gap.

## Time as an input

`window.__TECH_GIF__.mount(scene)` constructs the composition and attaches the
runtime. `seek(timeMs)` resets managed state and applies the scene at that time.
No wall clock or accumulated animation state controls capture. Reset restores
static dash values, clears particles and resets typing targets before applying
transforms, opacity and other managed attributes.

Every animation is periodic over the full scene duration. Integer cycles close
particle travel, marching dashes and pulses. Sequential highlights use integer
step arithmetic. Typing and reveal effects divide the loop into entry, hold and
exit phases; an authored cut exit is recorded explicitly. Positive modulo is
used for staggered phases, including times before a particle's offset.

Capture samples the half-open interval `0 <= t < durationMs`. A separate endpoint
image at `durationMs` must hash identically to frame zero. Primary capture uses
40 ms steps; the fallback uses a fresh 50 ms capture. Dropping frames from the
40 ms grid cannot produce the required 50 ms samples.

## Capture, encoding and acceptance

Playwright mounts a page with bundled fonts and checks their loaded status,
runtime availability, measured geometry and browser errors. Capture uses device
scale factor 2, producing PNGs at 1600 px wide. The encoder downsizes to delivery
width. Same-machine and same-Chromium-build PNG equality is the determinism
claim; equality across machines is outside that claim.

gifski is optional; Pillow provides the fallback. Optional gifsicle candidates
are assessed separately. Every process receives an argument array with
`shell:false`. Python must successfully import Pillow before selection. On
Windows the resolver considers the configured executable, `py -3`, then
`python`; on POSIX it can use `python3`.

The compression ladder stays within one encoder family. gifski rungs adjust
quality and motion settings before changing the capture grid. Pillow uses a
master palette sampled from full-size frames with reserved theme and animation
colours and no dithering. A two-pass approach limits memory by retaining indexed
frames rather than all full-resolution RGB images.

Project budgets are decimal bytes: a 5,000,000-byte primary target, an
8,000,000-byte hard cap and at most 250 decoded frames. These are renderer
budgets, not current promises about a hosting platform. The primary remains
800 px wide; a separate safe variant can use a 720 px rung with grain disabled.
Every attempted candidate, its size and its quality result are recorded.

The gate decodes the GIF and checks dimensions, an explicit infinite loop block,
positive grid-aligned delays, total duration, frame count, file size, seam hashes,
static-region stability and reserved colours. Identical-frame merging is allowed
when timing remains correct, unless strict frame count was requested. Reports
retain warnings and failures plus a PNG contact sheet with representative frames
and a first/last pair. Visual inspection is a separate acceptance step.

## Batches and verification

Batch execution injects capture, encode and verify stages behind frozen
interfaces. Each scene has isolated work and candidate paths. Failed scenes retain
evidence while other scenes continue; the manifest records every expanded input.
Candidates are promoted only after acceptance so a failed attempt cannot replace
an existing successful output. Concurrency is bounded across the whole pipeline.

Tests cover schema defaults, semantic errors, SVG structure, geometry, timing on
both grids, browser font loading, repeat-capture hashes, encoder argv, palette and
delay behaviour, and batch failure isolation. Real smoke scenes exercise the
whole pipeline. The quality report and artifacts provide evidence beyond a
successful process exit; a test count alone does not establish visual quality.
