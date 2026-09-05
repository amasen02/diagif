'use strict';

const { norm } = require('./research/extract.js');
const list = value => Array.isArray(value) ? value : [];

function resolvePointer(value, pointer) {
  if (typeof pointer !== 'string' || !/^\/(?:[^~]|~[01])*$/.test(pointer)) return undefined;
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Paths always refer to authored input, never generated mind-map nodes or brand.
function collectDiagramText(scene) {
  const slots = [];
  const add = (path, text) => { if (typeof text === 'string' && text.trim()) slots.push({ path, text }); };
  add('/title/text', scene.title?.text);
  // Explicit title lines are rendered instead of text. Identical wrapping is
  // already represented by title.text; differing wording must be grounded too.
  if (Array.isArray(scene.title?.lines) && norm(scene.title.lines.join(' ')) !== norm(scene.title.text)) {
    scene.title.lines.forEach((text, i) => add('/title/lines/' + i, text));
  }
  add('/title/subtitle/text', scene.title?.subtitle?.text);
  list(scene.layout?.labels).forEach((v, i) => add('/layout/labels/' + i, v));
  for (const group of ['sections', 'columns']) list(scene.layout?.[group]).forEach((v, i) => add('/layout/' + group + '/' + i + '/header', v?.header));
  const generated = scene.layout?.kind === 'mindmap';
  (generated ? [] : list(scene.nodes)).forEach((n, i) => {
    add('/nodes/' + i + '/label', n?.label); add('/nodes/' + i + '/secondaryLabel', n?.secondaryLabel);
  });
  (generated ? [] : list(scene.edges)).forEach((e, i) => add('/edges/' + i + '/label/text', e?.label?.text));
  list(scene.annotations).forEach((a, i) => {
    const at = '/annotations/' + i;
    add(at + '/text', a?.text);
    list(a?.lines).forEach((v, j) => add(at + '/lines/' + j + '/text', v?.text));
    list(a?.header).forEach((v, j) => add(at + '/header/' + j, v));
    list(a?.rows).forEach((r, j) => list(r).forEach((v, k) => add(at + '/rows/' + j + '/' + k, v)));
  });
  (generated ? [] : list(scene.timeline?.animations)).forEach((a, i) => add('/timeline/animations/' + i + '/text', a?.text));
  const tree = scene.layout?.mindmap;
  add('/layout/mindmap/root/label', tree?.root?.label);
  list(tree?.branches).forEach((b, i) => {
    const at = '/layout/mindmap/branches/' + i;
    add(at + '/label', b?.label);
    list(b?.leaves).forEach((l, j) => add(at + '/leaves/' + j + '/label', l?.label));
  });
  return slots;
}

function normalizeClaimPath(scene, pointer) {
  if (typeof pointer !== 'string') return undefined;
  const stripped = pointer.replace(/^\/scene(?=\/)/, '');
  return stripped.replace(/^\/(nodes|edges)\/([^/]+)(?=\/)/, (prefix, group, key) => {
    const values = list(scene[group]);
    if (/^(0|[1-9]\d*)$/.test(key) && Object.hasOwn(values, key)) return prefix;
    const id = key.replace(/~1/g, '/').replace(/~0/g, '~');
    const index = values.findIndex(value => value?.id === id);
    return index < 0 ? prefix : '/' + group + '/' + index;
  });
}

function classifySlot(slot) {
  if (!/^\/(?:edges\/\d+\/label\/text|layout\/(?:labels\/\d+|(?:sections|columns)\/\d+\/header))$/.test(slot.path)) return 'substantive';
  const text = norm(slot.text).replace(/^\s*\d+[.)]\s*/, '');
  if (/[\d%]/.test(text) || /\b\w+er than\b/i.test(text) || /\b\d+\s*x\b/i.test(text) || /\b(more|less|fewer) than\b/i.test(text)) return 'escalated';
  if (/\b(only|all|every|always|never|best|worst|most|least|more|less|fewer|guarantees|ensures|prevents|eliminates)\b/i.test(text)) return 'marker';
  return 'connective';
}

function matchClaim(scene, slots, claim) {
  const path = normalizeClaimPath(scene, claim.path);
  const matches = typeof claim.text === 'string' ? slots.filter(slot => norm(slot.text) === norm(claim.text)) : [];
  if (matches.length) return { matches, resolvedBy: 'text', path };
  const slot = slots.find(slot => slot.path === path);
  return { matches: slot ? [slot] : [], resolvedBy: 'path', path };
}

function claimsCover(scene, claims, factSheet) {
  const slots = collectDiagramText(scene), covered = new Map(), errors = [], warnings = [], resolved = [];
  const factIds = new Set((factSheet?.facts || []).map(f => f.id));
  const autoAuthoringSlots = [], escalatedSlots = [], uncoveredSubstantiveTexts = [];
  for (const claim of claims || []) {
    const match = matchClaim(scene, slots, claim), path = match.path || '/claims';
    if (!Array.isArray(claim.supports) || !claim.supports.length) errors.push({ path, message: 'Claim requires support' });
    else for (const id of claim.supports) if (id !== 'authoring' && !factIds.has(id)) errors.push({ path, message: 'Unknown supporting fact: ' + id });
    if (!match.matches.length) {
      // Older proposals redundantly claimed individual wrapped title lines.
      // Accept this redundancy only when the complete rendered title is equal.
      const redundant = /^\/title\/lines\/\d+$/.test(path) && typeof claim.text === 'string'
        && norm(resolvePointer(scene, path)) === norm(claim.text)
        && Array.isArray(scene.title?.lines) && norm(scene.title.lines.join(' ')) === norm(scene.title.text);
      if (redundant) warnings.push({ code: 'redundant-title-line-claim', path, text: claim.text });
      else {
        errors.push({ path, message: 'Claim matches no diagram text or path: "' + claim.text + '"' });
        resolved.push({ ...claim });
      }
      continue;
    }
    const next = { ...claim, resolvedBy: match.resolvedBy, resolvedPaths: match.matches.map(slot => slot.path) };
    if (match.resolvedBy === 'path') {
      next.path = path; next.text = match.matches[0].text;
      warnings.push({ code: 'claim-text-paraphrased', path, text: next.text, oldText: claim.text });
    } else if (claim.path !== undefined && !match.matches.some(slot => slot.path === path)) {
      warnings.push({ code: 'claim-path-advisory', path: String(claim.path), text: claim.text });
    }
    for (const slot of match.matches) {
      const supports = covered.get(slot.path) || new Set();
      for (const id of list(claim.supports)) supports.add(id);
      covered.set(slot.path, supports);
    }
    resolved.push(next);
  }
  for (const slot of slots) {
    const kind = classifySlot(slot);
    if (kind === 'escalated') escalatedSlots.push({ ...slot });
    if (kind === 'marker') warnings.push({ code: 'connective-marker', ...slot });
    if (covered.has(slot.path)) continue;
    if (kind === 'connective' || kind === 'marker') {
      autoAuthoringSlots.push({ ...slot, supports: ['authoring'] });
      resolved.push({ ...slot, supports: ['authoring'], resolvedBy: 'auto-authoring', resolvedPaths: [slot.path] });
      covered.set(slot.path, new Set(['authoring']));
    } else {
      errors.push({ path: slot.path, message: 'Substantive diagram text has no matching claim: "' + slot.text + '"' });
      uncoveredSubstantiveTexts.push(slot.text);
    }
  }
  errors.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.message.localeCompare(b.message, 'en'));
  return { ok: !errors.length, errors, slots: slots.map(slot => ({ ...slot, supports: [...(covered.get(slot.path) || [])] })),
    claims: resolved, warnings, autoAuthoringSlots, escalatedSlots, uncoveredSubstantiveTexts };
}

function carryClaims(scene, claims, trace = [], beforeScene) {
  if (!beforeScene) {
    // The trace is sufficient for standalone repair callers too. Reconstruct
    // original label text before resolving, so path fallback cannot bypass the
    // meaning guard merely because the caller omitted an explicit snapshot.
    beforeScene = structuredClone(scene);
    for (const edit of [...trace].reverse()) if (edit.rule === 'label-overflow' && typeof edit.old === 'string') {
      const split = edit.path.lastIndexOf('/'), parent = resolvePointer(beforeScene, edit.path.slice(0, split));
      const key = edit.path.slice(split + 1).replace(/~1/g, '/').replace(/~0/g, '~');
      if (parent && typeof parent === 'object' && Object.hasOwn(parent, key)) parent[key] = edit.old;
    }
  }
  const slots = collectDiagramText(beforeScene), nextSlots = new Map(collectDiagramText(scene).map(slot => [slot.path, slot]));
  const result = [];
  for (const claim of claims || []) {
    const matched = matchClaim(beforeScene, slots, claim), pointer = normalizeClaimPath(beforeScene, claim.path);
    const deleted = trace.find(edit => edit.rule === 'unknown-property' && edit.new === null
      && pointer && (pointer === edit.path || pointer.startsWith(edit.path + '/')));
    if (deleted && !matched.matches.length) { deleted.claimDropped = true; continue; }
    if (!matched.matches.length) { result.push({ ...claim }); continue; }
    const changes = matched.matches.filter(slot => nextSlots.get(slot.path)?.text !== slot.text);
    if (!changes.length) { result.push({ ...claim }); continue; }
    for (const slot of matched.matches) {
      const next = nextSlots.get(slot.path);
      if (!next) {
        const removedSlot = trace.find(edit => edit.rule === 'unknown-property' && edit.new === null
          && (slot.path === edit.path || slot.path.startsWith(edit.path + '/')));
        if (removedSlot) removedSlot.claimDropped = true;
        else result.push({ ...claim, path: slot.path, text: slot.text, resolvedPaths: [slot.path] });
        continue;
      }
      if (slot.text === next.text) { result.push({ ...claim, path: slot.path, text: slot.text, resolvedPaths: [slot.path] }); continue; }
      const edits = trace.filter(edit => edit.path === slot.path);
      const originalWords = slot.text.trim().split(/\s+/).length, nextWords = next.text.trim().split(/\s+/).length;
      if (!edits.length || edits.some(edit => edit.rule !== 'label-overflow') || nextWords < originalWords / 2) continue;
      for (const edit of edits) edit.claimCarried = true;
      result.push({ ...claim, path: slot.path, text: next.text, resolvedPaths: [slot.path], claimCarried: true });
    }
  }
  return result;
}

module.exports = { collectDiagramText, claimsCover, resolvePointer, carryClaims, normalizeClaimPath, classifySlot };
