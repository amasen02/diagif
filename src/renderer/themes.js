(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { themes: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fonts = {
    display: '"Lilita One", "Segoe UI Black", "Segoe UI", Arial, sans-serif',
    condensed: '"Bebas Neue", "Segoe UI Semibold", "Segoe UI", Arial, sans-serif',
    body: '"Inter", "Segoe UI", "Segoe UI Variable", Arial, sans-serif',
    annotation: '"Patrick Hand", "Segoe Print", "Segoe UI", sans-serif',
    code: '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
    labelMono: '"Space Mono", "Cascadia Mono", Consolas, monospace',
    marker: '"Permanent Marker", "Segoe Print", "Segoe UI", sans-serif'
  };
  const colors = { primary: ['#62c7d9', '#207b90', '#d9f1f5'], secondary: ['#a99ad5', '#7863aa', '#eee9f8'], neutral: ['#d9e3e6', '#607780', '#edf1f3'], cyan: ['#62d2e8', '#16879d', '#ddf5fa'], mint: ['#8cd9bf', '#379795', '#ddf3e9'], orange: ['#f5b35d', '#ba7522', '#fff0d7'], magenta: ['#e880b5', '#d63384', '#fce5f1'], danger: ['#f68b87', '#d84b49', '#ffe8e6'], success: ['#89d5a6', '#32966a', '#e1f4e9'] };
  function make(options) {
    const roles = Object.fromEntries(Object.entries(colors).map(([key, [fill, stroke, soft]]) => [key, { fill, stroke: options.dark ? fill : stroke, soft: options.dark ? '#183b40' : soft, text: '#152f37' }]));
    const theme = { fonts, roles, ...roles, bg: '#fcfcfc', panel: '#ffffff', panelBorder: '#bacbd0', chip: '#f6ca74', chipText: '#172f35', shadow: '#3a2a1a', glow: '#62c7d9', footer: '#152f37', footerText: '#ffffff', link: '#62d2e8', muted: '#5e747b', particle: '#f5a524', tubeOuter: '#42666e', tubeCore: '#8bb8c3', tubeHighlight: '#d6f5fa', titleText: '#111111', titleShadow: '#62c7d9', grainDefault: false, elevationDefault: 'hard', ...options };
    return theme;
  }
  const themes = {
    paper: make({ grainDefault: true }),
    'dark-teal': make({ dark: true, bg: '#02252e', bgGradient: ['#053946', '#02252e'], panel: '#03282f', panelBorder: '#379795', chip: '#c6ede0', chipText: '#07383e', shadow: '#0a1c20', glow: '#62d2e8', footer: '#011d25', muted: '#a6c7c8', titleText: '#ffffff', titleShadow: '#0a1c20' }),
    'soft-light': make({ bg: '#eeeff1', panel: '#e0eaeb', panelBorder: '#b6c9cc', chip: '#d9d3e8', elevationDefault: 'soft', titleText: '#1f2a30', titleShadow: '#cfe9e6', particle: '#d63384', titleFont: 'body', titleWeight: 800 }),
    'black-card': make({ dark: true, bg: '#000000', panel: '#0b0f12', panelBorder: '#1c2428', chip: '#22d3ee', elevationDefault: 'none', titleText: '#ffffff', titleShadowKind: 'none', particle: '#22d3ee', muted: '#a3b7c0' }),
    ink: make({ dark: true, bg: '#0d0c1b', panel: '#eae6ed', panelBorder: '#645984', chip: '#f9a825', elevationDefault: 'glow', glow: '#976be8', titleText: '#e3342f', titleShadowKind: 'glow', titleShadow: '#e3342f', particle: '#f9a825', muted: '#b5b0cc' })
  };
  function get(name) { if (!Object.hasOwn(themes, name)) throw new Error('Unknown theme: ' + name); return themes[name]; }
  function role(theme, name = 'primary') { const token = theme.roles[name]; if (!token) throw new Error('Unknown color role: ' + name); return token; }
  function font(theme, name, size, weight = 400) { if (!theme.fonts[name]) throw new Error('Unknown font role: ' + name); return { family: theme.fonts[name], size, weight }; }
  return { ...themes, themes, fonts, get, resolve: get, role, font };
});
