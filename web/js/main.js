// web/js/main.js — ENGLESY web bootstrap + wiring.
//
// The integrator: this is the glue. It imports the real modules and wires them
// per CONTRACT.md (main.js section, steps 1–7). It owns NO business logic of its
// own — selection lives in engine.js, the drill in trainer.js, rendering in ui.js.
//
// Every callback that crosses a module boundary is wrapped so a thrown handler
// can never break a detection/animation/recognition loop; surfaced errors go to
// ui.showError. Browser globals are only touched inside functions, never at
// import time, so the pure modules stay node --check clean.
//
// Pure browser ES module — loaded via <script type="module" src="js/main.js">.

import { CONFIG } from './config.js';
import {
  loadAppConfig,
  loadLanguages,
  loadSentences,
} from './data.js';
import {
  getProgress,
  saveProgress,
  getSetting,
  setSetting,
} from './store.js';
import {
  effectiveConfig,
  buildSession,
  recordResult,
  statsSummary,
  finishSessionStats,
} from './engine.js';
import { createAudio } from './audio.js';
import { startCamera } from './camera.js';
import { createGestureEngine } from './gestures.js';
import { createSpeechMatcher } from './speech.js';
import { createTrainer } from './trainer.js';
import { createUI } from './ui.js';

// ---- module-scoped handles (filled during boot) ----------------------------
let ui = null;
let trainer = null;
let gestures = null;
let speech = null;
let audio = null;

let rawConfig = null;       // effective raw config object from /config.json
let languages = [];         // [{code,label,flag}]
let selectedLang = null;    // current language code
let apiKey = '';            // optional ElevenLabs key (pasted or stored)

let cfg = null;             // effectiveConfig(rawConfig, selectedLang)
let sentencesJson = null;   // {groups:[...]} for selectedLang
let progress = null;        // localStorage-backed progress for selectedLang
let session = null;         // engine.buildSession(...)

let booted = false;         // a trainer session is live
let mirror = !!(CONFIG && CONFIG.mirror);
let sessionStartMs = 0;     // for finishSessionStats timing
let sessionDoneCount = 0;   // sentences completed (pass+skip) this session

// ---- tiny safe-call helpers -------------------------------------------------
function safe(fn) {
  try { return fn(); } catch (e) { surface(e); }
}
function safeQuiet(fn) {
  try { return fn(); } catch (_) { /* swallow inside hot loops */ }
}
function surface(e) {
  const msg = e && e.message ? e.message : String(e);
  try {
    if (ui && typeof ui.showError === 'function') ui.showError(msg);
    else console.error('[ENGLESY]', msg);
  } catch (_) {
    console.error('[ENGLESY]', msg);
  }
}

// ===========================================================================
// 1) DOMContentLoaded → build UI, load config + languages, build lang picker,
//    bind controls, register the service worker.
// ===========================================================================
document.addEventListener('DOMContentLoaded', () => {
  bootstrap();
});

async function bootstrap() {
  // Create UI first so we always have a surface for errors and the lang picker.
  try {
    ui = createUI({ config: CONFIG });
  } catch (e) {
    console.error('[ENGLESY] createUI failed:', e);
    return; // nothing else can run without a UI
  }

  // Bind controls up front so they exist before any camera prompt.
  safe(() => ui.bindControls({
    onStart: onStart,
    onReplay: onReplay,
    onSkip: onSkip,
    onToggleStrict: onToggleStrict,
    onSwapHands: onSwapHands,
    onApiKey: onApiKey,
    onPickLang: onPickLang,
  }));

  // Restore stored prefs.
  apiKey = safe(() => getSetting('apiKey', '')) || '';
  const storedStrict = safe(() => getSetting('strictHand', CONFIG.strictHand));
  const storedLang = safe(() => getSetting('lang', null));
  // Restore the persisted hand-mirroring choice (sticks across sessions).
  mirror = !!safe(() => getSetting('mirror', CONFIG.mirror));
  safe(() => { if (ui && ui.setSwapActive) ui.setSwapActive(mirror); });

  // Load app config + language list.
  try {
    rawConfig = await loadAppConfig();
  } catch (e) {
    surface(e);
    rawConfig = null;
  }
  try {
    languages = await loadLanguages();
  } catch (e) {
    surface(e);
    languages = [];
  }

  // Choose the selected language: stored → activeLanguage → first available.
  const active = rawConfig && rawConfig.activeLanguage;
  const codes = languages.map((l) => l && l.code).filter(Boolean);
  selectedLang =
    (storedLang && codes.includes(storedLang) && storedLang) ||
    (active && codes.includes(active) && active) ||
    codes[0] ||
    storedLang ||
    active ||
    'en';

  // Scheduler / manual-launch override: ?lang=<code>&auto=1 (set by launcher.js).
  const urlParams = (typeof location !== 'undefined') ? new URLSearchParams(location.search || '') : null;
  const urlLang = urlParams && urlParams.get('lang');
  if (urlLang && codes.includes(urlLang)) {
    selectedLang = urlLang;
    safe(() => setSetting('lang', urlLang));
  }

  // Build the language picker (marks .active per selectedLang).
  safe(() => ui.buildLangPicker(languages, selectedLang, onPickLang));

  // Reflect the stored strict-hand preference in the toggle, if the UI exposes it.
  if (typeof storedStrict === 'boolean') {
    safeQuiet(() => {
      const t = ui.els && ui.els.strictToggle;
      if (t && 'checked' in t) t.checked = storedStrict;
    });
  }

  // Register the service worker (PWA / offline). Non-blocking, best-effort.
  registerServiceWorker();

  // Auto-start the session when opened by the scheduler / manual launcher (?auto=1):
  // replays the Start button so the landing → trainer transition + timer run normally.
  if (urlParams && urlParams.get('auto') === '1') {
    setTimeout(() => safeQuiet(() => {
      const b = ui.els && ui.els.startBtn;
      if (b && typeof b.click === 'function') b.click();
    }), 350);
  }
}

function onPickLang(code) {
  if (!code) return;
  selectedLang = code;
  safe(() => setSetting('lang', code));
  safe(() => ui.buildLangPicker(languages, selectedLang, onPickLang));
}

// ===========================================================================
// 2) START → load sentences+progress, build session, audio, trainer,
//    render stats, hide landing / show trainer. Then 3) camera, 4) speech.
// ===========================================================================
async function onStart() {
  if (booted) return; // guard double-start
  try {
    // Pull the optional pasted key from the field (falls back to stored).
    const pasted = safe(() => {
      const el = ui.els && ui.els.elevenKey;
      return el && typeof el.value === 'string' ? el.value.trim() : '';
    });
    if (pasted) {
      apiKey = pasted;
      safe(() => setSetting('apiKey', apiKey));
    }

    safe(() => ui.setStatus('Загружаю предложения…'));

    // --- Load data for the selected language. ---
    sentencesJson = await loadSentences(selectedLang);
    progress = await getProgress(selectedLang); // seeds from progress.json on first use

    // --- Effective config + session (the crown-jewel SRS selection). ---
    cfg = effectiveConfig(rawConfig, selectedLang);
    if (apiKey && cfg && cfg.tts) {
      // Make the key available to engine-derived config consumers (audio reads it too).
      cfg.tts = Object.assign({}, cfg.tts, { apiKey });
    }
    session = buildSession(sentencesJson, cfg, progress, Date.now());

    if (!session || !Array.isArray(session.sentences) || session.sentences.length === 0) {
      safe(() => ui.setStatus('На сегодня всё повторено — отличная работа!'));
      // Still show stats so the user sees their standing.
      safe(() => ui.renderStats(statsSummary(sentencesJson, cfg, progress, regFor(selectedLang), Date.now())));
      return;
    }

    // --- Audio (cache-first mp3 → Web Speech / ElevenLabs fallback). ---
    audio = createAudio(rawConfig, selectedLang);
    if (apiKey) safe(() => audio.setApiKey(apiKey));

    // --- Trainer state machine over the built session. ---
    trainer = createTrainer({
      session,
      cfg,
      onState: (state) => safeQuiet(() => ui.renderState(state)),
      onReveal: onReveal,
      onPhraseRepeatStart: onPhraseRepeatStart,
      onComplete: onSentenceComplete,
      onAllComplete: onAllComplete,
    });

    // Apply stored strict-hand preference before the drill starts.
    const storedStrict = safe(() => getSetting('strictHand', CONFIG.strictHand));
    if (typeof storedStrict === 'boolean') safe(() => trainer.setStrictHand(storedStrict));

    // --- Initial stats + view swap. ---
    safe(() => ui.renderStats(statsSummary(sentencesJson, cfg, progress, regFor(selectedLang), Date.now())));
    safe(() => ui.reset());            // clear any previous done/celebrate state
    safe(() => showTrainerView());     // hide landing, show trainer
    safe(() => ui.setStatus('Готовлю камеру…'));

    booted = true;
    sessionStartMs = nowMs();
    sessionDoneCount = 0;

    // Kick the drill so the first sentence/word reveals immediately
    // (works on keyboard even if camera/mic never come up).
    safe(() => trainer.start());

    // 3) Camera + gestures — graceful on any failure.
    await setupCameraAndGestures();

    // 4) Speech — voice word highlighting + repeat counting.
    setupSpeech();

    safe(() => ui.setStatus('Поехали! Показывай жесты и проговаривай слова.'));
  } catch (e) {
    booted = false;
    surface(e);
    // Leave the user on whatever view we reached; landing controls still work.
  }
}

// ---- 3) camera + gesture engine --------------------------------------------
async function setupCameraAndGestures() {
  const video = document.getElementById('video');
  if (!video) {
    safe(() => ui.setCamStatus('Камера недоступна — играй на клавишах ←/→'));
    return;
  }
  try {
    safe(() => ui.setCamStatus('Запрашиваю камеру…'));
    await startCamera(video);
    safe(() => ui.setCamStatus('Загружаю модель жестов…'));

    gestures = await createGestureEngine({
      videoEl: video,
      onResult: onGestureResult,
      onStatus: (msg) => safeQuiet(() => ui.setCamStatus(msg)),
    });

    safeQuiet(() => { if (gestures && gestures.setMirror) gestures.setMirror(mirror); });
    safe(() => gestures.start());
  } catch (e) {
    // No camera / no MediaPipe / permission denied → keyboard drill continues.
    gestures = null;
    // Surface the SPECIFIC reason (camera.js maps NotAllowedError/NotReadableError/
    // NotFoundError to a clear message) so the user knows exactly what to fix.
    const name = (e && e.name) ? `[${e.name}] ` : '';
    const msg = (e && e.message) ? e.message : String(e);
    safe(() => ui.setCamStatus(`${name}${msg}`));
    console.warn('[ENGLESY] camera/gestures unavailable:', e && e.name, msg);
  }
}

function onGestureResult(r) {
  // Hot loop — never let a render or detection throw escape.
  safeQuiet(() => {
    const st = trainer && trainer.getState ? trainer.getState() : null;
    if (r) {
      ui.setMeter({
        gesture: r.gesture,
        score: r.score,
        hand: r.hand,
        expected: st ? st.expected : null,
        progress: st ? st.gestureProgress : 0,
      });
      ui.drawLandmarks(r.landmarks, document.getElementById('video'));
    } else {
      ui.setMeter({
        gesture: null,
        score: 0,
        hand: null,
        expected: st ? st.expected : null,
        progress: 0,
      });
      ui.drawLandmarks(null, document.getElementById('video'));
    }
    // Always feed the detection (null = no hand) so "release" is registered — this
    // re-arms the repeat-phase fist counter and resets any in-progress word hold.
    if (trainer) trainer.handleDetection(r);
  });
}

// ---- 4) speech matcher ------------------------------------------------------
function setupSpeech() {
  try {
    speech = createSpeechMatcher({
      onWordMatch: (i) => safeQuiet(() => { if (trainer) trainer.notifyWordSpoken(i); }),
      // Live transcript = "user is speaking" — feeds the repeat-phase silence debounce so
      // the final sentence isn't cut off mid-word.
      onTranscript: () => safeQuiet(() => { if (trainer) trainer.notifySpeechActivity(); }),
      onStatus: (msg) => safeQuiet(() => { if (msg) ui.setStatus(msg); }),
    });
    // If we already revealed the first word before speech existed, prime it.
    safeQuiet(() => {
      if (!speech || !trainer) return;
      const st = trainer.getState();
      if (st && st.phase === 'words' && Array.isArray(st.words)) {
        speech.startForTarget(st.words.slice(0, st.revealedCount || 1));
      } else if (st && st.phase === 'repeat' && st.fullText) {
        speech.startForPhrase(st.fullText, () => safeQuiet(() => trainer.notifyPhraseSpoken()));
      }
    });
  } catch (e) {
    speech = null;
    console.warn('[ENGLESY] speech unavailable:', e && e.message ? e.message : e);
  }
}

// ===========================================================================
// Trainer callbacks
// ===========================================================================

// onReveal(word, idx, fullText, isFirst): on the FIRST word of a sentence speak the
// whole sentence once (premium ElevenLabs voice) so you have a model to imitate; then
// stay SILENT as you reveal words — the app listens to you, it must never echo each
// word over your own speaking (especially not with the robotic browser voice).
function onReveal(word, idx, fullText, isFirst) {
  // Audio: the whole sentence, once, only at the very start. Never per-word.
  safeQuiet(() => {
    if (!audio) return;
    if (isFirst || idx === 0) {
      if (fullText) audio.speakSentence(fullText);
    }
  });
  // Speech: listen for the revealed prefix so spoken words highlight green.
  safeQuiet(() => {
    if (!speech || !trainer) return;
    const st = trainer.getState();
    if (st && Array.isArray(st.words)) {
      speech.startForTarget(st.words.slice(0, st.revealedCount || (idx + 1)));
    }
  });
}

// onPhraseRepeatStart(fullText): enter repeat phase — listen continuously and
// count each spoken repetition.
function onPhraseRepeatStart(fullText) {
  safeQuiet(() => {
    if (!speech) return;
    speech.startForPhrase(fullText, () => safeQuiet(() => { if (trainer) trainer.notifyPhraseSpoken(); }));
  });
}

// onComplete(id, grade): record the SRS result, persist, refresh stats.
function onSentenceComplete(id, grade) {
  sessionDoneCount += 1;
  safe(() => {
    progress = recordResult(progress, cfg, id, grade, Date.now());
    saveProgress(selectedLang, progress);
    ui.renderStats(statsSummary(sentencesJson, cfg, progress, regFor(selectedLang), Date.now()));
  });
}

// onAllComplete(): finalize session timing, persist, show the done screen.
function onAllComplete() {
  booted = false;
  // Stop hot subsystems so they don't keep firing on the done screen.
  safeQuiet(() => { if (gestures && gestures.stop) gestures.stop(); });
  safeQuiet(() => { if (speech && speech.stop) speech.stop(); });
  safeQuiet(() => { if (audio && audio.stop) audio.stop(); });

  const durationMs = Math.max(0, nowMs() - sessionStartMs);
  const count = sessionDoneCount;

  safe(() => {
    progress = finishSessionStats(progress, durationMs, count, Date.now());
    saveProgress(selectedLang, progress);
  });

  const stats = safe(() => statsSummary(sentencesJson, cfg, progress, regFor(selectedLang), Date.now()));
  safe(() => ui.renderStats(stats));
  safe(() => ui.showDone(stats, {
    durationMs,
    count,
    lang: selectedLang,
    onAgain: startAnotherSession,   // "ЕЩЁ СЕССИЯ" → build a fresh session in place
    onHome: backToLanding,          // "НА ГЛАВНУЮ" → return to the landing overlay
  }));
}

// Restart: clear the done screen and run a fresh session for the same language
// (re-uses onStart, which rebuilds session/audio/trainer and re-renders stats).
function startAnotherSession() {
  safe(() => ui.reset());          // clears #done + transient state, restores #controls
  booted = false;                  // allow onStart to proceed
  trainer = null;
  onStart();
}

// ===========================================================================
// 6) Keyboard fallback / shortcuts
// ===========================================================================
document.addEventListener('keydown', (e) => {
  // Don't hijack typing in the ElevenLabs key field or any input/textarea.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    // Allow Esc to still work from a field.
    if (e.key !== 'Escape') return;
  }

  // Esc → back to landing (works whether or not a session is live).
  if (e.key === 'Escape') {
    e.preventDefault();
    backToLanding();
    return;
  }

  if (!booted || !trainer) return;

  const st = safeQuiet(() => trainer.getState()) || {};

  // During the repeat phase, ANY key counts a repetition (except the handled ones below).
  if (st.phase === 'repeat') {
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onReplay(); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); onSkip(); return; }
    if (e.key === 'Escape') return; // already handled above
    e.preventDefault();
    safeQuiet(() => trainer.tickRepeat());
    return;
  }

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      safeQuiet(() => trainer.pressDirection('left'));
      break;
    case 'ArrowRight':
      e.preventDefault();
      safeQuiet(() => trainer.pressDirection('right'));
      break;
    case ' ': // Space → advance (no-hit)
    case 'Spacebar':
      e.preventDefault();
      safeQuiet(() => {
        if (typeof trainer.advance === 'function') trainer.advance();
        else if (typeof trainer.advanceWord === 'function') trainer.advanceWord(false);
      });
      break;
    case 'r':
    case 'R':
      e.preventDefault();
      onReplay();
      break;
    case 's':
    case 'S':
      e.preventDefault();
      onSkip();
      break;
    default:
      // Ctrl-only chords (no specific key) → left/right per which Control side.
      if (e.code === 'ControlLeft') {
        e.preventDefault();
        safeQuiet(() => trainer.pressDirection('left'));
      } else if (e.code === 'ControlRight') {
        e.preventDefault();
        safeQuiet(() => trainer.pressDirection('right'));
      }
      break;
  }
});

// ===========================================================================
// 7) Control handlers
// ===========================================================================
function onReplay() {
  safe(() => {
    if (!audio || !trainer) return;
    const st = trainer.getState();
    if (st && st.fullText) audio.speakSentence(st.fullText);
  });
}

function onSkip() {
  safe(() => { if (trainer) trainer.skip(); });
}

function onToggleStrict(b) {
  const v = !!b;
  safe(() => setSetting('strictHand', v));
  safe(() => { if (trainer) trainer.setStrictHand(v); });
}

// Flip ONLY the Left/Right hand mapping (not the selfie video) and remember it.
function onSwapHands() {
  safe(() => {
    mirror = !mirror;
    if (gestures && gestures.setMirror) gestures.setMirror(mirror);
    setSetting('mirror', mirror);
    if (ui && ui.setSwapActive) ui.setSwapActive(mirror);
  });
}

function onApiKey(k) {
  apiKey = (k || '').trim();
  safe(() => setSetting('apiKey', apiKey));
  safe(() => { if (audio && audio.setApiKey) audio.setApiKey(apiKey); });
}

// ===========================================================================
// View transitions
// ===========================================================================
function showTrainerView() {
  const overlay = document.getElementById('start-overlay');
  const trainerView = document.getElementById('trainer-view');
  if (overlay) overlay.classList.add('hidden');
  if (trainerView) trainerView.classList.remove('hidden');
}

function backToLanding() {
  // Tear down a live session; keep progress (already persisted per sentence).
  safeQuiet(() => { if (gestures && gestures.stop) gestures.stop(); });
  safeQuiet(() => { if (speech && speech.stop) speech.stop(); });
  safeQuiet(() => { if (audio && audio.stop) audio.stop(); });
  booted = false;
  trainer = null;

  const overlay = document.getElementById('start-overlay');
  const trainerView = document.getElementById('trainer-view');
  if (trainerView) trainerView.classList.add('hidden');
  if (overlay) overlay.classList.remove('hidden');
  safeQuiet(() => ui.reset());
}

// ===========================================================================
// Helpers
// ===========================================================================

// Registration registry entry {code,label,flag} for statsSummary.
function regFor(code) {
  const found = languages.find((l) => l && l.code === code);
  if (found) return { code: found.code, label: found.label, flag: found.flag };
  return { code, label: code ? code.toUpperCase() : '', flag: '' };
}

function nowMs() {
  try {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
  } catch (_) { /* ignore */ }
  return Date.now();
}

// During active development the service worker caused stale code to be served (a fix
// would land on disk but the browser kept the cached old JS). We intentionally do NOT
// register it now, and we actively UNREGISTER any previously-installed SW + clear its
// caches, so every reload always loads the latest code. (Re-enable a real offline SW
// once the app stabilizes.)
function registerServiceWorker() {
  safeQuiet(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => { try { r.unregister(); } catch (_) { /* ignore */ } });
    }).catch(() => { /* ignore */ });
    if (typeof caches !== 'undefined' && caches.keys) {
      caches.keys().then((keys) => keys.forEach((k) => { try { caches.delete(k); } catch (_) { /* ignore */ } }))
        .catch(() => { /* ignore */ });
    }
  });
}
