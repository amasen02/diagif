(function (root, factory) {
  const api = factory(root.TechGif || {}, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { pageRuntime: api });
  if (root.document) root.__TECH_GIF__ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif, root) {
  'use strict';
  const pathGeometry = TechGif.pathGeometry || require('./path-geometry.js');
  let mountedScene = null, attached = null;
  function dependency(name) {
    const value = (root.TechGif || TechGif)[name];
    if (!value) throw new Error('module not loaded: ' + name);
    return value;
  }
  function measureText(text, fontSpec = {}) {
    if (!root.document) throw new Error('measureText requires a browser document');
    const element = root.document.querySelector('#text-measure text');
    if (!element) throw new Error('Missing text measurement host');
    for (const attr of [...element.attributes]) element.removeAttribute(attr.name);
    if (typeof fontSpec === 'string') element.style.font = fontSpec;
    else {
      element.setAttribute('font-family', fontSpec.family || fontSpec.fontFamily || 'Inter');
      element.setAttribute('font-size', fontSpec.size || fontSpec.fontSize || 16);
      element.setAttribute('font-weight', fontSpec.weight || fontSpec.fontWeight || 400);
      if (fontSpec.letterSpacing !== undefined) element.setAttribute('letter-spacing', fontSpec.letterSpacing);
    }
    element.textContent = text;
    return element.getComputedTextLength();
  }
  function mountSvg(svgString, scene, warnings = []) {
    attached = null; mountedScene = null;
    const animations = dependency('animations'), timeline = dependency('timeline');
    const host = root.document?.getElementById('root');
    if (!host) throw new Error('Missing #root render host');
    host.innerHTML = svgString;
    const svg = host.querySelector('svg#scene');
    if (!svg) throw new Error('DOM contract: svg#scene missing');
    if (svg.getAttribute('viewBox') !== '0 0 ' + scene.canvas.width + ' ' + scene.canvas.height) throw new Error('DOM contract: scene viewBox mismatch');
    host.style.width = scene.canvas.width + 'px';
    const pathMetrics = pathGeometry.createPathMetrics(scene), geometrySelfCheck = [];
    for (const el of svg.querySelectorAll('path.edge-path')) {
      const edgeId = el.getAttribute('data-edge-id'), ours = pathMetrics.length(edgeId), dom = el.getTotalLength(), relErr = Math.abs(ours - dom) / ours;
      geometrySelfCheck.push({ edgeId, dom, ours, relErr });
      if (!Number.isFinite(relErr) || relErr >= 0.005) throw new Error('Geometry self-check failed for ' + edgeId + ': ' + relErr);
    }
    const overflows = [];
    for (const label of svg.querySelectorAll('g.node-label[data-node-id]')) {
      const node = scene.nodes.find(n => n.id === label.getAttribute('data-node-id'));
      if (!node) { overflows.push('Unknown label node ' + label.getAttribute('data-node-id')); continue; }
      const b = label.getBBox();
      if (b.width && b.height && (b.x < node.x || b.y < node.y || b.x + b.width > node.x + node.w || b.y + b.height > node.y + node.h)) overflows.push(node.id + ': ' + JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }));
    }
    if (overflows.length) throw new Error('Text overflow: ' + overflows.join('; '));
    const runtime = animations.attach(svg, scene, timeline, pathMetrics);
    if (!runtime || typeof runtime.seek !== 'function') throw new Error('animations.attach must return { seek }');
    attached = runtime; mountedScene = scene;
    attached.seek(0);
    return { width: scene.canvas.width, height: scene.canvas.height, warnings: [...warnings], geometrySelfCheck };
  }
  function mount(scene) {
    const renderStatic = dependency('renderStatic');
    if (typeof renderStatic.render !== 'function') throw new Error('module not loaded: renderStatic');
    dependency('animations'); dependency('timeline');
    const rendered = renderStatic.render(scene, { measureText, iconData: dependency('iconData') });
    if (!rendered || typeof rendered.svgString !== 'string') throw new Error('renderStatic.render must return { svgString, warnings }');
    return mountSvg(rendered.svgString, scene, rendered.warnings || []);
  }
  function seek(timeMs) {
    if (!attached) throw new Error('No scene mounted');
    if (!Number.isFinite(timeMs)) throw new Error('seek requires finite timeMs');
    attached.seek(timeMs);
  }
  function frameCount(stepMs) {
    if (!mountedScene) throw new Error('No scene mounted');
    if (![40, 50].includes(stepMs)) throw new Error('Unsupported sampling grid: ' + stepMs);
    return mountedScene.timeline.durationMs / stepMs;
  }
  return { mount, mountSvg, seek, frameCount, measureText };
});
