(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { edges: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif) {
  'use strict';
  const svg = TechGif.svgBuilder || require('./svg-builder.js');
  const geometry = TechGif.pathGeometry || require('./path-geometry.js');
  const themes = TechGif.themes || require('./themes.js');
  const { el, ref, number } = svg;
  const markerId = (color, sw, ctx = {}) => (sw >= 3 ? 'arrow-lg' : 'arrow') + (ctx.markerMode === 'per-color' ? '-' + color.replace('#', '').toLowerCase() : '');
  function markers(colors = [], ctx = {}) {
    const variants = ctx.markerMode === 'per-color' ? [...new Set(colors)].map(color => ({ color, suffix: '-' + color.replace('#', '').toLowerCase() })) : [{ color: 'context-stroke', suffix: '' }];
    return variants.flatMap(({ color, suffix }) => [10, 12].map(size => el('marker', { id: (size === 12 ? 'arrow-lg' : 'arrow') + suffix, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: size, markerHeight: size, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color, stroke: 'none' }))).concat(el('marker', { id: 'dot' + suffix, viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: 'userSpaceOnUse' }, el('circle', { cx: 5, cy: 5, r: 3, fill: color }))));
  }
  function labelPoint(edge, path, nodes, offset = 10) {
    let distance = path.length * (edge.label?.t ?? 0.5);
    if (edge.pathType === 'orthogonal') {
      const segment = path.segments.filter(s => s.length > 0 && Math.abs(s.to.y - s.from.y) < 0.01).sort((a, b) => b.length - a.length)[0];
      if (segment) distance = segment.start + segment.length / 2;
    }
    const p = path.pointAt(distance), before = path.pointAt(Math.max(0, distance - 1)), after = path.pointAt(Math.min(path.length, distance + 1));
    const length = Math.hypot(after.x - before.x, after.y - before.y) || 1, normal = { x: -(after.y - before.y) / length, y: (after.x - before.x) / length };
    let side = edge.label?.side === 'left' ? 1 : -1;
    if (!edge.label?.side || edge.label.side === 'auto') {
      const nearest = nodes.filter(n => n.id === edge.from || n.id === edge.to).map(n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 })).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      const dot = nearest ? (p.x - nearest.x) * normal.x + (p.y - nearest.y) * normal.y : 0;
      side = Math.abs(dot) < 0.01 ? (normal.y <= 0 ? 1 : -1) : Math.sign(dot);
    }
    return { x: p.x + normal.x * offset * side, y: p.y + normal.y * offset * side };
  }
  function render(edge, scene, theme, ctx = {}, path = geometry.forEdge(edge, scene.nodes)) {
    const color = themes.role(theme, edge.colorRole).stroke, sw = edge.strokeWidth || 2;
    const attrs = { fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const children = [];
    if (edge.style === 'tube') for (const [width, fill, opacity] of [[14, theme.tubeOuter, 1], [8, theme.tubeCore, 1], [3, theme.tubeHighlight, 0.6]]) children.push(el('path', { d: path.d, fill: 'none', stroke: fill, 'stroke-width': width, 'stroke-linecap': 'round', opacity }));
    const dash = scene.timeline.animations.find(a => a.kind === 'marching-dash' && a.edgeIds.includes(edge.id));
    // A dotted solid edge uses unmanaged decoration; only dashed managed bodies have a dash attribute.
    if (edge.style === 'dotted' && !edge.dashed) children.push(el('path', { ...attrs, d: path.d, 'stroke-dasharray': '0 ' + 2 * sw }));
    children.push(el('path', { ...attrs, class: 'edge-path', 'data-edge-id': edge.id, d: path.d, stroke: edge.style === 'dotted' && !edge.dashed ? 'none' : color, 'stroke-dasharray': edge.dashed ? (dash ? dash.dash + ' ' + dash.gap : edge.style === 'dotted' ? '0 ' + 2 * sw : '8 8') : undefined }));
    if (edge.arrow !== false) {
      // Leave room for borders and hard shadows drawn in the node layer.
      const endDistance = Math.max(0, path.length - 7);
      const end = path.pointAt(endDistance), start = path.pointAt(Math.max(0, endDistance - 12));
      children.push(el('path', { ...attrs, class: 'edge-tip', 'data-edge-id': edge.id, d: 'M ' + number(start.x) + ',' + number(start.y) + ' L ' + number(end.x) + ',' + number(end.y), 'marker-end': ref(markerId(color, sw, ctx)) }));
    }
    const label = [];
    if (edge.label?.text) {
      const hasBadge = scene.annotations?.some(a => a.kind === 'badge' && a.attachTo === edge.id);
      const font = themes.font(theme, 'annotation', 13), width = (ctx.measureText || svg.estimator)(edge.label.text, font);
      const labelWidth = width + 16, labelHeight = 24;
      const start = path.pointAt(0), end = path.pointAt(path.length);
      let offset = Math.max(hasBadge ? 30 : edge.loop ? 26 : 10, Math.hypot(end.x - start.x, end.y - start.y) < labelWidth + 24 ? labelHeight / 2 + 8 : 0);
      let p = labelPoint(edge, path, scene.nodes, offset);
      const overlaps = p => scene.nodes.some(node => p.x - labelWidth / 2 < node.x + node.w && p.x + labelWidth / 2 > node.x && p.y - labelHeight / 2 < node.y + node.h && p.y + labelHeight / 2 > node.y);
      // Keep the authored side and move along the normal until the entire pill
      // clears all boxes, including endpoints of short and diagonal edges.
      while (overlaps(p)) { offset += 8; p = labelPoint(edge, path, scene.nodes, offset); }
      if (edge.label.pill !== false) label.push(el('rect', { x: p.x - width / 2 - 8, y: p.y - 12, width: width + 16, height: 24, rx: 6, fill: theme.bg, stroke: theme.panelBorder, 'stroke-width': 0.7 }));
      label.push(svg.textLines([edge.label.text], p.x, p.y + 4, font, { fill: theme.dark ? theme.titleText : theme.titleText, 'text-anchor': 'middle' }));
    }
    children.push(el('g', { class: 'edge-label', 'data-edge-id': edge.id }, label));
    const midpoint = path.pointAt(path.length / 2);
    return el('g', { class: 'edge', 'data-edge-id': edge.id, 'data-reveal-id': edge.id, 'data-cx': midpoint.x, 'data-cy': midpoint.y }, children);
  }
  return { markers, markerId, labelPoint, render };
});
