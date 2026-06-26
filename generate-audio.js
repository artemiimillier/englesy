// Pre-generates ElevenLabs mp3 for EVERY sentence of a language into data/tts-cache/
// using the exact same cache-key as the app, so a shipped cache means zero API calls
// for users. Per-language voice: languages.<lang>.tts.voiceId overrides the global voice.
// Resumable: skips files that already exist.
//
// Usage:
//   node generate-audio.js          # generate audio for every language
//   node generate-audio.js fr       # only French
//   node generate-audio.js en fr    # the listed languages
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const LANG_ROOT = path.join(ROOT, "data", "languages");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const g = cfg.tts || {};
const PROXY = (g.proxyUrl || "").replace(/\/$/, "");
const SECRET = g.proxySecret || "";
const KEY = g.apiKey || process.env.ELEVENLABS_API_KEY || "";
const CACHE = path.join(ROOT, "data", "tts-cache");
const CONCURRENCY = Number(process.env.CONC) || 5;

if (!KEY) { console.error("Нет ELEVENLABS_API_KEY"); process.exit(1); }
fs.mkdirSync(CACHE, { recursive: true });

// Effective TTS settings for a language (global tts with the language's tts overlaid).
function ttsFor(lang) {
  const L = ((cfg.languages || {})[lang] || {}).tts || {};
  const t = { ...g, ...L };
  return {
    voice: t.voiceId,
    model: t.modelId ?? "eleven_multilingual_v2",
    speed: t.speed ?? 0.85,
    stab: t.stability ?? 0.5,
    sim: t.similarityBoost ?? 0.8,
  };
}

function keyFor(t, text) {
  return crypto.createHash("sha1").update(`${t.voice}|${t.model}|${t.speed}|${t.stab}|${t.sim}|${text}`).digest("hex");
}

function listLanguages() {
  if (!fs.existsSync(LANG_ROOT)) return [];
  return fs.readdirSync(LANG_ROOT).filter((d) => fs.existsSync(path.join(LANG_ROOT, d, "sentences.json")));
}

async function gen(t, text) {
  const file = path.join(CACHE, `${keyFor(t, text)}.mp3`);
  if (fs.existsSync(file)) return { skipped: true };
  const url = `${PROXY ? PROXY + "/elevenlabs" : "https://api.elevenlabs.io"}/v1/text-to-speech/${t.voice}`;
  const headers = { "xi-api-key": KEY, "Content-Type": "application/json", Accept: "audio/mpeg" };
  if (PROXY && SECRET) headers["X-Proxy-Secret"] = SECRET;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ text, model_id: t.model, voice_settings: { stability: t.stab, similarity_boost: t.sim, speed: t.speed } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error("too small");
      fs.writeFileSync(file, buf);
      return { ok: true };
    } catch (e) {
      if (attempt === 3) { console.error("FAIL:", text.slice(0, 40), String(e.message)); return { failed: true }; }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function runLang(lang) {
  const t = ttsFor(lang);
  if (!t.voice) { console.error(`[${lang}] нет voiceId (languages.${lang}.tts.voiceId или tts.voiceId) — пропуск`); return; }
  const data = JSON.parse(fs.readFileSync(path.join(LANG_ROOT, lang, "sentences.json"), "utf8"));
  const texts = [];
  const seen = new Set();
  for (const grp of data.groups || []) for (const s of grp.sentences || []) {
    if (!seen.has(s.text)) { seen.add(s.text); texts.push(s.text); }
  }
  const todo = texts.filter((text) => !fs.existsSync(path.join(CACHE, `${keyFor(t, text)}.mp3`)));
  console.log(`[${lang}] voice=${t.voice} model=${t.model} — уникальных фраз: ${texts.length}, в кэше: ${texts.length - todo.length}, к генерации: ${todo.length}`);

  let i = 0, done = 0, failed = 0;
  async function worker() {
    while (i < todo.length) {
      const text = todo[i++];
      const r = await gen(t, text);
      if (r && r.failed) failed++;
      done++;
      if (done % 25 === 0 || done === todo.length) console.log(`  [${lang}] ${done}/${todo.length} (ошибок: ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[${lang}] Готово. Сгенерировано: ${done - failed}, ошибок: ${failed}.`);
}

(async () => {
  const args = process.argv.slice(2);
  const langs = args.length ? args : listLanguages();
  if (!langs.length) { console.error("Нет языков под data/languages/"); process.exit(1); }
  for (const lang of langs) await runLang(lang);
  console.log(`Кэш: ${CACHE}`);
})();
