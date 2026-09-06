(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { layout: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif) {
  'use strict';
  const svg = TechGif.svgBuilder || (typeof require === 'function' ? require('./svg-builder.js') : {});
  const themes = TechGif.themes || (typeof require === 'function' ? require('./themes.js') : {});
  const icons = TechGif.icons || (typeof require === 'function' ? require('./icons.js') : {});
  const { el, ref, textLines } = svg;
  class MindmapLayoutError extends Error {
    constructor(message) { super(message); this.name = 'MindmapLayoutError'; this.code = 'MINDMAP_LAYOUT'; }
  }
  const snap16 = value => Math.round(value / 16) * 16;
  function wrapLines(text, width, fontSize) {
    const max = Math.max(1, Math.floor(width / (0.58 * fontSize)));
    let count = 0;
    for (const paragraph of String(text).split('\n')) {
      let used = 0;
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (used && used + 1 + word.length > max) { count++; used = 0; }
        let length = word.length;
        while (length > max) { count++; length -= max; }
        used = used ? used + 1 + length : length;
      }
      count += used ? 1 : paragraph.length ? 0 : 1;
    }
    return Math.max(1, count);
  }
  function point(box, side) {
    return { x: box.x + (side === 'left' ? 0 : side === 'right' ? box.w : box.w / 2),
      y: box.y + (side === 'top' ? 0 : side === 'bottom' ? box.h : box.h / 2) };
  }
  // Liang-Barsky against an open rectangle: touching its boundary is permitted.
  function crossesBox(a, b, box, padding = 16) {
    let low = 0, high = 1;
    for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.x - padding, box.x + box.w + padding], [a.y, b.y - a.y, box.y - padding, box.y + box.h + padding]]) {
      if (delta === 0) { if (start <= min || start >= max) return false; }
      else { const t1 = (min - start) / delta, t2 = (max - start) / delta; low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2)); }
    }
    return low < high;
  }

  /**
   * The height a mind map actually needs for its tree.
   *
   * materializeMindmap caps the row pitch and then centres the cluster inside whatever
   * canvas it was given, so a small tree in a tall canvas leaves half the frame empty.
   * Sizing the canvas from the tree first removes the slack instead of centring it.
   *
   * Shares the band maths with materializeMindmap below rather than restating the
   * constants, so the two cannot drift apart.
   */
  function mindmapClusterHeight(tree) {
    const branches = (tree && tree.branches) || [];
    const n = branches.length;
    if (n < 1) return 0;
    const rootH = 96, branchH = 84, leafW = 200, gap = 12;
    const bandHeights = branches.map(branch => {
      const leaves = branch.leaves || [];
      const heights = leaves.map(leaf => wrapLines(leaf.label, leafW - 24, 15) > 1 ? 76 : 64);
      return heights.reduce((a, b) => a + b, 0) + Math.max(0, heights.length - 1) * gap;
    });
    const rowH = Math.max(branchH, rootH, ...bandHeights);
    // The uncapped pitch materializeMindmap would choose if the canvas were unbounded.
    const pitch = Math.floor((rowH + 40) / 16) * 16;
    return rowH + (n - 1) * pitch;
  }

  function materializeMindmap(scene, zone) {
    const tree = scene.layout.mindmap, branches = tree.branches, n = branches.length;
    const fail = message => { throw new MindmapLayoutError(message); };
    if (n < 4 || n > 8) fail('Mind map requires 4 to 8 branches');
    const nodes = [], edges = [], items = [], rows = { right: n };
    const addNode = (input, box, kind, row, colorRole) => {
      const node = { id: input.id, label: input.label, ...box, shape: 'rounded-rect', colorRole, labelRotate: 0, labelAlign: 'center' };
      if (input.icon) node.icon = { ...input.icon };
      nodes.push(node); items.push({ id: input.id, kind, side: kind === 'root' ? 'left' : 'right', row, cx: box.x + box.w / 2, cy: box.y + box.h / 2 });
      return node;
    };
    const rootH = 96, branchH = 84, leafW = 200, gap = 12;
    const bands = branches.map(branch => {
      if (branch.leaves.length < 1 || branch.leaves.length > 2) fail('Each branch requires 1 to 2 leaves');
      const heights = branch.leaves.map(leaf => wrapLines(leaf.label, leafW - 24, 15) > 1 ? 76 : 64);
      return { heights, height: heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * gap };
    });
    const rowH = Math.max(branchH, ...bands.map(band => band.height)), zoneH = zone.bottom - zone.y;
    // Round pitch down: nearest snapping can exceed the available height.
    const pitch = Math.floor(Math.min(rowH + 40, Math.floor((zoneH - rowH) / Math.max(1, n - 1))) / 16) * 16;
    const cluster = rowH + (n - 1) * pitch;
    if (cluster > zoneH || pitch < rowH + gap) fail('Mind map cluster cannot fit without overlapping row bands');
    const top = snap16(zone.y + (zoneH - cluster) / 2);
    const root = addNode(tree.root, { x: 32, y: snap16(top + (cluster - rootH) / 2), w: 200, h: rootH }, 'root', 0, 'primary');
    const addEdge = (parent, child, colorRole) => edges.push({ id: 'mm-' + parent.id + '-' + child.id, from: parent.id, to: child.id,
      pathType: 'straight', fromAnchor: 'right', toAnchor: 'left', arrow: true, dashed: true, colorRole, style: 'line', strokeWidth: 2 });
    branches.forEach((b, i) => {
      const band = bands[i], rowTop = top + i * pitch, cy = rowTop + rowH / 2, role = b.colorRole || 'primary';
      const branch = addNode(b, { x: 280, y: cy - branchH / 2, w: 152, h: branchH }, 'branch', i, role);
      addEdge(root, branch, role);
      let leafY = cy - band.height / 2;
      b.leaves.forEach((leaf, j) => {
        addEdge(branch, addNode(leaf, { x: 480, y: leafY, w: leafW, h: band.heights[j] }, 'leaf', i, role), role);
        leafY += band.heights[j] + gap;
      });
    });
    for (const box of nodes) {
      if (![box.x, box.y, box.w, box.h].every(Number.isInteger) || box.w % 2 || box.h % 2 || box.x < zone.x || box.x + box.w > zone.x + zone.w || box.y < zone.y || box.y + box.h > zone.bottom) fail('Tree too dense for 800x1100');
    }
    // Sibling leaves have the authored 12px gap; other boxes also stay disjoint.
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (!(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y)) fail('Mind map boxes violate 12px clearance: ' + a.id + ' / ' + b.id);
    }
    const ids = [...nodes, ...edges].map(item => item.id);
    if (new Set(ids).size !== ids.length) fail('Duplicate global mind map id');
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const edge of edges) {
      const start = point(byId.get(edge.from), edge.fromAnchor), end = point(byId.get(edge.to), edge.toAnchor);
      for (const box of nodes.filter(box => box.id !== edge.from && box.id !== edge.to)) {
        if (crossesBox(start, end, box, 0)) fail('Mind map edge ' + edge.id + ' crosses node ' + box.id);
      }
    }
    const D = scene.timeline.durationMs;
    const cyclesPerLoop = Math.round(128 * D / 1000 / 16);
    const animations = [
      { kind: 'marching-dash', edgeIds: edges.map(e => e.id), dash: 8, gap: 8, cyclesPerLoop, speedPxPerSec: cyclesPerLoop * 16 * 1000 / D },
      // The runtime uses floor(t * branchCount / D), including fractional dwell.
      { kind: 'sequential-highlight', order: branches.map(b => b.id), dwellMs: D / n, scale: 1.04 }
    ];
    scene.nodes = nodes; scene.edges = edges; scene.timeline.animations = animations;
    tree.placement = { version: 2, zone: { ...zone }, rows, rowH, pitch, cluster, top, items };
    return scene;
  }
  // SVG measurement collapses a text element's boundary spaces. Nonbreaking
  // spaces retain the same advance when measuring individually positioned runs.
  const measure = (text, font, ctx) => (ctx.measureText || svg.estimator)(text.replace(/ /g, '\u00a0'), font);
  function header(text, x, y, theme, ctx = {}, options = {}) {
    const plain = options.headerStyle === 'plain', font = themes.font(theme, plain ? 'body' : 'display', plain ? 15 : 28, plain ? 800 : 400);
    const width = measure(text, font, ctx), left = options.labelAlign === 'center' ? x - width / 2 - 14 : x;
    const fill = options.colorRole ? themes.role(theme, options.colorRole).fill : theme.chip;
    return el('g', { class: plain ? 'section-header' : 'section-header chip-header' }, [
      !plain && el('rect', { x: left + 3, y: y + 3, width: width + 28, height: 42, rx: 7, fill: theme.shadow }),
      !plain && el('rect', { x: left, y, width: width + 28, height: 42, rx: 7, fill }),
      textLines([text], left + (plain ? 0 : 14), y + (plain ? 20 : 30), font, { fill: plain ? theme.titleText : theme.chipText, 'letter-spacing': plain ? '0.04em' : undefined })
    ]);
  }
  function sections(scene, theme, ctx, defs) {
    const layout = scene.layout || {}, children = [];
    if (layout.kind === 'mindmap') {
      for (const branch of layout.mindmap.branches) {
        const ids = new Set([branch.id, ...branch.leaves.map(leaf => leaf.id)]);
        const members = scene.nodes.filter(node => ids.has(node.id));
        const x = Math.min(...members.map(node => node.x)) - 16, y = Math.min(...members.map(node => node.y)) - 16;
        const right = Math.max(...members.map(node => node.x + node.w)) + 16, bottom = Math.max(...members.map(node => node.y + node.h)) + 16;
        children.push(el('rect', { class: 'mindmap-halo', x, y, width: right - x, height: bottom - y, rx: 16, fill: themes.role(theme, branch.colorRole || 'primary').fill + '1F' }));
      }
      return children;
    }
    if (layout.kind === 'split-comparison') {
      (layout.sections || []).forEach((section, i) => {
        const content = [];
        if (section.header) content.push(header(section.header, section.labelAlign === 'center' ? 400 : 40, section.y + 12, theme, ctx, section));
        if (i && layout.divider?.style !== 'none') content.push(el('line', { x1: 32, x2: 768, y1: section.y, y2: section.y, stroke: layout.divider?.colorRole ? themes.role(theme, layout.divider.colorRole).stroke : theme.muted, 'stroke-width': 2, 'stroke-dasharray': layout.divider?.style === 'solid' ? undefined : '2 6', 'stroke-linecap': 'round' }));
        children.push(el('g', { 'data-reveal-id': section.id, 'data-cx': 400, 'data-cy': section.y + section.h / 2 }, content));
      });
    } else if (layout.kind === 'split-columns') for (const c of layout.columns) {
      defs.push(el('linearGradient', { id: 'grad-' + c.id }, [el('stop', { offset: '0%', 'stop-color': c.accentFrom || theme.cyan.fill }), el('stop', { offset: '100%', 'stop-color': c.accentTo || theme.magenta.fill })]));
      children.push(el('g', { 'data-reveal-id': c.id, 'data-cx': c.x + c.w / 2, 'data-cy': c.y + c.h / 2 }, [
        textLines([c.header], c.x + c.w / 2, c.y - 18, themes.font(theme, 'body', 15, 800), { fill: theme.titleText, 'text-anchor': 'middle' }),
        el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 10, stroke: ref('grad-' + c.id), 'stroke-width': 3, fill: 'none' }),
        c.innerPanel && el('rect', { x: c.innerPanel.x, y: c.innerPanel.y, width: c.innerPanel.w, height: c.innerPanel.h, rx: 12, fill: c.innerPanel.fill || theme.panel, filter: ref('soft-shadow') })
      ]));
    }
    return children;
  }
  function title(scene, theme, ctx = {}) {
    const t = scene.title, font = themes.font(theme, theme.titleFont || t.font || 'display', t.size || 44, theme.titleWeight || 400);
    const x = t.x ?? (t.align === 'center' ? 400 : t.align === 'right' ? 768 : 32), y = t.y ?? 58;
    const lines = t.lines?.length ? t.lines : svg.wrapText(t.text, 736, font, ctx), children = [];
    const shadow = t.shadow || { kind: theme.titleShadowKind || 'offset' };
    lines.forEach((line, i) => {
      const width = measure(line, font, ctx), left = x - (t.align === 'center' ? width / 2 : t.align === 'right' ? width : 0), baseline = y + i * font.size * 1.05;
      if (shadow.kind !== 'none') children.push(textLines([line], left, baseline, font, { class: 'title-shadow', fill: shadow.color || theme.titleShadow, transform: shadow.kind === 'glow' ? undefined : 'translate(' + (shadow.dx ?? 3) + ',' + (shadow.dy ?? 3) + ')', filter: shadow.kind === 'glow' ? ref('title-glow') : undefined, opacity: shadow.kind === 'glow' ? 0.55 : undefined }));
      const special = [...(t.accentWords || []).map(a => a.word), ...(t.chipWords || []).map(a => a.word), ...(t.strikeWords || [])].filter(Boolean).sort((a, b) => b.length - a.length);
      let index = 0;
      while (index < line.length) {
        const word = special.find(word => line.startsWith(word, index));
        let end = index + (word ? word.length : 1);
        if (!word) while (end < line.length && !special.some(w => line.startsWith(w, end))) end++;
        const chunk = line.slice(index, end), start = left + measure(line.slice(0, index), font, ctx), chunkWidth = measure(chunk, font, ctx);
        const accent = t.accentWords?.find(a => a.word === chunk), chip = t.chipWords?.find(a => a.word === chunk);
        if (chip) children.push(el('rect', { x: start - 8, y: baseline - font.size * 0.85 - 2, width: chunkWidth + 16, height: font.size + 4, rx: 6, fill: chip.fill || theme.chip }));
        children.push(textLines([chunk], start, baseline, font, { class: 'title-text', fill: chip?.textColor || accent?.color || (accent?.colorRole ? themes.role(theme, accent.colorRole).fill : theme.titleText), 'xml:space': 'preserve' }));
        if (t.strikeWords?.includes(chunk)) children.push(el('line', { x1: start, x2: start + chunkWidth, y1: baseline - font.size * 0.32, y2: baseline - font.size * 0.32, stroke: theme.danger.stroke, 'stroke-width': 3 }));
        index = end;
      }
    });
    if (t.subtitle) children.push(textLines([(t.subtitle.prefix ? t.subtitle.prefix + ' ' : '') + t.subtitle.text], x, y + (lines.length - 1) * font.size * 1.05 + 28, themes.font(theme, t.subtitle.font || 'condensed', t.subtitle.size || 13), { fill: theme.muted, 'text-anchor': t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start', 'letter-spacing': '0.04em' }));
    return children;
  }
  function brand(scene, theme, ctx = {}, defs = []) {
    const b = scene.brand || {}, style = b.style || 'bar', H = scene.canvas.height, children = [];
    const text = (value, x, y, role, size, attrs = {}) => value ? textLines([value], x, y, themes.font(theme, role, size, attrs.weight || 400), { fill: theme.footerText, ...attrs }) : null;
    if (style === 'none') return children;
    if (style === 'url-footer') return [
      el('rect', { class: 'brand-bar', x: 0, y: H - 60, width: 800, height: 60, fill: theme.footer }),
      textLines([b.url], 400, H - 24, themes.font(theme, 'body', 16, 600), { fill: theme.link, 'text-anchor': 'middle' })
    ];
    if (style === 'bar') {
      children.push(el('rect', { class: 'brand-bar', x: 0, y: H - 60, width: 800, height: 60, fill: theme.footer }));
      children.push(b.logoAsset ? el('image', { href: b.logoAsset, x: 24, y: H - 48, width: 110, height: 34 }) : text(b.name, 24, H - 28, 'condensed', 22));
      children.push(text(b.tagline, 24, H - 13, 'body', 8));
      if (b.ctaPrefix || b.ctaBold || b.url) children.push(el('line', { x1: 150, x2: 150, y1: H - 46, y2: H - 14, stroke: theme.footerText, opacity: 0.4 }));
      children.push(el('text', { x: 174, y: H - 30, fill: theme.footerText, 'font-family': theme.fonts.body, 'font-size': 15 }, [el('tspan', {}, (b.ctaPrefix || '') + (b.ctaPrefix && b.ctaBold ? ' ' : '')), el('tspan', { 'font-weight': 700 }, b.ctaBold || '')]));
      children.push(text(b.url, 174, H - 12, 'body', 11, { fill: b.urlColorRole ? themes.role(theme, b.urlColorRole).fill : theme.link }));
      if (b.mascotAsset) { const m = b.mascot || {}, w = m.w || 90; children.push(el('image', { href: b.mascotAsset, x: m.x ?? 690, y: m.y ?? H - 60 - w, width: w, height: w })); }
    } else if (style === 'block') {
      children.push(text('Brought to you by', 24, H - 67, 'body', 8, { fill: theme.muted }), el('rect', { x: 24, y: H - 60, width: 64, height: 48, rx: 5, fill: '#e3342f' }));
      const words = (b.name || '').split(' '), midpoint = Math.ceil(words.length / 2);
      children.push(text(words.slice(0, midpoint).join(' '), 30, H - 40, 'condensed', 16), text(words.slice(midpoint).join(' '), 30, H - 22, 'condensed', 16));
      (b.socials || []).forEach((s, i) => { const y = H - 48 + i * 18; children.push(icons.render({ name: s.network, source: 'brand', size: 14 }, 570, y - 11, theme.link, ctx), text(s.handle, 768, y, 'body', 11, { fill: theme.titleText, 'text-anchor': 'end' })); });
    } else if (style === 'creator') {
      if (b.avatarAsset) { defs.push(el('clipPath', { id: 'brand-avatar' }, el('circle', { cx: 44, cy: 32, r: 20 }))); children.push(el('image', { href: b.avatarAsset, x: 24, y: 12, width: 40, height: 40, 'clip-path': ref('brand-avatar') })); }
      children.push(text(b.name, b.avatarAsset ? 76 : 24, 36, 'body', 13, { weight: 600, fill: theme.titleText }));
    } else if (style === 'corner') {
      children.push(text(b.url, 24, 28, 'body', 13, { weight: 600, fill: theme.link }), text(b.url, 400, H - 18, 'body', 13, { weight: 600, fill: theme.link, 'text-anchor': 'middle' }));
    }
    if (b.showSaveIcon) children.push(icons.render({ name: 'bookmark-plus', size: 28 }, 744, 20, theme.titleText, ctx));
    return children;
  }
  return { header, sections, title, brand, materializeMindmap, mindmapClusterHeight, MindmapLayoutError, crossesBox, wrapLines };
});
