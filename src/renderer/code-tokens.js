(function (root, factory) {
  const api = factory(root.TechGif || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { codeTokens: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const keywords = {
    sql: 'select from where group by having order limit offset as join inner outer left right on union all distinct asc desc and or not null case when then else end count sum avg insert into update set delete values with over partition',
    js: 'const let var function return async await class extends new if else for while throw try catch import export default true false null undefined this of in',
    ts: 'const let var function return async await class extends new if else for while throw try catch import export default true false null undefined this of in interface type public private readonly implements string number boolean void',
    python: 'def class return import from as if elif else for while in not and or is None True False with try except raise lambda yield async await pass',
    yaml: 'true false null yes no', json: 'true false null', bash: 'if then else fi for do done in case esac function export echo exit set', text: ''
  };
  function tokenize(language, text) {
    if (!Object.hasOwn(keywords, language)) throw new Error('Unknown code language: ' + language);
    if (language === 'text') return [{ type: 'plain', className: 'tok-plain', text }];
    const kw = new Set(keywords[language].split(' ')), hash = ['python', 'yaml', 'bash'].includes(language);
    const expression = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*|\/\*[\s\S]*?(?:\*\/|$)|--.*|#.*)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|([A-Za-z_$][\w$]*)|([\s\S])/gi;
    const tokens = [];
    for (const match of text.matchAll(expression)) {
      let type = match[1] ? 'str' : match[3] ? 'num' : match[4] && kw.has(language === 'sql' ? match[4].toLowerCase() : match[4]) ? 'kw' : 'plain';
      if (match[2]) {
        const valid = match[2].startsWith('#') ? hash : match[2].startsWith('--') ? language === 'sql' : ['js', 'ts'].includes(language);
        if (valid) type = 'cmt';
        else {
          // A comment delimiter from another language is ordinary text, not a comment.
          tokens.push({ type: 'plain', className: 'tok-plain', text: match[2].slice(0, 1) });
          tokens.push(...tokenize(language, match[2].slice(1))); continue;
        }
      }
      const previous = tokens[tokens.length - 1];
      if (previous?.type === type) previous.text += match[0];
      else tokens.push({ type, className: 'tok-' + type, text: match[0] });
    }
    return tokens;
  }
  return { tokenize };
});
