# Diagram proposal acceptance excerpt

This excerpt supplies the constraints a scene-authoring model needs at proposal
time. `docs/CONTRACT.md` remains the full renderer authority.

Return one JSON object matching the supplied original schema. A response is a
proposal only: it is accepted only after original-schema validation, deterministic
repair, claim coverage, Chromium inspection, render verification and the critic.

Grounding rules:

- A fact is grounded only when its quote is a normalised substring of the text
  extracted from its cited URL.
- Claims resolve primarily by their exact authored text. `claim.text` copies the
  diagram string character-for-character; it is never a rationale. A path is
  optional advisory context. Every title, subtitle, node label/secondary label,
  annotation, typing text, and mind-map label needs an explicit claim. Short edge
  labels and layout headers may be omitted as `authoring` unless they contain a
  substantive numerical or comparative assertion. Claims may cite only grounded
  fact IDs or `authoring` for visual wording.
- Never invent sources, fact IDs, or citations.

Scene rules:

- A normal proposal supplies authored `nodes`, `edges`, and timeline animations.
- A proposal must omit `brand`; the harness applies the configured brand after
  proposal validation.
- A mind-map proposal has `layout.kind: "mindmap"`, an authored root and branches,
  and empty `nodes`, `edges`, and `timeline.animations`. It must not author
  coordinates or `layout.mindmap.placement`; those are generated deterministically.
- A normal brief must not produce a mind map.
- Text must fit the canvas, node boxes need at least 16 px separation, and paths
  must not cross an unrelated node. Normal-scene boxes stay in x 32..768. Prefer
  concise labels and a readable hierarchy.

Brand rules applied by the harness:

- `style: "url-footer"` emits exactly one footer text node equal to the canonical
  LinkedIn URL at 16 px. It reserves the bottom 60 px.
- Public scenes use `{ "style": "none" }`.

Output only the complete JSON proposal. Do not wrap it in prose or a Markdown
fence.
