---
name: gif-explainer
description: Creates a high-quality animated GIF explaining a technical topic, or an animated mind map of it, using diagif. Use when the user asks for a GIF, animation, diagram, explainer visual, mind map, or a shareable visual for a post on any technical subject.
---

# GIF explainer

Use `make` for an explainer and `mindmap` for an 800x1100 mind map.
Agents use the spawn-safe entry point `node "{{TOOL_ROOT}}\bin\diagif.js"`.
Pass arguments as separate array entries when spawning a process.
A `diagif.cmd` shim exists on PATH for humans typing interactively.
Node must never spawn the `.cmd` with `shell:false`: Node 24 raises EINVAL.

## Commands (PowerShell)

```powershell
node "{{TOOL_ROOT}}\bin\diagif.js" doctor
node "{{TOOL_ROOT}}\bin\diagif.js" auth --json
node "{{TOOL_ROOT}}\bin\diagif.js" auth --login codex
node "{{TOOL_ROOT}}\bin\diagif.js" auth --login claude
node "{{TOOL_ROOT}}\bin\diagif.js" make "How DNS works" --brain codex-cli --research live --out "{{TOOL_ROOT}}\out"
node "{{TOOL_ROOT}}\bin\diagif.js" mindmap "agentic AI" --brain mock --research mock --out "{{TOOL_ROOT}}\out\skill-smoke" --fresh
```

The codex-cli and claude-cli brains use the operator's ChatGPT or Claude
subscription respectively; choose the authenticated one. The mock example
works offline without credentials and produces fixture content, not researched facts.
Mock research topics: `explain RAG`, `REST API optimisation techniques`, `agentic AI`.
For a real mind map, use `--brain codex-cli --research live` (or `claude-cli`).
Both generation commands accept `--model NAME`, `--config FILE`, `--out DIR`,
`--max-model-calls N` (1..200), `--dry-run`, and `--research live|mock`.
Use `--resume` or `--resume-slug SLUG` to continue, or `--fresh` for a new run.
`--allow-html-search` enables HTML search; `--` ends options before topic text.
Dry-run does not prove that a GIF rendered.
The explicit output directory receives a unique topic-slug folder containing
`run.json`, the GIF, its `.quality.json` report, and render/critic evidence.

## Standing rules

- Output stays local; nothing is published without an explicit instruction.
- Commits carry no attribution, session, or tool-signature trailers.
- The GIF brand footer is the operator's LinkedIn URL and nothing else. Use
  `node "{{TOOL_ROOT}}\bin\diagif.js" brand --url "<operator LinkedIn URL>"`
  only with the known URL; never invent one. `brand --clear` removes it.

## Verify before claiming success

Open the produced GIF and look at it; an exit code is not evidence.
Check readable labels, correct topic, no overlaps, motion, and the loop seam.
Inspect the `.quality.json` report for `failures: []`, decoded frame count
matching the expected count, and a passing seam check (`loopSeamOk: true`).
Read `run.json` and critic evidence; disclose remaining warnings or unmeasured
checks. Return the local GIF path and verified observations.
