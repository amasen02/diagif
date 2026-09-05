(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { icons: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TechGif) {
  'use strict';
  const iconData = TechGif.iconData || require('./icon-data.js');
  // icons precedes svg-builder in the manifest, so construct the same virtual nodes locally.
  const element = (tag, attrs, children = []) => ({ tag, attrs, children });
  function resolve(icon, ctx = {}) {
    const data = ctx.iconData || iconData, source = icon.source || 'line';
    if (source === 'art') {
      const href = ctx.assets?.['art:' + icon.name];
      if (!/^data:image\/(png|svg\+xml);base64,/.test(href || '')) throw new Error('Unknown art icon: ' + icon.name);
      return { source, href };
    }
    const dictionary = source === 'brand' ? data.brands : source === 'line' ? data.lucide : null;
    if (!dictionary || !Object.hasOwn(dictionary, icon.name)) throw new Error('Unknown icon: ' + source + ':' + icon.name);
    return { source, markup: dictionary[icon.name], color: source === 'brand' ? data.colors[icon.name] : null };
  }
  function render(icon, x, y, color, ctx = {}) {
    const resolved = resolve(icon, ctx), size = icon.size || 28;
    if (resolved.source === 'art') return element('image', { x, y, width: size, height: size, href: resolved.href, preserveAspectRatio: 'xMidYMid meet' });
    return element('svg', { x, y, width: size, height: size, viewBox: '0 0 24 24', color: resolved.color || color, fill: resolved.source === 'brand' ? resolved.color : 'none', stroke: resolved.source === 'line' ? 'currentColor' : 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, [{ markup: resolved.markup }]);
  }
  return { resolve, render };
});
