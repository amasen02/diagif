'use strict';
const fs = require('node:fs');
const Ajv2020 = require('ajv/dist/2020');
const defaults = require('../config/defaults.json');
const schema = require('./schema/scene.schema.json');
const geometry = require('./renderer/path-geometry.js');
const { materializeMindmap, wrapLines } = require('./renderer/layout.js');
const { estimator } = require('./renderer/svg-builder.js');
const { rootPath } = require('./paths.js');
const structural = new Ajv2020({ allErrors: true, useDefaults: true, discriminator: true, strict: true }).compile(schema);
const ambient = new Set(['particle-flow', 'marching-dash', 'pulse', 'sequential-highlight']);
function contentZone(scene) {
  const f = defaults.frame, footer = ['none', 'creator', 'corner'].includes(scene.brand?.style) ? 0 : f.footerZone;
  return { x: f.padX, y: f.titleZone, w: scene.canvas.width - 2 * f.padX, h: scene.canvas.height - footer - f.titleZone, bottom: scene.canvas.height - footer };
}
function annotationBox(a, scene, seen = new Set()) {
  if (seen.has(a.id)) return null;
  seen.add(a.id);
  const font = a.fontSize || defaults.themeDefaults.annotationFontSize;
  const w = a.w ?? (['badge', 'check', 'cross'].includes(a.kind) ? 28 : a.maxWidth);
  let h = a.h;
  if (h === undefined) {
    if (['badge', 'check', 'cross'].includes(a.kind)) h = 28;
    else if (a.kind === 'code') h = (a.lines?.length || 1) * (a.fontSize || 16) * 1.35 + 24;
    else if (a.kind === 'table') h = ((a.rows?.length || 0) + 1) * 28 + 16;
    else h = wrapLines(a.text || '', w, font) * font * 1.2;
  }
  if (a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y, w, h };
  if (!a.attachTo || !scene) return null;
  const edge = scene.edges.find(e => e.id === a.attachTo);
  let point;
  if (edge && scene.nodes.some(n => n.id === edge.from) && scene.nodes.some(n => n.id === edge.to)) {
    const path = geometry.forEdge(edge, scene.nodes); point = path.pointAt(path.length / 2);
  } else {
    let target = scene.nodes.find(n => n.id === a.attachTo) || scene.layout?.columns?.find(c => c.id === a.attachTo);
    const section = scene.layout?.sections?.find(s => s.id === a.attachTo);
    if (section) { const zone = contentZone(scene); target = { ...section, x: zone.x, w: zone.w }; }
    const annotation = scene.annotations.find(other => other.id === a.attachTo);
    if (annotation) target = annotationBox(annotation, scene, seen);
    if (target) point = geometry.anchor(target, a.targetAnchor || 'top');
  }
  return point ? { x: point.x - w / 2, y: point.y - h / 2, w, h } : null;
}
function intersects(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function resolveArt(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  return ['png', 'svg'].map(ext => rootPath('assets/art', name + '.' + ext)).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}
function canonicalizeBrandUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Brand URL must be an HTTPS LinkedIn profile or company URL'); }
  if (typeof value !== 'string' || value.trim() !== value || url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || /[?#]/.test(value) || !/^\/(in|company)\/[A-Za-z0-9._-]{2,}\/?$/.test(url.pathname)) throw new Error('Brand URL must be an HTTPS LinkedIn profile or company URL without credentials, query or fragment');
  const canonical = 'https://www.linkedin.com' + url.pathname.replace(/\/$/, '');
  if (canonical.length > 72 || estimator(canonical, { size: 16 }) > 736) throw new Error('Brand URL exceeds the 72 character footer limit');
  return canonical;
}
function validateScene(scene) {
  const mindmap = scene?.layout?.kind === 'mindmap';
  if (mindmap && scene.layout.mindmap && Object.hasOwn(scene.layout.mindmap, 'placement')) {
    scene.nodes = []; scene.edges = [];
    if (scene.timeline && typeof scene.timeline === 'object') scene.timeline.animations = [];
    delete scene.layout.mindmap.placement;
  }
  if (!structural(scene)) return { valid: false, errors: structural.errors.map(e => ({ path: e.instancePath || '/', message: e.message, keyword: e.keyword, params: e.params })), scene };
  if (mindmap) {
    try { materializeMindmap(scene, contentZone(scene)); }
    catch (error) { if (error.code !== 'MINDMAP_LAYOUT') throw error; return { valid: false, errors: [{ path: '/layout/mindmap', message: error.message, code: error.code }], scene }; }
  }
  const errors = [], all = new Map(), nodes = new Map(scene.nodes.map(n => [n.id, n])), edges = new Map(scene.edges.map(e => [e.id, e]));
  const add = (path, message) => errors.push({ path, message });
  const groups = [['nodes', scene.nodes], ['edges', scene.edges], ['annotations', scene.annotations], ['layout/sections', scene.layout?.sections || []], ['layout/columns', scene.layout?.columns || []]];
  for (const [group, items] of groups) for (const item of items) { if (all.has(item.id)) add('/' + group, 'Duplicate global id: ' + item.id); else all.set(item.id, { ...item, group }); }
  const ref = (id, map, at) => { if (!map.has(id)) add(at, 'Unresolved reference: ' + id); };
  let iconData;
  try { iconData = require('./renderer/icon-data.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  for (const n of scene.nodes) if (n.icon) {
    const { source, name } = n.icon;
    if (source === 'art' ? !resolveArt(name) : !Object.hasOwn(iconData?.[source === 'brand' ? 'brands' : 'lucide'] || {}, name)) add('/nodes/' + n.id + '/icon', 'Unknown icon: ' + source + ':' + name);
  }
  for (const edge of scene.edges) {
    ref(edge.from, nodes, '/edges/' + edge.id + '/from'); ref(edge.to, nodes, '/edges/' + edge.id + '/to');
    if (edge.from === edge.to && !edge.loop && (edge.waypoints?.length || 0) < 2) add('/edges/' + edge.id, 'Self-loop requires loop or at least two waypoints');
    if (edge.loop && edge.from !== edge.to) add('/edges/' + edge.id, 'loop requires from == to');
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      const p = geometry.forEdge(edge, nodes), a = p.pointAt(0), b = p.pointAt(p.length);
      if (!Number.isFinite(p.length) || p.length <= 0 || (a.x === b.x && a.y === b.y && !edge.waypoints?.length)) add('/edges/' + edge.id, 'Degenerate path: start equals end or length is zero');
    }
  }
  for (const a of scene.annotations) {
    const at = '/annotations/' + a.id, needs = fields => { for (const key of fields) if (a[key] === undefined) add(at, a.kind + ' requires ' + key); };
    if (a.target) ref(a.target, all, at + '/target');
    if (a.attachTo) ref(a.attachTo, all, at + '/attachTo');
    if (a.kind === 'callout' || a.kind === 'header') needs(['text', 'x', 'y']);
    if (a.kind === 'badge') { needs(['number']); if (!a.attachTo) needs(['x', 'y']); }
    if (a.kind === 'check' || a.kind === 'cross') if (!a.attachTo) needs(['x', 'y']);
    if (a.kind === 'code') needs(['lines', 'x', 'y', 'w']);
    if (a.kind === 'table') { needs(['header', 'rows', 'x', 'y', 'w']); if (a.rows?.some(row => row.length !== a.header?.length)) add(at, 'Table row width must match header'); }
  }
  const layout = scene.layout;
  if (layout?.kind === 'split-comparison' && layout.dividerY === undefined && !layout.sections?.length) add('/layout', 'split-comparison requires dividerY or sections');
  if (layout?.kind === 'split-columns' && !layout.columns?.length) add('/layout', 'split-columns requires columns');
  const zone = contentZone(scene);
  if (layout?.dividerY !== undefined && (layout.dividerY <= zone.y || layout.dividerY >= zone.bottom)) add('/layout/dividerY', 'Divider must lie inside content zone');
  if (layout?.kind === 'split-comparison' && !layout.sections?.length && layout.dividerY !== undefined) for (const id of ['section-1', 'section-2']) if (all.has(id)) add('/layout', 'Generated section id collides: ' + id);
  const D = scene.timeline.durationMs;
  if (![40, 50].every(step => D / step <= defaults.caps.maxFrames)) add('/timeline', 'Frame count exceeds 250');
  if (!scene.timeline.animations.some(a => ambient.has(a.kind))) add('/timeline/animations', 'At least one ambient animation is required');
  scene.timeline.animations.forEach((a, i) => {
    const at = '/timeline/animations/' + i;
    for (const key of ['edgeIds', 'nodeIds', 'order', 'targetIds']) for (const id of a[key] || []) ref(id, key === 'edgeIds' ? edges : ['nodeIds', 'order'].includes(key) ? nodes : all, at + '/' + key);
    for (const key of ['targetId', 'mirrorTargetId']) if (a[key]) {
      ref(a[key], all, at + '/' + key);
      const target = all.get(a[key]);
      if (a.kind === 'typing' && target && target.group !== 'nodes' && !(target.group === 'annotations' && target.kind === 'callout')) add(at + '/' + key, 'Typing target must be a node or callout');
    }
    const exactlyOne = (x, y) => { if ((a[x] !== undefined) === (a[y] !== undefined)) add(at, 'Exactly one of ' + x + ' / ' + y + ' is required'); };
    if (a.kind === 'particle-flow') { exactlyOne('cyclesPerLoop', 'speedPxPerSec'); if (a.colorRole && a.color) add(at, 'At most one of colorRole / color'); }
    if (a.kind === 'pulse') exactlyOne('cyclesPerLoop', 'periodMs');
    if (a.kind === 'sequential-highlight' && a.dwellMs !== undefined && a.dwellMs !== D / a.order.length) add(at, 'dwellMs * order.length must equal timeline.durationMs');
    if (a.kind === 'typing' || a.kind === 'reveal') if (a.startMs + a.durationMs + (a.loopBehavior === 'cut' ? 0 : a.exitMs) > D) add(at, 'startMs + durationMs + exitMs exceeds loop duration');
  });
  const inside = (box, at) => { if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0 || box.x < zone.x || box.y < zone.y || box.x + box.w > zone.x + zone.w || box.y + box.h > zone.bottom) add(at, 'Bounding box outside content zone or non-positive'); };
  for (const node of scene.nodes) {
    inside(node, '/nodes/' + node.id);
    const w = node.labelRotate === -90 ? node.h : node.w, h = node.labelRotate === -90 ? node.w : node.h;
    const kind = mindmap && scene.layout.mindmap.placement.items.find(item => item.id === node.id).kind;
    const size = kind === 'root' ? 20 : kind === 'branch' ? 17 : kind === 'leaf' ? 15 : defaults.themeDefaults.nodeFontSize;
    const labelH = wrapLines(node.label, w - 24, size) * size * 1.2;
    if (mindmap && wrapLines(node.label, w - 24, size) > 2) add('/nodes/' + node.id, 'Mind map labels must wrap to at most two lines');
    const secondaryH = node.secondaryLabel ? wrapLines(node.secondaryLabel, w - 24, 12) * 12 * 1.2 : 0;
    if (labelH + secondaryH + (node.icon?.size || 0) + 8 > h) add('/nodes/' + node.id, 'Estimated wrapped label height exceeds node height');
  }
  for (let i = 0; i < scene.nodes.length; i++) for (let j = i + 1; j < scene.nodes.length; j++) if (intersects(scene.nodes[i], scene.nodes[j])) add('/nodes', 'Overlapping nodes: ' + scene.nodes[i].id + ', ' + scene.nodes[j].id);
  for (const a of scene.annotations) {
    const box = annotationBox(a, scene);
    if (!box) { if (a.attachTo && all.has(a.attachTo)) add('/annotations/' + a.id, 'Attachment has no resolvable bounding box (possibly cyclic)'); continue; }
    inside(box, '/annotations/' + a.id);
    for (const n of scene.nodes) if (!(a.attachTo === n.id && ['badge', 'check', 'cross'].includes(a.kind)) && intersects(box, n)) add('/annotations/' + a.id, 'Annotation intersects node ' + n.id);
  }
  for (const section of layout?.sections || []) inside({ x: zone.x, w: zone.w, ...section }, '/layout/sections/' + section.id);
  for (const column of layout?.columns || []) {
    inside(column, '/layout/columns/' + column.id);
    if (column.innerPanel) inside(column.innerPanel, '/layout/columns/' + column.id + '/innerPanel');
  }
  for (const key of ['logoAsset', 'mascotAsset', 'avatarAsset']) if (scene.brand?.[key]?.startsWith('art:') && !resolveArt(scene.brand[key].slice(4))) add('/brand/' + key, 'Art asset not found: ' + scene.brand[key]);
  if (scene.brand?.style === 'url-footer') {
    try { canonicalizeBrandUrl(scene.brand.url); } catch (error) { add('/brand/url', error.message); }
    if (estimator(scene.brand.url, { size: 16 }) > 736) add('/brand/url', 'Footer URL exceeds 736px');
  }
  return { valid: errors.length === 0, errors, scene };
}
function validate(scene) { const result = validateScene(scene); validate.errors = result.errors; return result.valid; }
function assertValid(scene) { const result = validateScene(scene); if (!result.valid) { const error = new Error(result.errors.map(e => e.path + ': ' + e.message).join('\n')); error.errors = result.errors; throw error; } return scene; }
module.exports = { schema, validate, validateScene, assertValid, contentZone, annotationBox, wrapLines, resolveArt, canonicalizeBrandUrl };
