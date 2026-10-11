// Pocket Vault — forgiving search over titles, tags, categories and fields.
// Built for dictated queries: "show my passport", "aadhar", "SBI IFSC".

const STOP_WORDS = new Set([
  'show', 'me', 'my', 'the', 'a', 'an', 'please', 'open', 'find', 'get', 'give',
  'i', 'need', 'want', 'to', 'see', 'of', 'for', 'card', 'details', 'detail', 'number',
  'what', 'is', 'where', 'whats', 'can', 'you', 'copy',
]);

// Common alternative spellings and things dictation tends to produce.
const ALIASES = {
  aadhar: 'aadhaar', adhaar: 'aadhaar', adhar: 'aadhaar', aadhaar: 'aadhaar', uid: 'aadhaar',
  licence: 'license', licenses: 'license', dl: 'license',
  passports: 'passport', pass: 'passport',
  pan: 'pan', pancard: 'pan',
  rc: 'registration', insurance: 'insurance',
  bank: 'bank', account: 'account', acct: 'account', ac: 'account',
  ifsc: 'ifsc', ifc: 'ifsc',
};

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => ALIASES[t] || t);
}

function queryTokens(q) {
  const all = tokenize(q);
  const meaningful = all.filter((t) => !STOP_WORDS.has(t));
  // "card" alone ("Aadhaar card" dictated as "card") should still search.
  return meaningful.length ? meaningful : all;
}

// Damerau–Levenshtein distance (optimal string alignment), capped for speed.
export function editDistance(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

// Score one query token against one document token.
function tokenScore(q, d) {
  if (q === d) return 1;
  if (d.startsWith(q) && q.length >= 2) return 0.85;
  if (q.length >= 4 && d.length >= 4) {
    const allowed = q.length >= 7 ? 2 : 1;
    const dist = editDistance(q, d, allowed);
    if (dist <= allowed) return 0.7 - 0.1 * dist;
  }
  if (q.length >= 3 && d.includes(q)) return 0.5;
  return 0;
}

function bestIn(q, tokens) {
  let best = 0;
  for (const d of tokens) {
    const s = tokenScore(q, d);
    if (s > best) best = s;
    if (best === 1) break;
  }
  return best;
}

// Returns items with a score, best first. Empty query → all items.
export function search(items, query) {
  const qs = queryTokens(query);
  if (!qs.length) return items.map((item) => ({ item, score: 0 }));
  const results = [];
  for (const item of items) {
    const title = tokenize(item.title);
    const tags = (item.tags || []).flatMap(tokenize);
    const category = tokenize(item.category);
    const fields = (item.fields || []).flatMap((f) => [...tokenize(f.label), ...tokenize(f.value)]);
    const notes = tokenize(item.notes);
    let total = 0;
    let matched = 0;
    for (const q of qs) {
      const s = Math.max(
        bestIn(q, title) * 3,
        bestIn(q, tags) * 2.5,
        bestIn(q, category) * 1.5,
        bestIn(q, fields) * 1.2,
        bestIn(q, notes) * 0.8
      );
      if (s > 0) matched++;
      total += s;
    }
    if (matched === 0) continue;
    // Prefer items that match every word; then pinned items on a tie.
    const coverage = matched / qs.length;
    const score = total * (0.5 + 0.5 * coverage) + (item.pinned ? 0.05 : 0);
    results.push({ item, score });
  }
  results.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return results;
}
