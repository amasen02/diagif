(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { renderStatic: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif) {
  'use strict';
  const svg = TechGif.svgBuilder || require('./svg-builder.js');
  const themes = TechGif.themes || require('./themes.js');
  const icons = TechGif.icons || require('./icons.js');
  const edges = TechGif.edges || require('./edges.js');
  const layout = TechGif.layout || require('./layout.js');
  const codeTokens = TechGif.codeTokens || require('./code-tokens.js');
  const geometry = TechGif.pathGeometry || require('./path-geometry.js');
  const { el, ref, textLines, wrapText } = svg;
  function definitions(theme, scene, ctx) {
    const colors = [...Object.values(theme.roles).map(r => r.stroke), theme.muted];
    return [
      ...edges.markers(colors, ctx),
      el('radialGradient', { id: 'background-gradient', cx: '50%', cy: '40%', r: '80%' }, [el('stop', { offset: '0%', 'stop-color': theme.bgGradient?.[0] || theme.bg }), el('stop', { offset: '100%', 'stop-color': theme.bgGradient?.[1] || theme.bg })]),
      el('filter', { id: 'soft-shadow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, el('feDropShadow', { dx: 0, dy: 4, stdDeviation: 6, 'flood-color': '#000000', 'flood-opacity': 0.18 })),
      el('filter', { id: 'node-glow', x: '-100%', y: '-100%', width: '300%', height: '300%' }, el('feGaussianBlur', { stdDeviation: 8 })),
      el('filter', { id: 'title-glow', x: '-50%', y: '-100%', width: '200%', height: '300%' }, el('feGaussianBlur', { stdDeviation: 6 })),
      el('filter', { id: 'ambient-blur', x: '-100%', y: '-100%', width: '300%', height: '300%' }, el('feGaussianBlur', { stdDeviation: 40 })),
      el('filter', { id: 'grain' }, [el('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.9, numOctaves: 2, seed: 7 }), el('feColorMatrix', { values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2 1.15' })])
    ];
  }
  function background(scene, theme) {
    const children = [el('rect', { x: 0, y: 0, width: 800, height: scene.canvas.height, fill: theme.bgGradient ? ref('background-gradient') : theme.bg })];
    if (scene.theme === 'soft-light') children.push(el('g', { filter: ref('ambient-blur'), opacity: 0.7 }, [[120, 160, '#cfe9e6'], [690, 410, '#d9d3e8'], [320, 880, '#cfe9e6']].map(([cx, cy, fill]) => el('ellipse', { cx, cy, rx: 210, ry: 150, fill }))));
    if (scene.grain ?? theme.grainDefault) children.push(el('rect', { width: 800, height: scene.canvas.height, filter: ref('grain'), opacity: 0.1 }));
    return children;
  }
  function shape(node, attrs, decoration = true) {
    const { x, y, w, h } = node, right = x + w, bottom = y + h;
    if (node.customSvgPath) return el('path', { ...attrs, d: node.customSvgPath });
    if (node.shape === 'circle') return el('circle', { ...attrs, cx: x + w / 2, cy: y + h / 2, r: Math.min(w, h) / 2 });
    if (node.shape === 'document') return el('g', attrs, [el('path', { d: `M ${x},${y} H ${right - 14} L ${right},${y + 14} V ${bottom} H ${x} Z` }), decoration && el('path', { d: `M ${right - 14},${y} V ${y + 14} H ${right}`, fill: 'none' })]);
    if (node.shape === 'database') return el('g', attrs, [el('path', { d: `M ${x},${y + 8} A ${w / 2},8 0 0 1 ${right},${y + 8} V ${bottom - 8} A ${w / 2},8 0 0 1 ${x},${bottom - 8} Z` }), decoration && el('ellipse', { cx: x + w / 2, cy: y + 8, rx: w / 2, ry: 8 })]);
    if (node.shape === 'pipe') return el('g', attrs, [el('rect', { x: x + 8, y, width: Math.max(0, w - 16), height: h, rx: 4 }), el('ellipse', { cx: x + 8, cy: y + h / 2, rx: 8, ry: h / 2 }), el('ellipse', { cx: right - 8, cy: y + h / 2, rx: 8, ry: h / 2 })]);
    const rx = node.shape === 'rect' ? 0 : node.shape === 'pill' ? h / 2 : node.shape === 'panel' ? 12 : 10;
    const rect = el('rect', { ...attrs, x, y, width: w, height: h, rx });
    if (node.shape !== 'window' || !decoration) return rect;
    return el('g', attrs, [el('rect', { x, y, width: w, height: h, rx }), el('line', { x1: x, x2: right, y1: y + 22, y2: y + 22 }), ...['#ff5f57', '#febc2e', '#28c840'].map((fill, i) => el('circle', { cx: x + 14 + 14 * i, cy: y + 11, r: 4, fill, stroke: 'none' }))]);
  }
  function badge(number, x, y, theme, fill = theme.orange.fill, className) {
    return el('g', { class: className }, [el('circle', { cx: x, cy: y, r: 12, fill, stroke: theme.bg, 'stroke-width': 2 }), textLines([String(number)], x, y + 4, themes.font(theme, 'labelMono', 12, 700), { 'text-anchor': 'middle', fill: '#152f37' })]);
  }
  function nodeParts(node, theme, ctx) {
    const role = themes.role(theme, node.colorRole), style = node.style || {}, panel = node.shape === 'panel', card = node.shape === 'card';
    const fill = style.fill || (card ? '#0b0f12' : panel ? theme.panel : node.shape === 'step' ? theme.orange.soft : node.shape === 'window' ? '#f0f5f5' : role.fill);
    const stroke = style.stroke || (card ? '#1c2428' : panel ? theme.panelBorder : role.stroke), textColor = style.textColor || (card ? '#ffffff' : panel ? theme.titleText : role.text);
    const attrs = { fill, stroke, 'stroke-width': style.strokeWidth ?? (card ? 1 : 2) }, cx = node.x + node.w / 2, cy = node.y + node.h / 2;
    const elevation = style.elevation || (node.shape === 'step' ? 'hard' : theme.elevationDefault), children = [];
    if (elevation !== 'none') children.push(shape(node, { class: 'node-shadow', fill: elevation === 'glow' ? theme.glow : theme.shadow, stroke: 'none', transform: elevation === 'hard' ? 'translate(4,4)' : undefined, filter: elevation === 'soft' ? ref('soft-shadow') : elevation === 'glow' ? ref('node-glow') : undefined, opacity: elevation === 'glow' ? 0.35 : undefined }, false));
    children.push(shape(node, { ...attrs, class: 'node-shape' }));
    if (node.badge !== undefined) children.push(badge(node.badge, node.x - 6, node.y - 6, theme, theme.orange.fill, 'node-badge'));
    const rotated = node.labelRotate === -90, width = rotated ? node.h : node.w, height = rotated ? node.w : node.h;
    const originX = cx - width / 2, originY = cy - height / 2, iconSize = node.icon?.size || 0, bar = node.shape === 'window' ? 22 : 0;
    // Prefer a horizontal icon in short boxes, but stack when its reserved width would crowd the label.
    const horizontalWidth = width - 24 - (iconSize ? iconSize + 8 : 0);
    const kind = ctx.mindmapKinds?.get(node.id);
    const font = themes.font(theme, 'body', kind === 'root' ? 20 : kind === 'branch' ? 17 : kind === 'leaf' ? 15 : 16, 650), secondaryFont = themes.font(theme, 'body', 11);
    const naturalWidth = (ctx.measureText || svg.estimator)(node.label, font);
    const stacked = !!iconSize && !panel && (height >= 84 || naturalWidth > horizontalWidth);
    const panelBelowIcon = panel && iconSize && naturalWidth > horizontalWidth;
    const labelWidth = Math.max(12, width - 24 - (iconSize && !stacked && !panelBelowIcon ? iconSize + 8 : 0));
    const lines = wrapText(node.label, labelWidth, font, ctx), secondary = node.secondaryLabel ? wrapText(node.secondaryLabel, labelWidth, secondaryFont, ctx) : [];
    const labelHeight = lines.length * font.size * 1.25 + secondary.length * 13.75 + (secondary.length ? 3 : 0);
    const contentHeight = labelHeight + (stacked ? iconSize + 5 : 0), top = originY + bar + (height - bar - contentHeight) / 2;
    const labelTop = panelBelowIcon ? originY + 14 + iconSize + 10 : top + (stacked ? iconSize + 5 : 0);
    const alignLeft = panel || node.labelAlign === 'left', textX = alignLeft ? originX + 12 + (!panel && !stacked && iconSize ? iconSize + 8 : 0) : cx + (!stacked && iconSize ? (iconSize + 8) / 2 : 0);
    const labelChildren = [textLines(lines, textX, labelTop + (kind ? font.size * 0.94 : 15), font, { class: 'typing-target', 'data-text-id': node.id, 'data-full-text': node.label, fill: textColor, 'text-anchor': alignLeft ? 'start' : 'middle' })];
    if (secondary.length) labelChildren.push(textLines(secondary, textX, labelTop + lines.length * 20 + 13, secondaryFont, { fill: card || panel ? theme.muted : '#36555d', 'text-anchor': alignLeft ? 'start' : 'middle' }));
    if (node.icon) {
      const iconX = panel ? originX + width - iconSize - 12 : stacked ? cx - iconSize / 2 : originX + 12;
      const iconY = panel ? originY + 14 : stacked ? top : cy + bar / 2 - iconSize / 2;
      const icon = icons.render(node.icon, iconX, iconY, style.iconColor || (node.icon.colorRole ? themes.role(theme, node.icon.colorRole).stroke : textColor), ctx);
      // A white medallion preserves recognizable dark brand marks on dark panels.
      children.push(el('g', { class: 'node-icon', transform: rotated ? `rotate(-90 ${cx} ${cy})` : undefined }, [node.icon.source === 'brand' && el('rect', { x: iconX - 4, y: iconY - 4, width: iconSize + 8, height: iconSize + 8, rx: 8, fill: '#ffffff', stroke: 'none' }), icon]));
    }
    const label = el('g', { class: 'node-label', 'data-node-id': node.id, 'data-cx': cx, 'data-cy': cy }, el('g', { transform: rotated ? `rotate(-90 ${cx} ${cy})` : undefined }, labelChildren));
    return { node: el('g', { class: 'node', 'data-node-id': node.id, 'data-reveal-id': node.id, 'data-cx': cx, 'data-cy': cy }, children), label };
  }
  function targetBox(id, scene) {
    const node = scene.nodes.find(n => n.id === id), column = scene.layout?.columns?.find(c => c.id === id), section = scene.layout?.sections?.find(s => s.id === id), annotation = scene.annotations.find(a => a.id === id);
    if (node || column) return node || column;
    if (section) return { ...section, x: 32, w: 736 };
    if (annotation && annotation.x !== undefined) return { x: annotation.x, y: annotation.y, w: annotation.w || annotation.maxWidth || 28, h: annotation.h || 28 };
    const edge = scene.edges.find(e => e.id === id);
    if (edge) { const path = geometry.forEdge(edge, scene.nodes), p = path.pointAt(path.length * (edge.label?.t ?? 0.5)); return { ...p, w: 0, h: 0 }; }
    throw new Error('Cannot resolve annotation target: ' + id);
  }
  function annotation(a, scene, theme, ctx) {
    let x = a.x, y = a.y;
    if (a.attachTo && (x === undefined || y === undefined)) {
      const target = targetBox(a.attachTo, scene), isNode = scene.nodes.some(n => n.id === a.attachTo);
      x ??= target.x + (isNode ? -6 : target.w / 2);
      y ??= target.y + (isNode ? -6 : target.h / 2);
    }
    const color = a.colorRole ? themes.role(theme, a.colorRole).stroke : theme.muted, children = [];
    if (a.kind === 'badge') children.push(badge(a.number, x, y, theme));
    else if (a.kind === 'check' || a.kind === 'cross') children.push(icons.render({ name: a.kind === 'check' ? 'check' : 'x', size: 20 }, x - 10, y - 10, a.kind === 'check' ? theme.success.stroke : theme.danger.stroke, ctx));
    else if (a.kind === 'header') children.push(layout.header(a.text, x, y, theme, ctx, a));
    else if (a.kind === 'code') {
      const size = a.fontSize || 13, lineHeight = size * 1.5, height = a.h || a.lines.length * lineHeight + 24, font = themes.font(theme, 'code', size);
      children.push(el('rect', { x: x + 4, y: y + 4, width: a.w, height, rx: 10, fill: theme.shadow }), el('rect', { x, y, width: a.w, height, rx: 10, fill: theme.dark ? '#102e37' : '#ffffff', stroke: theme.panelBorder, 'stroke-width': 1 }));
      a.lines.forEach((line, i) => {
        const top = y + 12 + i * lineHeight;
        if (line.band) children.push(el('rect', { x: x + 4, y: top - 2, width: a.w - 8, height: lineHeight, rx: 4, fill: themes.role(theme, line.band).soft }));
        const palette = { kw: theme.dark ? '#e880b5' : '#933a8b', str: theme.dark ? '#8cd9bf' : '#287958', num: theme.dark ? '#f5b35d' : '#b56a1b', cmt: theme.muted, plain: theme.dark ? '#e6f0f2' : '#263c44' };
        children.push(el('text', { x: x + 12, y: top + size, 'font-family': font.family, 'font-size': size, 'xml:space': 'preserve' }, codeTokens.tokenize(a.language || 'text', line.text).map(token => el('tspan', { class: token.className, fill: palette[token.type] }, token.text))));
        if (line.badge) {
          const left = line.badge.side === 'left', start = left ? x : x + a.w, end = start + (left ? -40 : 40), cy = top + size / 2;
          children.push(el('line', { x1: start, x2: end, y1: cy, y2: cy, stroke: color, 'stroke-width': 1.5 }), badge(line.badge.n, end, cy, theme, line.band ? themes.role(theme, line.band).fill : theme.orange.fill));
        }
      });
    } else if (a.kind === 'table') {
      const width = a.w / a.header.length;
      [a.header, ...a.rows].forEach((row, i) => row.forEach((cell, j) => {
        children.push(el('rect', { x: x + j * width, y: y + i * 28, width, height: 28, fill: i ? theme.panel : theme.neutral.soft, stroke: theme.panelBorder, 'stroke-width': 1 }), textLines([cell], x + j * width + 8, y + i * 28 + 18, themes.font(theme, 'body', 12, i ? 400 : 700), { fill: theme.titleText }));
      }));
    } else if (a.kind === 'callout') {
      const font = themes.font(theme, a.font || 'annotation', a.fontSize || 13), width = a.w || a.maxWidth || 190, lines = wrapText(a.text, width, font, ctx), height = lines.length * font.size * 1.25;
      const anchor = a.align === 'center' ? 'middle' : a.align === 'right' ? 'end' : 'start', textX = x + (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
      if (a.target) {
        const target = geometry.anchor(targetBox(a.target, scene), a.targetAnchor || 'top'), center = { x: x + width / 2, y: y + height / 2 }, dx = target.x - center.x, dy = target.y - center.y;
        const scale = Math.min(Math.abs(dx) ? width / 2 / Math.abs(dx) : Infinity, Math.abs(dy) ? height / 2 / Math.abs(dy) : Infinity);
        const start = { x: center.x + dx * (Number.isFinite(scale) ? scale : 0), y: center.y + dy * (Number.isFinite(scale) ? scale : 0) }, length = Math.hypot(target.x - start.x, target.y - start.y) || 1, sign = a.curve === 'cw' ? 1 : a.curve === 'ccw' ? -1 : dx >= 0 ? -1 : 1;
        const control = { x: (start.x + target.x) / 2 - (target.y - start.y) / length * 40 * sign, y: (start.y + target.y) / 2 + (target.x - start.x) / length * 40 * sign };
        children.push(el('path', { d: `M ${start.x},${start.y} Q ${control.x},${control.y} ${target.x},${target.y}`, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'marker-end': a.arrow === false ? undefined : ref(edges.markerId(color, 2, ctx)) }));
      }
      children.push(textLines(lines, textX, y + font.size, font, { class: 'typing-target', 'data-text-id': a.id, 'data-full-text': a.text, fill: color, 'text-anchor': anchor }));
    }
    return el('g', { class: 'annotation', 'data-annotation-id': a.id, 'data-reveal-id': a.id, 'data-cx': x + (a.w || 0) / 2, 'data-cy': y + (a.h || 0) / 2 }, children);
  }
  function render(scene, context = {}) {
    if (scene.layout?.kind === 'mindmap') context = { ...context, mindmapKinds: new Map(scene.layout.mindmap.placement.items.map(item => [item.id, item.kind])) };
    const theme = themes.get(scene.theme), ctx = { ...context, assets: scene.assets || {} }, defs = definitions(theme, scene, ctx);
    const sections = layout.sections(scene, theme, ctx, defs), brand = layout.brand(scene, theme, ctx, defs), nodes = scene.nodes.map(n => nodeParts(n, theme, ctx));
    const layers = { bg: background(scene, theme), sections, edges: scene.edges.map(e => edges.render(e, scene, theme, ctx)), particles: [], nodes: nodes.map(n => n.node), labels: nodes.map(n => n.label), annotations: (scene.annotations || []).map(a => annotation(a, scene, theme, ctx)), title: layout.title(scene, theme, ctx), brand };
    const root = el('svg', { xmlns: 'http://www.w3.org/2000/svg', id: 'scene', 'data-scene-id': scene.id, viewBox: '0 0 800 ' + scene.canvas.height, width: 800, height: scene.canvas.height, role: 'img', 'aria-labelledby': 'scene-description' }, [el('title', { id: 'scene-description' }, scene.title.text), el('defs', {}, defs), ...Object.entries(layers).map(([name, children]) => el('g', { id: 'layer-' + name }, children))]);
    return { svgString: svg.serialize(root), warnings: [...(scene.warnings || [])] };
  }
  return { render, wrapText, shape, nodeParts, annotation };
});
