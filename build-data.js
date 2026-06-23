// Merges all curriculum level files in data/curriculum/*.json into data/sentences.json,
// ordered by CEFR level (A1 -> A2 -> B1 -> B2 -> B2+) so SRS introduces new material
// in difficulty order. Validates per-word gloss alignment.
const fs = require("fs");
const path = require("path");

const CUR_DIR = path.join(__dirname, "data", "curriculum");
const OUT = path.join(__dirname, "data", "sentences.json");
const RANK = { A1: 0, A2: 1, B1: 2, B2: 3, "B2+": 4, C1: 5 };

function loadGroups(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const groups = Array.isArray(raw) ? raw : raw.groups || [];
  return groups;
}

let all = [];
const files = fs.readdirSync(CUR_DIR).filter((f) => f.endsWith(".json")).sort();
for (const f of files) {
  const groups = loadGroups(path.join(CUR_DIR, f));
  groups.forEach((g) => { if (!g.level) g.level = "A2"; });
  all.push(...groups);
  console.log(`  ${f}: ${groups.length} groups, ${groups.reduce((n, g) => n + g.sentences.length, 0)} sentences`);
}

// Stable sort by level rank, keeping within-level order.
all = all
  .map((g, i) => ({ g, i }))
  .sort((a, b) => (RANK[a.g.level] ?? 1) - (RANK[b.g.level] ?? 1) || a.i - b.i)
  .map((x) => x.g);

let warnings = 0;
all.forEach((g, gi) => {
  g.sentences.forEach((s, si) => {
    const words = s.text.trim().split(/\s+/);
    if (!s.gloss || s.gloss.length !== words.length) {
      warnings++;
      if (warnings <= 25) console.warn(`MISMATCH [${g.level}] g${gi} s${si}: "${s.text}" words=${words.length} gloss=${s.gloss ? s.gloss.length : 0}`);
    }
  });
});

const total = all.reduce((n, g) => n + g.sentences.length, 0);
const byLevel = {};
all.forEach((g) => { byLevel[g.level] = (byLevel[g.level] || 0) + g.sentences.length; });
fs.writeFileSync(OUT, JSON.stringify({ groups: all }, null, 2));
console.log(`\nWrote ${all.length} groups, ${total} sentences. By level:`, byLevel, `Gloss mismatches: ${warnings}`);
