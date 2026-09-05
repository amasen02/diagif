(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { svgBuilder: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  function number(value) {
    if (!Number.isFinite(value)) throw new Error('Non-finite SVG coordinate');
    return String(Number(value.toFixed(2)));
  }
  function el(tag, attrs = {}, children = []) { return { tag, attrs, children: [children].flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) }; }
  // Only vetted vendored icon markup may enter through raw(). Text always escapes.
  const raw = markup => ({ markup });
  const ref = id => 'url' + '(#' + id + ')';
  function serialize(tree) {
    if (typeof tree !== 'object') return escape(tree);
    if (Object.hasOwn(tree, 'markup')) return tree.markup;
    if (!/^[A-Za-z][\w:-]*$/.test(tree.tag)) throw new Error('Invalid SVG tag');
    const attrs = Object.entries(tree.attrs).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([key, value]) => {
      if (!/^[A-Za-z_][\w:.-]*$/.test(key)) throw new Error('Invalid SVG attribute');
      return ' ' + key + '="' + escape(typeof value === 'number' ? number(value) : value) + '"';
    }).join('');
    return '<' + tree.tag + attrs + '>' + tree.children.map(serialize).join('') + '</' + tree.tag + '>';
  }
  const estimator = (text, spec) => Array.from(text).length * 0.58 * spec.size;
  function wrapText(text, maxWidthPx, fontSpec, ctx = {}) {
    if (!(maxWidthPx > 0)) throw new Error('wrapText width must be positive');
    const measure = ctx.measureText || estimator, result = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && measure(line + ' ' + word, fontSpec) <= maxWidthPx) { line += ' ' + word; continue; }
        if (line) { result.push(line); line = ''; }
        for (const char of word) {
          if (line && measure(line + char, fontSpec) > maxWidthPx) { result.push(line); line = ''; }
          line += char;
        }
      }
      result.push(line);
    }
    return result;
  }
  function textLines(lines, x, y, spec, attrs = {}) {
    return el('text', { x, y, 'font-family': spec.family, 'font-size': spec.size, 'font-weight': spec.weight || 400, ...attrs },
      lines.map((line, i) => el('tspan', { x, dy: i ? '1.25em' : 0 }, line)));
  }
  return { el, raw, ref, serialize, escape, number, estimator, wrapText, textLines };
});
