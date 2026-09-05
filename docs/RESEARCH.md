# Methodology: readable technical animation

This project translates technical explanations into diagrams that remain useful
when paused. The research question is practical: which visual and engineering
rules make a compact looping diagram readable, inspectable and reproducible?
It is not a study of audience growth, and the name does not imply measured
virality or guaranteed engagement.

The method combines public technical specifications, accessibility guidance and
local artifact inspection. Sources below establish constraints on text contrast,
motion and GIF encoding. Layout density, theme choices and scene budgets are
project design decisions derived from those constraints; they are not claims of
experimental superiority. This document contains no sample-level engagement
dataset or reproductions of reference artwork.

## Readability before decoration

W3C's explanation of text contrast includes images of text and identifies 4.5:1
as the normal-text threshold, with a lower threshold for large text. It also
explains that thin strokes and anti-aliasing can make nominally sufficient text
look faint. We therefore treat contrast as a starting point and inspect text at
its intended display size. The derived rule is to shorten labels, use distinct
foreground/background roles and reserve enough padding for measured line wraps.
Font fallback is a render error because it can alter both line breaks and visual
weight. [W3C: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

A diagram should carry one main claim. Stable nodes and labels explain the
structure; moving particles, dashes or a small emphasis cycle explain direction
or sequence. A title must help interpret the relationships rather than merely
repeat a topic name. Comparisons use parallel labels and a shared visual scale.
These are authoring rules, not conclusions about any particular audience.

## Motion is an additional reading channel

W3C describes a pause, stop or hide requirement for qualifying automatic motion
lasting more than five seconds alongside other content. A GIF file alone does
not provide such controls. Consequently, a short loop is not an accessibility
guarantee, and an endlessly repeated short loop is still ongoing motion. When
embedding the result, provide suitable playback controls or a static alternative
and a text explanation. Keep essential facts available outside the animation.
The renderer's static SVG and PNG previews support that workflow.
[W3C: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)

The derived animation rule is a readable composition with restrained motion
overlaid. Avoid making the reader chase moving labels. Reveal and typing effects
need a deliberate exit phase, while ambient effects use whole cycles per loop.
Inspect the last sampled frame beside the first and independently compare the
first frame with the state at the full loop duration. Those tests answer different
questions: continuity across playback and exact periodic closure.

## Encoding is part of the visual design

GIF89a defines indexed colour tables and frame delays in hundredths of a second.
This makes palette selection and exact timing part of the deliverable, not merely
export settings. The derived rule is to keep a compact, stable palette and use
capture intervals that are exactly representable as GIF delays. The project uses
40 ms and 50 ms grids, with loop durations divisible by both. Small decorative
details must justify their encoded size and survive downscaling.
[GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)

Pillow documents multi-frame GIF writing, duration and loop options, disposal
behaviour and palette optimisation. We use these controls to make the fallback
encoder explicit, then decode the output to measure what was actually written.
A lower decoded frame count can be legitimate when identical frames merge;
the total duration must still match and every delay must remain positive and on
the selected grid. Palette stabilisation is assessed in image regions that are
static in the source frames.
[Pillow: GIF format](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#gif)

## Evidence and limitations

For a scene revision, validate the authored JSON, render with pinned assets,
retain the manifest and candidate quality reports, and inspect the contact sheet.
Compare dimensions, bytes, duration, delays, seam hashes and static-region
flicker before accepting the output. Keep the failed candidates so an apparent
improvement can be traced to a specific encoding or layout change. A smaller
file is not an improvement if text becomes unstable or an arrow disappears.

Technical claims need a separate evidence check: preserve source URLs and short
supporting quotes, verify their containment in extracted source text, and map
diagram text to supported facts or explicitly authored framing. Quote containment
establishes provenance, not truth. A source may itself be wrong, outdated or
incomplete, so the final post still needs subject-matter review.

Visual inspection remains necessary because pixel gates do not prove that an
explanation is clear. Same-machine, same-browser-build frame equality is the
determinism scope; cross-machine pixel equality is not claimed. Heuristic topic
ranking is an ordering aid, not a probability of success. Public-source guidance
was checked on 2026-09-05; installation and publishing requirements can change
independently of these renderer rules.
