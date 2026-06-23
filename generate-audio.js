// Pre-generates ElevenLabs mp3 for EVERY sentence into data/tts-cache/ using the
// exact same cache-key as the app, so a shipped cache means zero API calls for users.
// Resumable: skips files that already exist. Run: node generate-audio.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const t = cfg.tts || {};
const VOICE = t.voiceId, MODEL = t.modelId;
const SPEED = t.speed ?? 0.85, STAB = t.stability ?? 0.5, SIM = t.similarityBoost ?? 0.8;
const PROXY = (t.proxyUrl || "").replace(/\/$/, "");
const SECRET = t.proxySecret || "";
const KEY = t.apiKey || process.env.ELEVENLABS_API_KEY || "";
const CACHE = path.join(ROOT, "data", "tts-cache");
const CONCURRENCY = Number(process.env.CONC) || 5;

if (!KEY) { console.error("Нет ELEVENLABS_API_KEY"); process.exit(1); }
fs.mkdirSync(CACHE, { recursive: true });

function keyFor(text) {
  return crypto.createHash("sha1").update(`${VOICE}|${MODEL}|${SPEED}|${STAB}|${SIM}|${text}`).digest("hex");
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sentences.json"), "utf8"));
const texts = [];
const seen = new Set();
for (const g of data.groups || []) for (const s of g.sentences || []) {
  if (!seen.has(s.text)) { seen.add(s.text); texts.push(s.text); }
}

const todo = texts.filter((text) => !fs.existsSync(path.join(CACHE, `${keyFor(text)}.mp3`)));
console.log(`Всего уникальных фраз: ${texts.length}. Уже в кэше: ${texts.length - todo.length}. К генерации: ${todo.length}`);

let done = 0, failed = 0;
async function gen(text) {
  const file = path.join(CACHE, `${keyFor(text)}.mp3`);
  if (fs.existsSync(file)) return;
  const url = `${PROXY ? PROXY + "/elevenlabs" : "https://api.elevenlabs.io"}/v1/text-to-speech/${VOICE}`;
  const headers = { "xi-api-key": KEY, "Content-Type": "application/json", Accept: "audio/mpeg" };
  if (PROXY && SECRET) headers["X-Proxy-Secret"] = SECRET;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers,
        body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: STAB, similarity_boost: SIM, speed: SPEED } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error("too small");
      fs.writeFileSync(file, buf);
      return;
    } catch (e) {
      if (attempt === 3) { failed++; console.error("FAIL:", text.slice(0, 40), String(e.message)); return; }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function run() {
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const text = todo[i++];
      await gen(text);
      done++;
      if (done % 25 === 0 || done === todo.length) console.log(`  ${done}/${todo.length} (ошибок: ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Готово. Сгенерировано: ${done - failed}, ошибок: ${failed}. Кэш: ${CACHE}`);
}
run();
