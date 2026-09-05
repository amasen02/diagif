(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { pathGeometry: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const coord = p => p.x + ',' + p.y;
  function anchor(node, side) {
    const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
    const points = { top: { x: cx, y: node.y }, right: { x: node.x + node.w, y: cy }, bottom: { x: cx, y: node.y + node.h }, left: { x: node.x, y: cy }, center: { x: cx, y: cy } };
    if (!points[side]) throw new Error('Unknown anchor: ' + side);
    return points[side];
  }
  function sampled(d, points, kind) {
    const segments = [], cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const length = distance(points[i - 1], points[i]);
      segments.push({ from: points[i - 1], to: points[i], start: cumulative[i - 1], length });
      cumulative.push(cumulative[i - 1] + length);
    }
    const length = cumulative[cumulative.length - 1];
    function pointAt(s) {
      if (!Number.isFinite(s)) throw new Error('pointAt requires a finite distance');
      if (s <= 0 || length === 0) return { ...points[0] };
      if (s >= length) return { ...points[points.length - 1] };
      let lo = 0, hi = segments.length - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (cumulative[mid + 1] <= s) lo = mid + 1; else hi = mid; }
      const segment = segments[lo];
      return lerp(segment.from, segment.to, segment.length ? (s - segment.start) / segment.length : 0);
    }
    return { d, length, pointAt, segments, kind };
  }
  function cubic(a, c1, c2, b) {
    const points = [];
    for (let i = 0; i <= 256; i++) {
      const t = i / 256, u = 1 - t;
      points.push({ x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y });
    }
    return sampled('M ' + coord(a) + ' C ' + coord(c1) + ' ' + coord(c2) + ' ' + coord(b), points, 'cubic');
  }
  function buildPath(edge, fromPt, toPt) {
    const a = { ...fromPt }, b = { ...toPt };
    if (edge.loop) {
      const normals = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0], center: [1, 0] };
      const [nx, ny] = normals[edge.loop.side], r = edge.loop.size;
      const end = { x: a.x - ny * 12, y: a.y + nx * 12 };
      // Spread the tangents as well as the outward controls: the old controls
      // made every loop only 12px wide, regardless of its requested size.
      const depth = r * 4 / 3, spread = r * 0.75;
      return cubic(a, { x: a.x + nx * depth + ny * spread, y: a.y + ny * depth - nx * spread },
        { x: end.x + nx * depth - ny * spread, y: end.y + ny * depth + nx * spread }, end);
    }
    if (edge.pathType === 'curved') {
      const dx = Math.max(48, Math.abs(b.x - a.x) * 0.45), sign = b.x < a.x ? -1 : 1, len = distance(a, b);
      const offset = edge.curveOffset || 0, nx = len ? -(b.y - a.y) / len : 0, ny = len ? (b.x - a.x) / len : 0;
      return cubic(a, { x: a.x + sign * dx + offset * nx, y: a.y + offset * ny }, { x: b.x - sign * dx + offset * nx, y: b.y + offset * ny }, b);
    }
    let points = [a, b];
    if (edge.waypoints?.length) points = [a, ...edge.waypoints.map(p => ({ ...p })), b];
    else if (edge.pathType === 'orthogonal') { const midX = Math.round((a.x + b.x) / 2); points = [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b]; }
    else if (edge.pathType !== 'straight' && edge.pathType !== 'orthogonal') throw new Error('Unknown path type: ' + edge.pathType);
    return sampled('M ' + points.map(coord).join(' L '), points, 'polyline');
  }
  function forEdge(edge, nodes) {
    const get = id => nodes instanceof Map ? nodes.get(id) : Array.isArray(nodes) ? nodes.find(n => n.id === id) : nodes[id];
    const from = get(edge.from), to = get(edge.to);
    if (!from || !to) throw new Error('Unknown node for edge ' + edge.id);
    return buildPath(edge, anchor(from, edge.loop ? edge.loop.side : (edge.fromAnchor || 'right')), anchor(to, edge.toAnchor || 'left'));
  }
  function buildScenePaths(scene) { return Object.fromEntries(scene.edges.map(edge => [edge.id, forEdge(edge, scene.nodes)])); }
  function chainLength(edgeIds, paths) { return edgeIds.reduce((sum, id) => sum + (typeof paths.length === 'function' ? paths.length(id) : paths[id].length), 0); }
  function createPathMetrics(scene) {
    const paths = buildScenePaths(scene);
    const get = id => { if (!paths[id]) throw new Error('Unknown edge: ' + id); return paths[id]; };
    return { paths, length: id => get(id).length, pointAt: (id, s) => get(id).pointAt(s), chainLength: ids => chainLength(ids, paths) };
  }
  return { anchor, buildPath, forEdge, buildScenePaths, createPathMetrics, chainLength };
});
