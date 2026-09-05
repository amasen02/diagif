'use strict';


const stableErrors = errors => errors.map(e => ({ path: e.path || '/', message: String(e.message) }))
  .sort((a, b) => a.path.localeCompare(b.path, 'en') || a.message.localeCompare(b.message, 'en'));

async function validateAndInspect(input, options = {}) {
  const { timeoutMs = 60000 } = options;
  const open = options.open || require('../capture/capture-frames.js').openPage;
  const validateScene = options.validate || require('../schema.js').validateScene;
  const normalizeScene = options.normalize || require('../normalize-scene.js').normalizeScene;
  const scene = structuredClone(input), validation = validateScene(scene);
  if (!validation.valid) return { ok: false, errors: stableErrors(validation.errors), scene, brand: { ok: false } };
  const normalized = normalizeScene(scene);
  let session, expired = false, timer;
  const work = (async () => {
    session = await open(normalized);
    if (expired) { await session.close(); throw new Error('Scene inspection timed out'); }
    try {
      const report = await session.page.evaluate(s => {
        const errors = [], labels = [], annotations = [];
        const add = (path, message) => errors.push({ path, message });
        const rendered = window.TechGif.renderStatic.render(s, {
          measureText: window.__TECH_GIF__.measureText, iconData: window.TechGif.iconData
        });
        const parsed = new DOMParser().parseFromString(rendered.svgString, 'image/svg+xml');
        if (parsed.querySelector('parsererror')) add('/', 'SVG parser error');
        for (const element of parsed.querySelectorAll('[data-node-id],[data-edge-id],[data-reveal-id]')) {
          for (const attr of ['transform', 'opacity', 'style', 'stroke-dashoffset']) {
            if (element.hasAttribute(attr)) add('/', 'Managed attribute authored: ' + attr);
          }
          if (element.hasAttribute('stroke-dasharray')) {
            const edge = s.edges.find(e => e.id === element.getAttribute('data-edge-id'));
            if (!element.matches('path.edge-path') || !edge?.dashed) add('/edges', 'Unexpected managed stroke-dasharray');
          }
        }
        const svg = document.querySelector('svg#scene');
        // Typing resets text to empty at t=0. Measure the complete authored label.
        for (const el of svg.querySelectorAll('[data-full-text]')) {
          if (!el.textContent) el.textContent = el.getAttribute('data-full-text');
        }
        const box = el => { const b = el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        for (const label of svg.querySelectorAll('g.node-label')) {
          const id = label.getAttribute('data-node-id'), i = s.nodes.findIndex(n => n.id === id), n = s.nodes[i];
          if (!n) { add('/nodes', 'Label references unknown node ' + id); continue; }
          const b = box(label), counts = [...label.querySelectorAll('text')].map(t => t.querySelectorAll('tspan').length || 1);
          labels.push({ path: '/nodes/' + i + '/label', id, box: b, lines: counts });
          if (counts.some(n => n > 2)) add('/nodes/' + i + '/label', 'Measured label exceeds two lines');
          if (b.w && b.h && (b.x < n.x + 4 || b.y < n.y + 4 || b.x + b.w > n.x + n.w - 4 || b.y + b.h > n.y + n.h - 4)) {
            add('/nodes/' + i + '/label', 'Measured label violates 4 px inset');
          }
        }
        for (const el of svg.querySelectorAll('g.annotation')) {
          const id = el.getAttribute('data-annotation-id'), i = s.annotations.findIndex(a => a.id === id);
          if (i < 0) { add('/annotations', 'Unknown annotation ' + id); continue; }
          const a = s.annotations[i], b = box(el);
          // A callout's pointer intentionally touches its target; measure its text.
          const texts = [...el.querySelectorAll('text')];
          const boxes = a.kind === 'callout' ? texts.map(box) : [b];
          annotations.push({ path: '/annotations/' + i, id, box: b, boxes, kind: a.kind, attachTo: a.attachTo });
          for (let j = 0; j < s.nodes.length; j++) {
            if (a.attachTo === s.nodes[j].id && ['badge', 'check', 'cross'].includes(a.kind)) continue;
            if (boxes.some(b => intersects(b, s.nodes[j]))) add('/annotations/' + i, 'Measured annotation overlaps node ' + s.nodes[j].id);
          }
        }
        for (let i = 0; i < annotations.length; i++) for (let j = i + 1; j < annotations.length; j++) {
          const a = annotations[i], b = annotations[j];
          if (a.attachTo === b.id && ['badge', 'check', 'cross'].includes(a.kind) || b.attachTo === a.id && ['badge', 'check', 'cross'].includes(b.kind)) continue;
          if (a.boxes.some(x => b.boxes.some(y => intersects(x, y)))) add(b.path, 'Measured annotation overlaps annotation ' + a.id);
        }
        for (let i = 0; i < s.nodes.length; i++) for (let j = i + 1; j < s.nodes.length; j++) {
          if (intersects(s.nodes[i], s.nodes[j])) add('/nodes/' + j, 'Node overlaps ' + s.nodes[i].id);
        }
        const footer = [...svg.querySelectorAll('#layer-brand text')];
        const brand = { ok: true, texts: footer.map(el => ({ text: el.textContent, fontSize: parseFloat(getComputedStyle(el).fontSize), width: el.getComputedTextLength() })) };
        if (s.brand?.style === 'url-footer') {
          brand.ok = footer.length === 1 && brand.texts[0].text === s.brand.url && brand.texts[0].fontSize === 16 && brand.texts[0].width <= 736;
        } else if (s.brand?.style === 'none') brand.ok = footer.length === 0;
        else brand.ok = false;
        if (!brand.ok) add('/brand', 'Configured footer content, count, size or width failed');
        window.__TECH_GIF__.seek(0);
        return { errors, labels, annotations, brand };
      }, normalized);
      session.assertPage();
      const fonts = session.fonts || [];
      if (!fonts.length || fonts.some(f => f.status !== 'loaded')) report.errors.push({ path: '/fonts', message: 'Declared font did not load' });
      const geometrySelfCheck = session.mountInfo.geometrySelfCheck || [];
      for (const check of geometrySelfCheck) if (!Number.isFinite(check.relErr) || check.relErr >= 0.005) report.errors.push({ path: '/edges/' + check.edgeId, message: 'Path geometry self-check failed' });
      return { ...report, ok: !report.errors.length, errors: stableErrors(report.errors), scene,
        fonts, geometrySelfCheck, browserVersion: session.browser.version(), playwrightVersion: require('playwright/package.json').version };
    } finally { await session.close(); }
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; if (session) session.close().catch(() => {}); reject(new Error('Scene inspection timed out')); }, timeoutMs);
    })]);
  } catch (error) {
    return { ok: false, errors: stableErrors(error.errors || [{ path: '/', message: error.message }]), scene, brand: { ok: false } };
  } finally { clearTimeout(timer); }
}

module.exports = { validateAndInspect, inspectScene: validateAndInspect, stableErrors };
