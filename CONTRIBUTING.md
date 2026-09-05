# Contributing

Use Node 24 or later, Python 3.12 with Pillow and Git; ripgrep is optional. From a source
checkout, install the pinned JavaScript dependencies with `npm ci`, Python
dependencies with `python -m pip install -r requirements.txt`, and Chromium with
`npx playwright install chromium`. Linux also needs
`npx playwright install-deps chromium`. On Windows, `py -3` can select Python.

Run `node src/cli.js doctor` before rendering. Read [the renderer contract](docs/CONTRACT.md)
before changing scene normalisation, the SVG DOM, capture, encoding or verification.
The [design notes](docs/DESIGN.md) explain the renderer's boundaries; the
[methodology](docs/RESEARCH.md) explains the visual and evidence rules.

## Changes and validation

Keep changes focused. Describe the concrete problem, resulting behaviour and
actual validation in the pull request. For logic changes, include tests that
exercise the failure and accepted behaviour. Preserve the original schema as the
acceptance authority; provider wire schemas are only transport projections.
Never lower a quality threshold or remove an assertion to make a result pass.

```sh
npm test
node src/cli.js validate 'scenes/*.json'
node scripts/sanitize-public-docs.js --check
npm pack --dry-run --json
```

Render affected scenes, inspect the contact sheets at reading size, and check
the quality report's `failures` array. A successful subprocess exit is insufficient
without its expected artifacts. Cross-platform CI forces Pillow; optional encoder
downloads are excluded. Hosted-provider tests require an explicit opt-in and are
excluded from CI. Never include credentials or real provider responses containing
private data in fixtures.

Every subprocess must use an executable plus an argument array with `shell:false`.
Windows command and batch shims must not be spawned. Keep renderer modules UMD,
browser-safe and in manifest load order. Verify changes to timing on both capture
grids and preserve same-build seam and repeat-render checks.

## Public files

Scenes contributed to the gallery use `brand: {"style":"none"}`. Personal branding
belongs in the ignored user config. Keep research caches, run artifacts, model
transcripts, machine paths and planning notes outside the public file set. An
external literal denylist can be supplied with `--denylist FILE`; it is never
copied into the repository. If Git or ripgrep is unavailable, the sanitiser uses
its built-in ignored-tree and text scanners. `DIAGIF_RG` may point to a native
ripgrep executable; command and batch shims are rejected. A known-safe test line
may be exempted only with `// sanitize-allow: reason` in JavaScript,
`# // sanitize-allow: reason` in a Python comment, or
`<!-- sanitize-allow: reason -->` in Markdown. The marker exempts that line only.
The sanitiser reports file/line locations without echoing possible credentials. Run it again after
staging: in its own Git repository it checks tracked files, while a source folder
without its own repository uses its non-ignored working tree.

The npm allowlist excludes generated output, example GIFs and optional binaries.
Review the actual pack file list by path prefix: `src/agent/research/` is source
code and must remain packaged, while a top-level research directory is private.
Keep font and icon licences alongside the assets. Asset pin changes require hash
verification and a fresh render review.

## Assisted development

The initial implementation used GPT-5.6 Sol for planning, Fable 5.1 for adversarial
critique, and GPT-5.6 Luna for bounded execution. Human maintainers review the
resulting changes and artifacts. Model output is a proposal, not acceptance
evidence; contributions are held to the same tests regardless of how they were
written.

## Release preparation

Before publishing, rerender six neutral examples across at least four domains,
including a mind map. Require each GIF to be smaller than 600,000 bytes with an
empty `failures` array. Refresh the example links, render summary and changelog;
inspect the npm pack contents and rerun sanitisation after staging. The historical
render snapshot is not evidence for newly generated examples. Verify the intended
repository root and remote before any release operation. Publishing is a separate
maintainer action; no GIF-generation command posts content.

Project tracker: https://github.com/amasen02/diagif/issues
