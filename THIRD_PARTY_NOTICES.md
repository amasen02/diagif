# Third-party notices

The project code is MIT licensed. Bundled assets and installed dependencies retain
their own copyright notices and licences. The files listed below are authoritative;
retain them when redistributing the corresponding components. Asset manifests
record the upstream revision and SHA-256 of each bundled file.

## Fonts

These unmodified font files come from the Google Fonts repository. Each OFL font
ships the full SIL Open Font License 1.1 (OFL-1.1) beside the font. Reserved Font
Names below reflect the declarations in those bundled notices, rather than an
assumption that every family name is reserved.

| Family | Copyright notice | Licence file | Reserved Font Names declared |
| --- | --- | --- | --- |
| Lilita One | Copyright 2011 Juan Montoreano | `fonts/lilitaone/OFL.txt` | Lilita |
| Bebas Neue | Copyright 2010 Dharma Type | `fonts/bebasneue/OFL.txt` | None declared |
| Inter | Copyright 2020 The Inter Project Authors | `fonts/inter/OFL.txt` | None declared |
| Patrick Hand | Copyright 2010-2012 Patrick Wagesreiter | `fonts/patrickhand/OFL.txt` | None declared |
| JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors | `fonts/jetbrainsmono/OFL.txt` | None declared |
| Space Mono, regular and bold | Copyright 2016 The Space Mono Project Authors | `fonts/spacemono/OFL.txt` | None declared |

Permanent Marker is distributed under Apache License 2.0 (Apache-2.0), with the
full licence in `fonts/permanentmarker/LICENSE.txt`. Its upstream path is
`apache/permanentmarker` in Google Fonts. All eight font files and their licence
hashes are enumerated in `fonts/manifest.json`.

## Icons

Lucide icons are ISC licensed, copyright 2026 Lucide Icons and Contributors.
`assets/icons/lucide/LICENSE` includes the full ISC notice and the MIT notice for
icons derived from Feather, copyright 2013-present Cole Bemis. Both notices apply
to the respective subsets and must be retained.

Simple Icons artwork is distributed under CC0 1.0 Universal; the full text is in
`assets/icons/brands/LICENSE`. Brand names and marks remain trademarks of their
respective owners. CC0 does not grant trademark rights. Their use identifies the
products depicted and implies no affiliation or endorsement. Consult each brand's
usage requirements for your own publications. Upstream revisions, including
historical revisions for removed icons, are in `assets/icons/manifest.json`.

## Runtime dependencies

| Component | Licence | Notice location after installation |
| --- | --- | --- |
| Playwright and playwright-core | Apache-2.0 | `node_modules/playwright/LICENSE`, `node_modules/playwright/NOTICE`; corresponding playwright-core files |
| Ajv | MIT | `node_modules/ajv/LICENSE` |
| fast-glob | MIT | `node_modules/fast-glob/LICENSE` |
| linkedom 0.18.13 | MIT | `node_modules/linkedom/LICENSE` |
| Pillow, installed separately with Python | HPND (PIL Software License) | Pillow distribution's `LICENSE` |

The exact JavaScript dependency graph and versions are in `package-lock.json`.
Transitive packages retain their installed notices. Chromium is downloaded by
Playwright separately; its own third-party notices remain with that distribution.
Neither Chromium nor Python is bundled in the npm package.

## Optional encoders

gifski 1.34.0 is AGPL-3.0 licensed. gifsicle 1.95 is GPL-2.0-only licensed, as
stated in its [versioned README](https://github.com/kohler/gifsicle/blob/v1.95/README.md).
They are optional, user-downloaded executables invoked as separate
processes; no binaries, archives or linked encoder libraries are redistributed in
this repository or npm package. The pinned tool manifest and download script are
included so users can obtain and verify them independently. Their upstream source
and licence notices are available from [gifski](https://github.com/ImageOptim/gifski)
and [gifsicle](https://github.com/kohler/gifsicle). Pillow supports rendering without
either optional encoder.
