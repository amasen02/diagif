'use strict';

// Count actual top-level Markdown items, not their authored numbering. Nested
// bullets and fenced examples are detail within a step, not additional steps.
function listItemCount(text) {
  let fence = null;
  const indents = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const item = line.match(/^( *)(?:\d+[.)]|[-+*]|•)\s+\S/);
    if (item) indents.push(item[1].length);
  }
  const top = Math.min(...indents);
  return indents.filter(indent => indent === top).length;
}

const numberWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)';
const number = '(?:\\d[\\d,]*|' + numberWord + '(?:(?:[ -]| and )' + numberWord + ')*)';
const nouns = '(?:steps?|stages?|tips?|ways?|lessons?|reasons?|patterns?|layers?|branches?|concepts?|points?|phases?|items?|takeaways?|principles?|techniques?|practices?|checks?|rules?|parts?|components?|strategies|strategy|examples?|things?|actions?)';
const countClaim = new RegExp('(?<![\\w.])(' + number + ')([*_]*\\s+(?:(?:key|simple|main|essential|numbered|practical|core)\\s+)?' + nouns + ')\\b', 'gi');

function consistentPost(post) {
  const count = listItemCount(post.lines.join('\n'));
  // Unlisted prose has no count to corroborate. Use a count-free caption in
  // that case. Technical quantities (HTTP 429, 2 replicas, 50 ms) stay intact.
  const fix = text => {
    const corrected = text.replace(countClaim, (match, value, rest) => count ? String(count) + rest : 'several' + rest);
    return count ? corrected : corrected.replace(/\b(these|those|the)\s+([*_]*)several\2\s+/gi, '$1 ');
  };
  return { ...post, hook: fix(post.hook), lines: post.lines.map(fix), cta: fix(post.cta) };
}

function postMarkdown(post) {
  const corrected = consistentPost(post);
  return [corrected.hook, '', ...corrected.lines, '', corrected.cta, '', corrected.hashtags.join(' '), ''].join('\n');
}

module.exports = { listItemCount, consistentPost, postMarkdown };
