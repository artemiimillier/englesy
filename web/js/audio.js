// js/audio.js
// TTS playback for ENGLESY's two-phase drill.
//
// Strategy (never throws outward):
//   1) Bundled ElevenLabs cache:  GET `${dataBase}/tts-cache/<sha1key>.mp3`  (works fully offline)
//   2) If a key is set and the clip is uncached:  POST ElevenLabs to synthesize on the fly
//      (same request body as ../generate-audio.js) — best-effort, NEVER blocks the drill.
//   3) Browser speechSynthesis fallback (language-appropriate voice).
//
// The cache key MUST byte-match the files produced by ../generate-audio.js:
//   key = sha1_hex(`${voice}|${model}|${speed}|${stab}|${sim}|${text}`)
// where the effective per-language tts = global cfg.tts overlaid with cfg.languages[lang].tts:
//   voice = tts.voiceId
//   model = tts.modelId        ?? "eleven_multilingual_v2"
//   speed = tts.speed          ?? 0.85
//   stab  = tts.stability      ?? 0.5
//   sim   = tts.similarityBoost?? 0.8
//
// Public: createAudio(rawCfg, lang) -> { speakSentence, speakWord, stop, setApiKey }

import { CONFIG } from './config.js';

// ----------------------------------------------------------------- helpers

const DEFAULT_DATA_BASE = '/data';
const DEFAULT_REPEAT_COUNT = 3;
const DEFAULT_GAP_MS = 550;

function dataBaseUrl() {
  try {
    const b = CONFIG && CONFIG.dataBase;
    if (typeof b === 'string' && b) return b.replace(/\/$/, '');
  } catch (e) { /* ignore */ }
  return DEFAULT_DATA_BASE;
}

// Effective per-language TTS params (global tts overlaid with languages[lang].tts).
// Mirrors ttsFor() in ../generate-audio.js EXACTLY so cache keys match the bundled mp3s.
function ttsFor(rawCfg, lang) {
  const cfg = rawCfg || {};
  const g = cfg.tts || {};
  const langs = cfg.languages || {};
  const L = (langs[lang] && langs[lang].tts) || {};
  const t = Object.assign({}, g, L);
  return {
    voice: t.voiceId,
    model: t.modelId != null ? t.modelId : 'eleven_multilingual_v2',
    speed: t.speed != null ? t.speed : 0.85,
    stab: t.stability != null ? t.stability : 0.5,
    sim: t.similarityBoost != null ? t.similarityBoost : 0.8,
  };
}

// SHA-1 hex of the cache-key string, via Web Crypto. Returns null if unavailable.
async function sha1Hex(s) {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') return null;
    const bytes = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
    return hex;
  } catch (e) {
    return null;
  }
}

async function cacheKeyFor(t, text) {
  const s = `${t.voice}|${t.model}|${t.speed}|${t.stab}|${t.sim}|${text}`;
  return sha1Hex(s);
}

function norm(text) {
  return String(text == null ? '' : text).trim();
}

// BCP-47 language hint for speechSynthesis, keyed by ENGLESY language code.
function langTag(lang) {
  const map = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', it: 'it-IT', ru: 'ru-RU', pt: 'pt-PT' };
  return map[lang] || (lang ? `${lang}-${String(lang).toUpperCase()}` : 'en-US');
}

// ----------------------------------------------------------------- factory

export function createAudio(rawCfg, lang) {
  const cfg = rawCfg || {};
  const t = ttsFor(cfg, lang);
  const base = dataBaseUrl();
  const tts = cfg.tts || {};
  const repeatCount = Math.max(1, Number(tts.repeatCount) || DEFAULT_REPEAT_COUNT);
  const gapMs = Math.max(0, Number(tts.gapMs) != null && !Number.isNaN(Number(tts.gapMs)) ? Number(tts.gapMs) : DEFAULT_GAP_MS);
  const speechLang = langTag(lang);

  let apiKey = (tts.apiKey ? String(tts.apiKey).trim() : '');

  // text -> Promise<objectURL|null>  (memoized fetched/synthesized clips so replays are instant)
  const clipCache = new Map();
  // Cache keys that returned 404 from the bundle (so we don't keep refetching).
  const missing = new Set();

  // Generation token: every stop() / new speakSentence() bumps it so stale loops bail out.
  let playToken = 0;
  let currentAudio = null;

  // -------------------------------------------------- #mic indicator
  function micEl() {
    try { return (typeof document !== 'undefined') ? document.getElementById('mic') : null; }
    catch (e) { return null; }
  }
  function setMicSpeaking(on) {
    const el = micEl();
    if (!el) return;
    try {
      if (on) { el.classList.add('speaking'); el.textContent = '🔊'; }
      else { el.classList.remove('speaking'); }
    } catch (e) { /* ignore */ }
  }
  function setMicNothing() {
    const el = micEl();
    if (!el) return;
    try { el.classList.remove('speaking'); el.textContent = '🔇'; } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------- low-level audio playback
  // Plays an <audio> from a URL. Resolves true on success, false on error.
  // Honors the play token so stop() can abort.
  function playUrl(url, token) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (currentAudio === audio) currentAudio = null;
        resolve(ok);
      };
      let audio;
      try {
        audio = new Audio();
        audio.preload = 'auto';
        audio.src = url;
      } catch (e) { resolve(false); return; }

      if (token !== playToken) { done(false); return; }
      currentAudio = audio;

      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      // Safety net: never hang the drill if the media element wedges.
      const guard = setTimeout(() => done(true), 30000);
      const clearGuard = () => { try { clearTimeout(guard); } catch (e) { /* ignore */ } };
      const wrap = (ok) => { clearGuard(); done(ok); };
      audio.onended = () => wrap(true);
      audio.onerror = () => wrap(false);

      try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => wrap(false));
      } catch (e) { wrap(false); }
    });
  }

  function stopCurrentAudio() {
    const a = currentAudio;
    currentAudio = null;
    if (!a) return;
    try { a.pause(); } catch (e) { /* ignore */ }
    try { a.onended = null; a.onerror = null; } catch (e) { /* ignore */ }
    try { a.src = ''; } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------- speechSynthesis fallback
  let cachedVoices = [];
  function loadVoices() {
    try {
      if (typeof speechSynthesis === 'undefined') return [];
      const v = speechSynthesis.getVoices();
      if (v && v.length) cachedVoices = v;
      return cachedVoices;
    } catch (e) { return cachedVoices; }
  }
  try {
    if (typeof speechSynthesis !== 'undefined') {
      loadVoices();
      if ('onvoiceschanged' in speechSynthesis) {
        speechSynthesis.onvoiceschanged = () => { loadVoices(); };
      }
    }
  } catch (e) { /* ignore */ }

  function ensureVoices() {
    return new Promise((resolve) => {
      const voices = loadVoices();
      if (voices && voices.length) { resolve(voices); return; }
      let settled = false;
      const finish = () => { if (settled) return; settled = true; resolve(loadVoices()); };
      try {
        if (typeof speechSynthesis !== 'undefined' && 'onvoiceschanged' in speechSynthesis) {
          const prev = speechSynthesis.onvoiceschanged;
          speechSynthesis.onvoiceschanged = () => {
            if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
            finish();
          };
        }
      } catch (e) { /* ignore */ }
      setTimeout(finish, 600);
    });
  }

  function pickVoice(voices) {
    if (!voices || !voices.length) return null;
    const want = speechLang.toLowerCase();           // e.g. "fr-fr"
    const wantPrefix = want.split('-')[0];           // e.g. "fr"
    return (
      voices.find((v) => v && v.lang && v.lang.toLowerCase() === want) ||
      voices.find((v) => v && v.lang && v.lang.toLowerCase().startsWith(wantPrefix + '-')) ||
      voices.find((v) => v && v.lang && v.lang.toLowerCase().startsWith(wantPrefix)) ||
      null
    );
  }

  // Speak via the browser engine. Resolves when done (or on any failure). Token-aware.
  function speakBrowser(text, token) {
    return new Promise((resolve) => {
      const value = norm(text);
      try {
        if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
          resolve(false); return;
        }
        if (!value) { resolve(true); return; }
        ensureVoices().then((voices) => {
          if (token !== playToken) { resolve(false); return; }
          try {
            const utter = new SpeechSynthesisUtterance(value);
            const voice = pickVoice(voices);
            if (voice) { utter.voice = voice; utter.lang = voice.lang; }
            else { utter.lang = speechLang; }
            const r = Number(tts.speed);
            // ElevenLabs speed (~0.85) maps loosely to SpeechSynthesis rate; clamp to a sane range.
            utter.rate = (!Number.isNaN(r) && r > 0) ? Math.max(0.5, Math.min(1.5, r + 0.05)) : 0.95;
            utter.pitch = 1.0;
            let done = false;
            const finish = (ok) => { if (done) return; done = true; resolve(ok); };
            utter.onend = () => finish(true);
            utter.onerror = () => finish(false);
            setTimeout(() => finish(true), 8000 + value.length * 90);
            speechSynthesis.speak(utter);
          } catch (e) { resolve(false); }
        });
      } catch (e) { resolve(false); }
    });
  }

  // -------------------------------------------------- clip resolution (cache → API)
  // Returns an object URL string for `text`, or null if no audio clip can be obtained.
  // Order: in-memory cache → bundled mp3 → (optional) ElevenLabs synth. Never throws.
  async function resolveClip(text) {
    const value = norm(text);
    if (!value) return null;
    if (clipCache.has(value)) {
      try { return await clipCache.get(value); } catch (e) { return null; }
    }
    const p = (async () => {
      // 1) bundled cache file
      const url = await fetchBundled(value);
      if (url) return url;
      // 2) live ElevenLabs synthesis, only if a key is present and we haven't already 404'd it
      if (apiKey) {
        const synth = await synthElevenLabs(value);
        if (synth) return synth;
      }
      return null;
    })();
    clipCache.set(value, p);
    // If it resolves to null, drop it so a later setApiKey() can retry synthesis.
    p.then((u) => { if (!u) clipCache.delete(value); }).catch(() => { clipCache.delete(value); });
    try { return await p; } catch (e) { return null; }
  }

  // Fetch the bundled mp3 for `text`. Returns an object URL or null (404 / unreachable / no crypto).
  async function fetchBundled(text) {
    if (!t.voice) return null;            // no voice configured → no cache key possible
    const key = await cacheKeyFor(t, text);
    if (!key) return null;
    if (missing.has(key)) return null;
    const url = `${base}/tts-cache/${key}.mp3`;
    try {
      if (typeof fetch === 'undefined') return null;
      const res = await fetch(url, { method: 'GET', cache: 'force-cache' });
      if (!res || !res.ok) {
        if (res && res.status === 404) missing.add(key);
        return null;
      }
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      // Some dev servers mislabel; accept anything that isn't obviously HTML/JSON error.
      if (ct && (ct.indexOf('text/html') !== -1 || ct.indexOf('application/json') !== -1)) {
        missing.add(key);
        return null;
      }
      const blob = await res.blob();
      if (!blob || blob.size < 200) { missing.add(key); return null; }
      return URL.createObjectURL(blob);
    } catch (e) {
      // Network/offline error: do NOT mark missing (the file may exist once back online / via SW).
      return null;
    }
  }

  // Synthesize via ElevenLabs using the same body as ../generate-audio.js. Best-effort.
  async function synthElevenLabs(text) {
    if (!apiKey || !t.voice) return null;
    try {
      if (typeof fetch === 'undefined') return null;
      const proxy = (cfg.tts && cfg.tts.proxyUrl ? String(cfg.tts.proxyUrl) : '').replace(/\/$/, '');
      const secret = (cfg.tts && cfg.tts.proxySecret) ? String(cfg.tts.proxySecret) : '';
      const url = `${proxy ? proxy + '/elevenlabs' : 'https://api.elevenlabs.io'}/v1/text-to-speech/${t.voice}`;
      const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' };
      if (proxy && secret) headers['X-Proxy-Secret'] = secret;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: norm(text),
          model_id: t.model,
          voice_settings: { stability: t.stab, similarity_boost: t.sim, speed: t.speed },
        }),
      });
      if (!res || !res.ok) return null;
      const blob = await res.blob();
      if (!blob || blob.size < 200) return null;
      return URL.createObjectURL(blob);
    } catch (e) {
      return null;
    }
  }

  function sleep(ms, token) {
    return new Promise((resolve) => {
      if (ms <= 0) { resolve(); return; }
      setTimeout(() => resolve(), ms);
    }).then(() => token === playToken);
  }

  // -------------------------------------------------- public: speakSentence
  // Play the cached clip `repeatCount` times with `gapMs` gaps; toggle #mic.speaking.
  // On no-clip: a single speechSynthesis pass. Never throws.
  async function speakSentence(text) {
    const value = norm(text);
    stop();                          // cancel anything currently playing
    const token = playToken;         // captured after stop() bumped it
    if (!value) return;

    let anything = false;
    try {
      const url = await resolveClip(value);
      if (token !== playToken) return;

      if (url) {
        setMicSpeaking(true);
        for (let i = 0; i < repeatCount; i++) {
          if (token !== playToken) break;
          const ok = await playUrl(url, token);
          anything = anything || ok;
          if (token !== playToken) break;
          if (i < repeatCount - 1) {
            const stillUs = await sleep(gapMs, token);
            if (!stillUs) break;
          }
        }
      } else {
        // Fallback: browser voice, single pass (repeating TTS sounds robotic & slow).
        setMicSpeaking(true);
        const ok = await speakBrowser(value, token);
        anything = anything || ok;
      }
    } catch (e) {
      // swallow — never break the drill
    } finally {
      if (token === playToken) {
        if (anything) setMicSpeaking(false);
        else setMicNothing();
      }
    }
  }

  // -------------------------------------------------- public: speakWord
  // Quick single play of one word — cached mp3 if present, else a short browser utterance.
  // Does NOT fight an in-progress sentence: it shares the token so a new sentence cancels it.
  async function speakWord(text) {
    const value = norm(text);
    if (!value) return;
    stop();
    const token = playToken;
    try {
      const url = await fetchBundled(value);   // word-level: only the bundle (don't burn API per word)
      if (token !== playToken) return;
      if (url) {
        setMicSpeaking(true);
        const ok = await playUrl(url, token);
        if (token === playToken) { ok ? setMicSpeaking(false) : setMicNothing(); }
      } else {
        setMicSpeaking(true);
        const ok = await speakBrowser(value, token);
        if (token === playToken) { ok ? setMicSpeaking(false) : setMicNothing(); }
      }
    } catch (e) {
      if (token === playToken) setMicNothing();
    }
  }

  // -------------------------------------------------- public: stop
  function stop() {
    playToken++;
    stopCurrentAudio();
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    setMicSpeaking(false);
  }

  // -------------------------------------------------- public: setApiKey
  function setApiKey(key) {
    apiKey = key == null ? '' : String(key).trim();
  }

  return { speakSentence, speakWord, stop, setApiKey };
}
