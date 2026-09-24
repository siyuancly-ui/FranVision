// FranVision Job Generator -- fuzzy matching of a job's Client Name against Wave customer names,
// for the "Suggested:" chips in the Bill To picker (2026-09-24, user OK'd some inaccurate suggestions).
// Pure functions, no I/O. Lower score = better match; null = no match.
//   0  same name (case/whitespace/punctuation-insensitive)
//   1  one name contains the other (shorter side >= 3 chars, or >= 2 for CJK names)
//   2  same words in a different order / one name's words are all in the other ("Smith Jane" ~ "Jane A. Smith")
//   3  a small spelling difference (edit distance 1, or 2 for long names: "Margret" ~ "Margaret")

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[.,'’"()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const CJK = /[㐀-鿿豈-﫿]/;

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function score(query, name) {
  const q = normalize(query), n = normalize(name);
  if (!q || !n) return null;
  if (q === n) return 0;
  const shorter = q.length <= n.length ? q : n;
  const longer = shorter === q ? n : q;
  if (shorter.length >= (CJK.test(shorter) ? 2 : 3) && longer.includes(shorter)) return 1;
  const qt = q.split(' '), nt = n.split(' ');
  const [small, big] = qt.length <= nt.length ? [qt, nt] : [nt, qt];
  if (small.length >= 1 && small.every((t) => t.length >= 2 && big.includes(t))) return 2;
  const maxEdits = longer.length >= 8 ? 2 : longer.length >= 5 ? 1 : 0;
  if (maxEdits && editDistance(q, n, maxEdits) <= maxEdits) return 3;
  return null;
}

// rows: [{id, name, ...}] -> matching rows, best first (ties alphabetical), each with a `matchScore`.
function rankMatches(query, rows, limit) {
  const out = [];
  for (const r of rows || []) {
    const s = score(query, r.name);
    if (s !== null) out.push(Object.assign({}, r, { matchScore: s }));
  }
  out.sort((a, b) => a.matchScore - b.matchScore || String(a.name).localeCompare(String(b.name)));
  return limit ? out.slice(0, limit) : out;
}

module.exports = { normalize, editDistance, score, rankMatches };
