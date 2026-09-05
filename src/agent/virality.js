'use strict';

const stopWords = new Set('a an the and or of to in on for with is are it this that your'.split(' '));
function scoreCandidate(candidate, now = Date.now()) {
  const title = String(candidate.title || '').toLowerCase().trim();
  const format = /\b\w+\s+vs\.?\s+\w+\b/.test(title) ? 28 : /^(how|why)\b.*\b(works?|fails?|matters?)\b/.test(title) ? 24 :
    /^\d+[- ]?(step|ways?|rules?|mistakes?)/.test(title) ? 22 : /(mistake|anti-pattern|wrong|fix)/.test(title) ? 18 : 0;
  const tokens = (title.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).filter(word => !stopWords.has(word));
  const genericPenalty = tokens.length < 3 ? 12 : /^(guide|tips|best practices|overview)$/.test(title) ? 8 : 0;
  const time = candidate.publishedAt ? Date.parse(candidate.publishedAt) : NaN;
  const ageDays = Number.isFinite(time) ? Math.max(0, (Number(now) - time) / 86400000) : 30;
  const recency = ageDays <= 1 ? 20 : ageDays <= 7 ? 16 : ageDays <= 30 ? 10 : ageDays <= 90 ? 4 : 0;
  const signals = candidate.engagement || candidate.signals || candidate;
  const positive = value => Number.isFinite(value) ? Math.max(0, value) : 0;
  const engagement = Math.min(25, Math.round(6 * Math.log10(1 + positive(signals.score)) + 4 * Math.log10(1 + positive(signals.comments))));
  const sourceBonus = { hn: 7, reddit: 7, github: 5, page: 2 }[candidate.provider] || 0;
  return Math.max(0, Math.min(100, Math.round(format + recency + engagement + sourceBonus - genericPenalty)));
}
function rankCandidates(candidates, now = Date.now()) {
  return candidates.map(candidate => ({ ...candidate, virality: scoreCandidate(candidate, now) }))
    .sort((a, b) => b.virality - a.virality || a.title.localeCompare(b.title, 'en'));
}
module.exports = { scoreCandidate, rankCandidates };
