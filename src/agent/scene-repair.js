'use strict';

// Repairs are mechanical: they improve schema fitness without inventing facts.
const { resolvePointer } = require('./claims.js');
const LUCIDE = ['laptop', 'monitor', 'server', 'database', 'cloud', 'globe', 'user', 'users', 'bot', 'cpu', 'folder', 'file-text', 'file-code', 'mail', 'message-square', 'calendar', 'lock', 'key', 'shield', 'git-branch', 'network', 'route', 'zap', 'clock', 'layers', 'box', 'package', 'table', 'list', 'search', 'settings', 'plug', 'cable', 'arrow-right-left', 'timer', 'bell', 'gauge', 'hard-drive', 'wifi', 'check', 'x', 'bookmark-plus', 'refresh-cw'];
const BRANDS = ['mongodb', 'redis', 'postgresql', 'mysql', 'rabbitmq', 'slack', 'gmail', 'jira', 'confluence', 'asana', 'googledocs', 'googlecalendar', 'openai', 'anthropic', 'googlegemini', 'docker', 'kubernetes', 'apachekafka', 'github', 'python', 'react', 'nodedotjs', 'typescript', 'linkedin', 'x'];
const esc = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const snap = value => Math.round(value / 16) * 16;
function distance(a, b) {
  a = String(a).toLowerCase(); b = String(b).toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prior = row[0]++;
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prior + (a[i - 1] === b[j - 1] ? 0 : 1)); prior = old; }
  }
  return row[b.length];
}
function closest(name, choices) { return choices.map(value => ({ value, d: distance(name, value) })).sort((a, b) => a.d - b.d || a.value.localeCompare(b.value, 'en'))[0]; }
function intersection(a, b) {
  if (![a?.x, a?.y, a?.w, a?.h, b?.x, b?.y, b?.w, b?.h].every(Number.isFinite)) return { w: 0, h: 0, area: 0 };
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return { w, h, area: w * h };
}

function deterministicRepair(scene, options = {}) {
  // Keep this module injectable for harness tests; production uses the shared
  // validator/measurement implementation, but callers with all three hooks do
  // not need to load renderer-backed schema code.
  const schema = options.validate && options.measureLines && options.zone ? null : require('../schema.js');
  const validate = options.validate || schema.validateScene;
  const measureLines = options.measureLines || schema.wrapLines;
  const zone = options.zone || (scene.canvas ? schema.contentZone(scene) : null);
  const trace = []; trace.penalties = [];
  const initialLabelDimension = new WeakMap();
  const textForMeasure = value => typeof value === 'string' ? value : '';
  const lookup = path => resolvePointer(scene, path);
  const parts = path => path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  function edit(path, value, rule) {
    const old = lookup(path); if (Object.is(old, value)) return false;
    const keys = parts(path), key = keys.pop(), parent = keys.reduce((valueAtPath, k) => valueAtPath?.[k], scene);
    if (!parent || typeof parent !== 'object') return false;
    parent[key] = value; trace.push({ path, old: old === undefined ? null : old, new: value, rule }); return true;
  }
  function remove(path, rule) {
    const old = lookup(path); if (old === undefined) return false;
    const keys = parts(path), key = keys.pop(), parent = keys.reduce((valueAtPath, k) => valueAtPath?.[k], scene);
    if (!parent || !Object.hasOwn(parent, key)) return false;
    delete parent[key]; trace.push({ path, old, new: null, rule }); return true;
  }
  // Ajv applies schema defaults and mind-map materialization.  Repair must not
  // silently make either mutation: every authored-scene change needs a trace.
  const runValidation = () => validate(structuredClone(scene)) || { valid: false, errors: [] };
  const nodeEntries = () => (Array.isArray(scene.nodes) ? scene.nodes : []).map((node, index) => ({ node, index, path: '/nodes/' + index }))
    .filter(({ node }) => node && typeof node === 'object').sort((a, b) => String(a.node.id || '').localeCompare(String(b.node.id || ''), 'en'));
  function metrics(node) {
    const width = node.labelRotate === -90 ? node.h : node.w, available = node.labelRotate === -90 ? node.w : node.h;
    if (!Number.isFinite(width) || !Number.isFinite(available)) return { required: 0, available: 0 };
    const labelText = textForMeasure(node.label), secondaryText = textForMeasure(node.secondaryLabel);
    const iconSize = node.icon ? (node.icon.size ?? 28) : 0;
    // Keep this in lock-step with render-static's nodeParts geometry.  Panel
    // labels move below an icon only when the icon's horizontal reservation
    // would wrap the label; their top padding is not available label height.
    const horizontalWidth = width - 24 - (iconSize ? iconSize + 8 : 0);
    const needsBelowIcon = iconSize && measureLines(labelText, Math.max(12, horizontalWidth), 16) > 1;
    const panelBelowIcon = node.shape === 'panel' && needsBelowIcon;
    const stacked = iconSize && node.shape !== 'panel' && (available >= 84 || needsBelowIcon);
    const labelWidth = Math.max(12, width - 24 - (iconSize && !stacked && !panelBelowIcon ? iconSize + 8 : 0));
    const label = measureLines(labelText, labelWidth, 16) * 20;
    const secondary = secondaryText ? measureLines(secondaryText, labelWidth, 11) * 13.75 + 3 : 0;
    const labelHeight = label + secondary;
    const rendererRequired = panelBelowIcon ? 14 + iconSize + 10 + labelHeight + 4
      : labelHeight + (stacked ? iconSize + 5 : 0) + 8;
    // validateScene also has a deliberately conservative generic fit check
    // (notably its 12px secondary font).  Repair must satisfy both gates.
    const genericWidth = width - 24;
    const genericRequired = measureLines(labelText, genericWidth, 16) * 16 * 1.2
      + (secondaryText ? measureLines(secondaryText, genericWidth, 12) * 12 * 1.2 : 0) + iconSize + 8;
    return { required: Math.max(rendererRequired, genericRequired), available };
  }
  function outside(box) {
    if (!zone || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return 0;
    const insideW = Math.max(0, Math.min(box.x + box.w, zone.x + zone.w) - Math.max(box.x, zone.x));
    const insideH = Math.max(0, Math.min(box.y + box.h, zone.bottom) - Math.max(box.y, zone.y));
    return Math.max(0, box.w * box.h - insideW * insideH);
  }
  function penalty() {
    let total = 0; const list = nodeEntries();
    for (let i = 0; i < list.length; i++) {
      const m = metrics(list[i].node); total += Math.max(0, m.required - m.available) * (Number(list[i].node.w) || 0);
      for (let j = i + 1; j < list.length; j++) total += intersection(list[i].node, list[j].node).area;
    }
    for (const item of allBoxes()) total += outside(item.node);
    return total;
  }
  const inZone = node => !zone || [node.x, node.y, node.w, node.h].every(Number.isFinite) &&
    node.x >= zone.x && node.y >= zone.y && node.x + node.w <= zone.x + zone.w && node.y + node.h <= zone.bottom;

  function fixUnknownProperties(errors) {
    let changed = false;
    for (const error of errors || []) if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
      const base = error.path || error.instancePath || '';
      changed = remove((base === '/' ? '' : base) + '/' + esc(error.params.additionalProperty), 'unknown-property') || changed;
    }
    return changed;
  }
  function fixIcons() {
    let changed = false;
    for (const { node, path } of nodeEntries()) if (node.icon && ['line', 'brand'].includes(node.icon.source || 'line')) {
      const source = node.icon.source || 'line', choices = source === 'brand' ? BRANDS : LUCIDE;
      if (choices.includes(node.icon.name)) continue;
      const match = closest(node.icon.name, choices);
      if (match.d <= 3) changed = edit(path + '/icon/name', match.value, 'unknown-icon') || changed;
      else {
        if (source === 'brand') changed = edit(path + '/icon/source', 'line', 'unknown-icon') || changed;
        changed = edit(path + '/icon/name', 'box', 'unknown-icon') || changed;
      }
    }
    return changed;
  }
  function fixAnimationCardinality() {
    let changed = false;
    const animations = Array.isArray(scene.timeline?.animations) ? scene.timeline.animations : [];
    for (let i = 0; i < animations.length; i++) {
      const a = scene.timeline.animations[i], path = '/timeline/animations/' + i;
      if (a.kind === 'particle-flow') {
        if (a.cyclesPerLoop !== undefined && a.speedPxPerSec !== undefined) changed = remove(path + '/speedPxPerSec', 'animation-cardinality') || changed;
        else if (a.cyclesPerLoop === undefined && a.speedPxPerSec === undefined) changed = edit(path + '/cyclesPerLoop', 2, 'animation-cardinality') || changed;
        if (a.colorRole !== undefined && a.color !== undefined) changed = remove(path + '/color', 'animation-cardinality') || changed;
      } else if (a.kind === 'pulse') {
        if (a.cyclesPerLoop !== undefined && a.periodMs !== undefined) changed = remove(path + '/periodMs', 'animation-cardinality') || changed;
        else if (a.cyclesPerLoop === undefined && a.periodMs === undefined) changed = edit(path + '/cyclesPerLoop', 2, 'animation-cardinality') || changed;
      }
    }
    return changed;
  }
  function shorten(node, path) {
    const old = lookup(path), words = typeof old === 'string' ? old.trim().split(/\s+/).filter(Boolean) : [];
    if (words.length < 3) return false;
    const key = path.endsWith('/secondaryLabel') ? 'secondaryLabel' : 'label';
    for (let count = words.length - 1; count >= 3; count--) {
      const value = words.slice(0, count).join(' '); node[key] = value;
      const fits = metrics(node).required <= metrics(node).available; node[key] = old;
      if (fits) return edit(path, value, 'label-overflow');
    }
    return false;
  }
  function fixLabelOverflow() {
    if (!zone) return false;
    let changed = false;
    for (const item of nodeEntries()) {
      const { node, path } = item; let m = metrics(node); if (m.required <= m.available) continue;
      const key = node.labelRotate === -90 ? 'w' : 'h';
      const start = initialLabelDimension.has(node) ? initialLabelDimension.get(node) : node[key];
      if (!Number.isFinite(start)) continue;
      initialLabelDimension.set(node, start);
      const max = start + 40;
      while (node[key] + 8 <= max && m.required > m.available) {
        const candidate = { ...node, [key]: node[key] + 8 };
        const newOverlap = nodeEntries().some(other => other.node !== node && intersection(candidate, other.node).area && !intersection(node, other.node).area);
        if (!inZone(candidate) || newOverlap) break;
        edit(path + '/' + key, candidate[key], 'label-overflow'); changed = true; m = metrics(node);
      }
      if (m.required > m.available) changed = shorten(node, path + '/label') || changed;
      if (metrics(node).required > metrics(node).available && node.secondaryLabel) changed = shorten(node, path + '/secondaryLabel') || changed;
    }
    return changed;
  }
  function move(item, axis, delta) {
    const candidate = { ...item.node, [axis]: snap(item.node[axis] + delta) };
    return inZone(candidate) && edit(item.path + '/' + axis, candidate[axis], 'node-overlap');
  }
  function minimumWidth(node) {
    if (!Number.isFinite(node.w) || !Number.isFinite(node.h)) return node.w;
    for (let width = 32; width <= node.w; width += 16) {
      const candidate = { ...node, w: width }, measured = metrics(candidate);
      if (measured.required <= measured.available) return width;
    }
    return node.w;
  }
  function shrink(item) {
    if (!Number.isFinite(item.node.w)) return false;
    const min = minimumWidth(item.node); return item.node.w - 16 >= min && edit(item.path + '/w', item.node.w - 16, 'node-overlap');
  }
  function fixOverlaps() {
    if (!zone) return false;
    let changed = false;
    for (let pass = 0; pass < 16; pass++) {
      let passChanged = false; const list = nodeEntries();
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const earlier = list[i], later = list[j], hit = intersection(earlier.node, later.node); if (!hit.area) continue;
        const axis = hit.w <= hit.h ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h';
        const direction = later.node[axis] + later.node[size] / 2 >= earlier.node[axis] + earlier.node[size] / 2 ? 1 : -1;
        const amount = Math.ceil((hit[axis === 'x' ? 'w' : 'h'] + 16) / 16) * 16;
        let moved = move(later, axis, direction * amount);
        if (!moved) moved = move(earlier, axis, -direction * amount);
        if (!moved) moved = shrink(later) || shrink(earlier);
        passChanged = moved || passChanged; changed = moved || changed;
      }
      if (!passChanged) break;
    }
    return changed;
  }
  function allBoxes() {
    const list = nodeEntries();
    (Array.isArray(scene.annotations) ? scene.annotations : []).forEach((node, index) => {
      if (!node || typeof node !== 'object') return;
      if (![node.x, node.y].every(Number.isFinite)) return;
      const w = node.w ?? (['badge', 'check', 'cross'].includes(node.kind) ? 28 : node.maxWidth ?? 190);
      const font = node.fontSize || 20;
      const h = node.h ?? (['badge', 'check', 'cross'].includes(node.kind) ? 28 : node.kind === 'code' ? (node.lines?.length || 1) * font * 1.35 + 24 : node.kind === 'table' ? ((node.rows?.length || 0) + 1) * 28 + 16 : measureLines(textForMeasure(node.text), w, font) * font * 1.2);
      if ([w, h].every(Number.isFinite)) list.push({ node: { ...node, w, h }, source: node, path: '/annotations/' + index });
    });
    (Array.isArray(scene.layout?.columns) ? scene.layout.columns : []).forEach((node, index) => {
      if (!node || typeof node !== 'object') return;
      if ([node.x, node.y, node.w, node.h].every(Number.isFinite)) list.push({ node, path: '/layout/columns/' + index });
      if (node.innerPanel && [node.innerPanel.x, node.innerPanel.y, node.innerPanel.w, node.innerPanel.h].every(Number.isFinite)) list.push({ node: node.innerPanel, path: '/layout/columns/' + index + '/innerPanel' });
    });
    (Array.isArray(scene.layout?.sections) ? scene.layout.sections : []).forEach((node, index) => {
      if ([node.y, node.h].every(Number.isFinite)) list.push({ node: { ...node, x: zone?.x, w: zone?.w }, source: node, path: '/layout/sections/' + index, verticalOnly: true });
    });
    return list;
  }
  function fixOutOfZone() {
    if (!zone) return false;
    let changed = false;
    for (const item of allBoxes()) {
      const node = item.node; if (![node.w, node.h, node.y].every(Number.isFinite)) continue;
      if (!item.verticalOnly && Number.isFinite(node.x) && (node.x < zone.x || node.x + node.w > zone.x + zone.w)) {
        const low = Math.ceil(zone.x / 16) * 16, high = Math.floor((zone.x + zone.w - node.w) / 16) * 16;
        changed = edit(item.path + '/x', Math.max(low, Math.min(high, snap(node.x))), 'out-of-zone') || changed;
      }
      if (node.y < zone.y || node.y + node.h > zone.bottom) {
        const low = Math.ceil(zone.y / 16) * 16, high = Math.floor((zone.bottom - node.h) / 16) * 16;
        changed = edit(item.path + '/y', Math.max(low, Math.min(high, snap(node.y))), 'out-of-zone') || changed;
      }
    }
    return changed;
  }

  // This ordering is intentionally fixed. A non-decreasing geometry pass is
  // retained only when it made harmless structural/cardinality/icon repairs.
  for (let loop = 0; loop < 3; loop++) {
    const before = penalty(), traceStart = trace.length, snapshot = structuredClone(scene);
    let changed = fixUnknownProperties(runValidation().errors);
    changed = fixIcons() || changed;
    changed = fixAnimationCardinality() || changed;
    changed = fixLabelOverflow() || changed;
    changed = fixOverlaps() || changed;
    changed = fixOutOfZone() || changed;
    // Validate after every full pass.  The caller will surface its remaining
    // errors to the model, while this pass only acts on its fixed rule set.
    runValidation();
    const after = penalty(); trace.penalties.push({ before, after, loop });
    if (after > before) {
      Object.keys(scene).forEach(key => delete scene[key]); Object.assign(scene, snapshot); trace.length = traceStart;
      trace.penalties[trace.penalties.length - 1].attemptedAfter = after;
      trace.penalties[trace.penalties.length - 1].after = before; break;
    }
    if (!changed || after >= before) break;
  }
  return trace;
}

module.exports = { deterministicRepair, LUCIDE, BRANDS };
