// Validates one or more curriculum JSON files: valid JSON, required fields, and—critically—
// that each sentence's gloss array has exactly one entry per whitespace-separated word,
// in order (the app aligns gloss to words by index). Run before build-data.js.
//
// Usage: node validate-curriculum.js [--require-p] data/languages/fr/curriculum/01-greetings.json [more...]
// --require-p : also require a non-empty `p` (Russian-letter pronunciation) on every gloss entry.
const fs = require("fs");

const args = process.argv.slice(2);
const REQUIRE_P = args.includes("--require-p");
let errors = 0, sentences = 0, files = 0;
for (const file of args.filter((a) => a !== "--require-p")) {
  files++;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`✗ ${file}: invalid JSON — ${e.message}`);
    errors++;
    continue;
  }
  const groups = Array.isArray(raw) ? raw : raw.groups || [];
  groups.forEach((g, gi) => {
    if (!g.pattern) { console.error(`✗ ${file} g${gi}: missing "pattern"`); errors++; }
    if (!Array.isArray(g.sentences) || !g.sentences.length) { console.error(`✗ ${file} g${gi}: no sentences`); errors++; return; }
    g.sentences.forEach((s, si) => {
      sentences++;
      const where = `${file} g${gi}("${(g.pattern || "").slice(0, 24)}") s${si}`;
      if (!s.text || !s.text.trim()) { console.error(`✗ ${where}: empty text`); errors++; return; }
      if (!s.translation || !s.translation.trim()) { console.error(`✗ ${where}: missing translation — "${s.text}"`); errors++; }
      const words = s.text.trim().split(/\s+/);
      if (!Array.isArray(s.gloss)) { console.error(`✗ ${where}: gloss not an array — "${s.text}"`); errors++; return; }
      if (s.gloss.length !== words.length) {
        console.error(`✗ ${where}: word/gloss count ${words.length}≠${s.gloss.length} — "${s.text}"`);
        errors++;
      }
      s.gloss.forEach((gl, i) => {
        if (!gl || typeof gl.w !== "string" || typeof gl.t !== "string" || !gl.t.trim()) {
          console.error(`✗ ${where}: gloss[${i}] needs {w,t} with non-empty t — "${s.text}"`);
          errors++;
        }
        if (REQUIRE_P && (!gl || typeof gl.p !== "string" || !gl.p.trim())) {
          console.error(`✗ ${where}: gloss[${i}] needs non-empty p (transcription) — "${s.text}"`);
          errors++;
        }
      });
    });
  });
  if (!errors) console.log(`✓ ${file}: ${groups.length} groups OK`);
}

console.log(`\n${files} file(s), ${sentences} sentences, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
