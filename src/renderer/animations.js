(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { animations: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif) {
  'use strict';
  function attach(svgEl, scene, timeline, pathMetrics) {
    // The frozen four-argument mount API carries the capture grid on its SVG host.
    const stepMs = Number(svgEl.ownerDocument.documentElement.getAttribute('data-tech-gif-step-ms') || 40);
    const engine = timeline.create(scene, pathMetrics, { stepMs });
    const select = (attr, id, prefix = '') => [...svgEl.querySelectorAll(prefix + '[' + attr + ']')].filter(el => el.getAttribute(attr) === id);
    const required = (elements, label) => { if (!elements.length) throw new Error('DOM contract: missing ' + label); return elements; };
    const particleLayer = svgEl.querySelector('#layer-particles');
    if (!particleLayer) throw new Error('DOM contract: missing #layer-particles');
    const managed = [...svgEl.querySelectorAll('[data-node-id], [data-edge-id], [data-reveal-id], [data-text-id]')];
    const dashes = new Map([...svgEl.querySelectorAll('path.edge-path')].map(el => [el, el.getAttribute('stroke-dasharray')]));
    const shapes = new Map([...svgEl.querySelectorAll('.node-shape')].map(el => [el, { attr: el.getAttribute('stroke-width'), width: parseFloat(svgEl.ownerDocument.defaultView.getComputedStyle(el).strokeWidth) || 1 }]));
    const shadows = new Map([...svgEl.querySelectorAll('.node-shadow')].map(el => [el, el.getAttribute('transform')]));
    const texts = [...svgEl.querySelectorAll('[data-text-id][data-full-text]')];
    const originalText = new Map(texts.map(el => [el, [...el.childNodes].map(n => n.cloneNode(true))]));
    const typingIds = new Set(scene.timeline.animations.filter(a => a.kind === 'typing').flatMap(a => [a.targetId, a.mirrorTargetId].filter(Boolean)));
    function attr(el, key, value) { if (value === null) el.removeAttribute(key); else el.setAttribute(key, String(value)); }
    function reset() {
      for (const el of managed) for (const name of ['transform', 'opacity', 'style', 'stroke-dashoffset']) el.removeAttribute(name);
      for (const [el, dash] of dashes) attr(el, 'stroke-dasharray', dash);
      for (const [el, base] of shapes) attr(el, 'stroke-width', base.attr);
      for (const [el, transform] of shadows) attr(el, 'transform', transform);
      particleLayer.replaceChildren();
      for (const el of texts) {
        if (typingIds.has(el.getAttribute('data-text-id'))) el.textContent = '';
        else if (el.textContent !== el.getAttribute('data-full-text')) el.replaceChildren(...originalText.get(el).map(n => n.cloneNode(true)));
      }
    }
    function center(el, id) {
      if (el.hasAttribute('data-cx') && el.hasAttribute('data-cy')) return [Number(el.getAttribute('data-cx')), Number(el.getAttribute('data-cy'))];
      const node = scene.nodes.find(n => n.id === id);
      if (node) return [node.x + node.w / 2, node.y + node.h / 2];
      const box = el.getBBox(); return [box.x + box.width / 2, box.y + box.height / 2];
    }
    function scale(el, id, value) {
      const [x, y] = center(el, id);
      attr(el, 'transform', 'translate(' + x + ',' + y + ') scale(' + value + ') translate(' + -x + ',' + -y + ')');
    }
    const nodeElements = id => required(select('data-node-id', id, 'g'), 'node ' + id);
    const textElements = id => required(select('data-text-id', id), 'typing target ' + id);
    function revealElements(id) {
      const elements = required(select('data-reveal-id', id), 'reveal target ' + id);
      // Node labels are siblings of the shape layer and must reveal with their node.
      return [...new Set([...elements, ...select('data-node-id', id, 'g.node-label')])];
    }
    function color(a) {
      if (a.color) return a.color;
      const themes = TechGif.themes;
      const theme = themes && (typeof themes.get === 'function' ? themes.get(scene.theme) : themes[scene.theme]);
      if (theme) {
        const role = theme.roles?.[a.colorRole] || theme.colors?.[a.colorRole] || theme[a.colorRole];
        if (a.colorRole && role) return typeof role === 'string' ? role : role.stroke;
        if (!a.colorRole && theme.particle) return theme.particle;
      }
      // mountSvg remains usable before the static renderer and theme module arrive.
      const defaults = { 'dark-teal': '#f5a524', 'soft-light': '#d63384', 'black-card': '#22d3ee', ink: '#f9a825', paper: '#f5a524' };
      if (a.colorRole) {
        const edge = scene.edges.find(e => e.colorRole === a.colorRole);
        const stroke = edge && select('data-edge-id', edge.id, 'path.edge-path')[0]?.getAttribute('stroke');
        if (stroke) return stroke;
        throw new Error('Theme module required to resolve particle colorRole: ' + a.colorRole);
      }
      return defaults[scene.theme];
    }
    function circle(p, a, animationIndex, particleIndex, className, radius = p.radius, opacity = p.opacity) {
      const el = svgEl.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
      for (const [name, value] of Object.entries({ class: className, 'data-anim-index': animationIndex, 'data-particle-index': particleIndex,
        cx: p.x, cy: p.y, r: radius, opacity, fill: color(a) })) attr(el, name, value);
      if (p.trailIndex) attr(el, 'data-trail-index', p.trailIndex);
      particleLayer.appendChild(el);
    }
    function seek(timeMs) {
      const states = engine.state(timeMs);
      reset();
      for (const s of states) {
        const a = scene.timeline.animations[s.index];
        if (s.kind === 'particle-flow') for (const p of s.particles) {
          for (const trail of p.trails) circle(trail, a, s.index, p.particleIndex, 'particle-trail');
          if (a.glow) circle(p, a, s.index, p.particleIndex, 'particle-glow', p.radius + 4, 0.3 * p.opacity);
          circle(p, a, s.index, p.particleIndex, 'particle');
        }
        else if (s.kind === 'marching-dash') for (const id of s.edgeIds) for (const el of required(select('data-edge-id', id, 'path.edge-path'), 'edge path ' + id)) {
          attr(el, 'stroke-dasharray', s.dash + ' ' + s.gap); attr(el, 'stroke-dashoffset', s.offset);
        }
        else if (s.kind === 'pulse') for (const id of s.nodeIds) for (const el of nodeElements(id)) scale(el, id, s.scale);
        else if (s.kind === 'sequential-highlight') for (const n of s.nodes) for (const el of nodeElements(n.id)) {
          attr(el, 'opacity', n.opacity); scale(el, n.id, n.scale);
          for (const shape of el.querySelectorAll('.node-shape')) attr(shape, 'stroke-width', shapes.get(shape).width + n.weight);
          // Hard shadows already sit at (4,4); add up to two px to reach (6,6).
          for (const shadow of el.querySelectorAll('.node-shadow')) if (n.weight > 0 && !shadow.hasAttribute('filter')) {
            const original = shadows.get(shadow);
            attr(shadow, 'transform', 'translate(' + 2 * n.weight + ',' + 2 * n.weight + ')' + (original ? ' ' + original : ''));
          }
        }
        else if (s.kind === 'typing') {
          for (const [id, text] of [[s.targetId, s.text], [s.mirrorTargetId, s.mirrorText]]) if (id) for (const el of textElements(id)) { el.textContent = text; attr(el, 'opacity', s.opacity); }
        } else if (s.kind === 'reveal') for (const id of s.targetIds) for (const el of revealElements(id)) { attr(el, 'opacity', s.opacity); if (a.mode !== 'fade') scale(el, id, s.scale); }
      }
    }
    return { seek };
  }
  return { attach };
});
