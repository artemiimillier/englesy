// Merges curriculum level files for one or more languages into per-language
// data/languages/<lang>/sentences.json, ordered by CEFR level (A1 -> A2 -> B1 -> B2 -> B2+)
// so SRS introduces new material in difficulty order. Validates per-word gloss alignment.
//
// Usage:
//   node build-data.js            # build every language under data/languages/
//   node build-data.js fr         # build only French
//   node build-data.js en fr      # build the listed languages
const fs = require("fs");
const path = require("path");

const LANG_ROOT = path.join(__dirname, "data", "languages");
const RANK = { A1: 0, A2: 1, B1: 2, B2: 3, "B2+": 4, C1: 5 };

function loadGroups(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.groups || [];
}

function listLanguages() {
  if (!fs.existsSync(LANG_ROOT)) return [];
  return fs
    .readdirSync(LANG_ROOT)
    .filter((d) => fs.existsSync(path.join(LANG_ROOT, d, "curriculum")));
}

function buildLang(lang) {
  const curDir = path.join(LANG_ROOT, lang, "curriculum");
  const out = path.join(LANG_ROOT, lang, "sentences.json");
  if (!fs.existsSync(curDir)) {
    console.warn(`[${lang}] no curriculum dir, skipping`);
    return;
  }
  let all = [];
  const files = fs.readdirSync(curDir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const groups = loadGroups(path.join(curDir, f));
    groups.forEach((g) => { if (!g.level) g.level = "A2"; });
    all.push(...groups);
    console.log(`  [${lang}] ${f}: ${groups.length} groups, ${groups.reduce((n, g) => n + g.sentences.length, 0)} sentences`);
  }

  // Stable sort by level rank, keeping within-level (file) order.
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
        if (warnings <= 25) console.warn(`  [${lang}] MISMATCH [${g.level}] g${gi} s${si}: "${s.text}" words=${words.length} gloss=${s.gloss ? s.gloss.length : 0}`);
      }
    });
  });

  const total = all.reduce((n, g) => n + g.sentences.length, 0);
  const byLevel = {};
  all.forEach((g) => { byLevel[g.level] = (byLevel[g.level] || 0) + g.sentences.length; });
  fs.writeFileSync(out, JSON.stringify({ groups: all }, null, 2));
  console.log(`[${lang}] Wrote ${all.length} groups, ${total} sentences. By level:`, byLevel, `Gloss mismatches: ${warnings}\n`);
  return warnings;
}

const args = process.argv.slice(2);
const langs = args.length ? args : listLanguages();
if (!langs.length) { console.error("No languages found under data/languages/"); process.exit(1); }
let totalWarn = 0;
for (const lang of langs) totalWarn += buildLang(lang) || 0;
if (totalWarn) console.warn(`Total gloss mismatches across all languages: ${totalWarn}`);
