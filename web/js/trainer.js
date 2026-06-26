// js/trainer.js — ENGLESY two-phase drill state machine (words → repeat → done).
// PURE except setTimeout for the small post-complete delay and performance.now() for hold timing.
// No DOM/browser globals at import time; browser globals are read only inside functions.
//
// createTrainer({ session, cfg, onState, onReveal, onPhraseRepeatStart, onComplete, onAllComplete })
//   session = engine.buildSession(...) → { focus, sentences:[{id,text,translation,gloss,pattern,
//                                          tense,tenseLabel,level,isNew}] }
//
// Word index `wi` is 0-based. expected = expectedFor(wi):
//   even index → 👍 Thumb_Up / Left  (key 'left')
//   odd  index → ✊ Closed_Fist / Right (key 'right')
//
// Hold-to-confirm: a matching detection must persist for cfg.gesture.holdMs (default 320ms),
// measured via performance.now(); confidence must be ≥ cfg.gesture.confidenceThreshold (default 0.55);
// when cfg.strictHand is truthy the detected hand must equal the expected hand.

import { expectedFor, repeatExpected } from './config.js';

// ---- defaults (mirror config.js CONFIG so the trainer is robust to a thin cfg) ----
const DEFAULT_HOLD_MS = 320;
const DEFAULT_CONFIDENCE = 0.55;
const DEFAULT_REPEAT_TARGET = 10;
const COMPLETE_DELAY_MS = 600; // small breath after a graded completion
// After the FINAL repetition we don't jump to the next sentence immediately — we wait
// until the user has actually FINISHED speaking. Each speech-activity tick (re)starts the
// silence timer; once silent for SETTLE_SILENCE_MS we advance. SETTLE_MAX_MS is a safety
// ceiling so it never hangs if speech keeps coming (or recognition is unavailable).
const SETTLE_SILENCE_MS = 1300;
const SETTLE_MAX_MS = 7000;

// monotonic clock with graceful fallback (never reference perf at import time)
function nowMs() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_) { /* ignore */ }
  return Date.now();
}

// Split a sentence into display words. Keep this aligned with how gloss[] is built upstream:
// gloss entries map 1:1 to whitespace-separated tokens. We tolerate extra/missing gloss safely.
function splitWords(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

export function createTrainer(opts) {
  const o = opts || {};
  const session = o.session || { focus: null, sentences: [] };
  const cfg = o.cfg || {};

  // ---- safe callback wrappers: a thrown callback must never break the loop ----
  const noop = () => {};
  const wrap = (fn) => {
    if (typeof fn !== 'function') return noop;
    return function safeCb() {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        try {
          // surface but do not propagate
          if (typeof console !== 'undefined' && console && console.error) {
            console.error('[trainer] callback error:', err);
          }
        } catch (_) { /* ignore */ }
        return undefined;
      }
    };
  };

  const cbState = wrap(o.onState);
  const cbReveal = wrap(o.onReveal);
  const cbPhraseRepeatStart = wrap(o.onPhraseRepeatStart);
  const cbComplete = wrap(o.onComplete);
  const cbAllComplete = wrap(o.onAllComplete);

  const sentences = Array.isArray(session.sentences) ? session.sentences : [];

  // ---- config readouts (defensive: support thin raw cfg or full CONFIG-merged cfg) ----
  function holdMs() {
    const g = cfg.gesture;
    const v = g && typeof g.holdMs === 'number' ? g.holdMs : cfg.holdMs;
    return typeof v === 'number' && v >= 0 ? v : DEFAULT_HOLD_MS;
  }
  function confidenceThreshold() {
    const g = cfg.gesture;
    const v = g && typeof g.confidenceThreshold === 'number'
      ? g.confidenceThreshold
      : cfg.confidenceThreshold;
    return typeof v === 'number' ? v : DEFAULT_CONFIDENCE;
  }
  function repeatTargetFor() {
    const d = cfg.drill;
    const v = d && typeof d.repeatTarget === 'number' ? d.repeatTarget : cfg.repeatTarget;
    return (typeof v === 'number' && v > 0) ? v : DEFAULT_REPEAT_TARGET;
  }

  // strictHand is mutable at runtime via setStrictHand(); seed from cfg.
  let strictHand = (typeof cfg.strictHand === 'boolean') ? cfg.strictHand : true;

  // ---- mutable state ----
  const state = {
    si: 0,
    total: sentences.length,
    words: [],
    gloss: [],
    phon: [],
    wi: 0,
    revealedCount: 0,
    expected: expectedFor(0, 0),
    gestureProgress: 0,
    spokenMask: [],
    phase: 'words', // 'words' | 'repeat' | 'done'
    repeatCount: 0,
    repeatTarget: repeatTargetFor(),
    pattern: '',
    tense: '',
    tenseLabel: '',
    level: '',
    isNew: false,
    translation: '',
    fullText: '',
    lastDetected: null,   // { gesture, score, hand } last seen during words phase
    wrongFlash: 0,        // bumps each wrong press/detection so UI can animate a flash
    awaitingFinish: false, // last rep reached → waiting for the user to finish speaking
  };

  // ---- hold-to-confirm tracking (words + repeat phases) ----
  let holdStart = 0;      // performance.now() at which a matching hold began (0 = not holding)
  let holdActive = false;
  let completeTimer = null; // pending setTimeout id for the post-complete delay
  let allDoneFired = false;
  // Repeat phase: must release the fist between reps so one hold ≠ many reps.
  let repeatArmed = true;
  let lastTickAt = 0; // de-dups gesture + voice + key firing for the same physical rep
  const REPEAT_DEDUP_MS = 600;
  // After the final rep: silence-debounced advance (don't cut the user off mid-phrase).
  let settleTimer = null;
  let ceilingTimer = null;

  function clearHold() {
    holdActive = false;
    holdStart = 0;
    state.gestureProgress = 0;
  }

  function clearCompleteTimer() {
    if (completeTimer != null) {
      try { clearTimeout(completeTimer); } catch (_) { /* ignore */ }
      completeTimer = null;
    }
  }

  function clearSettle() {
    if (settleTimer != null) { try { clearTimeout(settleTimer); } catch (_) { /* ignore */ } settleTimer = null; }
    if (ceilingTimer != null) { try { clearTimeout(ceilingTimer); } catch (_) { /* ignore */ } ceilingTimer = null; }
    state.awaitingFinish = false;
  }

  function emit() {
    cbState(getState());
  }

  function currentSentence() {
    return sentences[state.si] || null;
  }

  function getState() {
    // shallow snapshot with copied arrays so consumers can't corrupt internal state
    return {
      si: state.si,
      total: state.total,
      words: state.words.slice(),
      gloss: state.gloss.slice(),
      phon: state.phon.slice(),
      wi: state.wi,
      revealedCount: state.revealedCount,
      expected: state.expected,
      gestureProgress: state.gestureProgress,
      spokenMask: state.spokenMask.slice(),
      phase: state.phase,
      repeatCount: state.repeatCount,
      repeatTarget: state.repeatTarget,
      pattern: state.pattern,
      tense: state.tense,
      tenseLabel: state.tenseLabel,
      level: state.level,
      isNew: state.isNew,
      translation: state.translation,
      fullText: state.fullText,
      awaitingFinish: state.awaitingFinish,
      lastDetected: state.lastDetected,
      wrongFlash: state.wrongFlash,
    };
  }

  // ---- lifecycle ----
  function start() {
    clearCompleteTimer();
    allDoneFired = false;
    state.si = 0;
    state.total = sentences.length;
    if (state.total === 0) {
      // nothing to drill — go straight to done
      state.phase = 'done';
      state.words = [];
      state.gloss = [];
      state.phon = [];
      state.wi = 0;
      state.revealedCount = 0;
      state.fullText = '';
      emit();
      fireAllComplete();
      return;
    }
    loadSentence();
  }

  function loadSentence() {
    clearHold();
    clearSettle();
    const s = currentSentence();
    if (!s) {
      // out of range — treat as all complete
      state.phase = 'done';
      emit();
      fireAllComplete();
      return;
    }

    const text = typeof s.text === 'string' ? s.text : '';
    const words = splitWords(text);
    const gloss = Array.isArray(s.gloss) ? s.gloss : [];
    const phon = words.map((_, i) => {
      const g = gloss[i];
      return (g && typeof g.p === 'string') ? g.p : '';
    });

    state.words = words;
    state.gloss = gloss;
    state.phon = phon;
    state.wi = 0;
    state.revealedCount = words.length > 0 ? 1 : 0;
    state.spokenMask = new Array(words.length).fill(false);
    state.phase = 'words';
    state.expected = expectedFor(0, state.si);
    state.gestureProgress = 0;
    state.repeatCount = 0;
    state.repeatTarget = repeatTargetFor();
    state.pattern = typeof s.pattern === 'string' ? s.pattern : '';
    state.tense = typeof s.tense === 'string' ? s.tense : '';
    state.tenseLabel = typeof s.tenseLabel === 'string' ? s.tenseLabel : '';
    state.level = typeof s.level === 'string' ? s.level : '';
    state.isNew = !!s.isNew;
    state.translation = typeof s.translation === 'string' ? s.translation : '';
    state.fullText = text;
    state.lastDetected = null;

    // Degenerate sentence (no words): jump straight to repeat phase so the drill never stalls.
    if (words.length === 0) {
      emit();
      enterRepeat();
      return;
    }

    emit();
    // onReveal(word, idx, fullText, isFirst)
    cbReveal(words[0], 0, text, true);
  }

  // ---- words phase: camera detection ----
  // detection = { gesture, score, hand }
  function handleDetection(detection) {
    if (state.phase !== 'words' && state.phase !== 'repeat') return;
    const d = detection || {};
    state.lastDetected = {
      gesture: d.gesture != null ? d.gesture : null,
      score: typeof d.score === 'number' ? d.score : 0,
      hand: d.hand != null ? d.hand : null,
    };

    const exp = state.expected || expectedFor(state.wi, state.si);
    const score = typeof d.score === 'number' ? d.score : 0;
    const gestureOk = d.gesture === exp.gesture;
    const scoreOk = score >= confidenceThreshold();
    const handOk = !strictHand || d.hand === exp.hand;
    const matches = gestureOk && scoreOk && handOk;

    // Repeat phase: the fist gesture (held, then released) drives each repetition.
    if (state.phase === 'repeat') { handleRepeatDetection(matches); return; }

    if (!matches) {
      // lost the match → reset hold. Only emit when something actually changed
      // (no per-frame re-render while idle / no hand).
      if (holdActive || state.gestureProgress !== 0) {
        clearHold();
        emit();
      }
      return;
    }

    const t = nowMs();
    const hm = holdMs();
    if (!holdActive) {
      holdActive = true;
      holdStart = t;
    }

    if (hm <= 0) {
      // no hold required — confirm immediately
      state.gestureProgress = 1;
      emit();
      advanceWord(true);
      return;
    }

    const elapsed = t - holdStart;
    let progress = elapsed / hm;
    if (progress < 0) progress = 0;
    if (progress >= 1) {
      state.gestureProgress = 1;
      // advanceWord clears hold + emits via reveal/repeat path
      advanceWord(true);
      return;
    }
    state.gestureProgress = progress;
    emit();
  }

  // ---- words phase: keyboard equivalent ----
  function pressDirection(dir) {
    if (state.phase !== 'words') return;
    const exp = state.expected || expectedFor(state.wi, state.si);
    if (dir === exp.key) {
      advanceWord(true);
    } else {
      // wrong direction → transient wrong flash, do not advance
      state.wrongFlash++;
      clearHold();
      emit();
    }
  }

  function advanceWord(hit) {
    if (state.phase !== 'words') return;
    clearHold();
    state.wi++;
    if (state.wi >= state.words.length) {
      enterRepeat();
      return;
    }
    state.revealedCount = state.wi + 1;
    state.expected = expectedFor(state.wi, state.si);
    state.gestureProgress = 0;
    emit();
    cbReveal(state.words[state.wi], state.wi, state.fullText, false);
  }

  // ---- voice: words phase highlight ----
  function notifyWordSpoken(i) {
    if (state.phase !== 'words') return;
    const idx = (typeof i === 'number') ? i : -1;
    if (idx < 0 || idx >= state.spokenMask.length) return;
    if (state.spokenMask[idx]) return; // already green; avoid redundant emit
    state.spokenMask[idx] = true;
    emit();
  }

  // ---- repeat phase ----
  function enterRepeat() {
    clearHold();
    clearSettle();
    state.phase = 'repeat';
    state.repeatCount = 0;
    state.repeatTarget = repeatTargetFor();
    // Whole repeat phase: show the FIST (hand alternates per sentence), say the full phrase.
    state.expected = repeatExpected(state.si);
    state.gestureProgress = 0;
    repeatArmed = true;
    lastTickAt = 0;
    emit();
    cbPhraseRepeatStart(state.fullText);
  }

  // Repeat phase: a held fist (then released) counts one repetition.
  function handleRepeatDetection(matches) {
    if (state.repeatCount >= state.repeatTarget) {
      if (holdActive || state.gestureProgress !== 0) { clearHold(); emit(); }
      return;
    }
    if (!matches) {
      // Released / no fist → reset hold and re-arm for the next rep.
      repeatArmed = true;
      if (holdActive || state.gestureProgress !== 0) { clearHold(); emit(); }
      return;
    }
    if (!repeatArmed) return; // still holding from a counted rep — wait for release
    const t = nowMs();
    const hm = holdMs();
    if (!holdActive) { holdActive = true; holdStart = t; }
    let progress = hm > 0 ? (t - holdStart) / hm : 1;
    if (progress < 0) progress = 0;
    if (progress >= 1) {
      state.gestureProgress = 1;
      repeatArmed = false;      // require a release before the next rep
      clearHold();
      tickRepeat();
      return;
    }
    state.gestureProgress = progress;
    emit();
  }

  function tickRepeat() {
    if (state.phase !== 'repeat') return;
    if (state.awaitingFinish) return;                    // target reached — no more counting
    if (state.repeatCount >= state.repeatTarget) return; // already at/over target
    const t = nowMs();
    if (t - lastTickAt < REPEAT_DEDUP_MS) return; // de-dup gesture + voice + key for one rep
    lastTickAt = t;
    state.repeatCount++;
    emit();
    if (state.repeatCount >= state.repeatTarget) {
      // All reps done — but DON'T jump to the next sentence yet. Wait until the user has
      // actually finished speaking (silence-debounced) so we never cut off the last phrase.
      enterSettling();
    }
  }

  // Final rep reached: hold here until the user stops talking (or the safety ceiling).
  function enterSettling() {
    clearSettle();
    clearHold();
    state.awaitingFinish = true;
    emit();
    settleTimer = setTimeout(finishNow, SETTLE_SILENCE_MS);
    ceilingTimer = setTimeout(finishNow, SETTLE_MAX_MS);
  }

  function finishNow() {
    clearSettle();
    if (state.phase === 'repeat') completeSentence('pass');
  }

  // Live speech activity (any interim transcript). While awaiting finish, each tick pushes
  // the advance later — so we only move on once the user has been silent for SETTLE_SILENCE_MS.
  function notifySpeechActivity() {
    if (!state.awaitingFinish) return;
    if (settleTimer != null) { try { clearTimeout(settleTimer); } catch (_) { /* ignore */ } }
    settleTimer = setTimeout(finishNow, SETTLE_SILENCE_MS);
  }

  // voice-driven repetition is equivalent to one tick
  function notifyPhraseSpoken() {
    tickRepeat();
  }

  function skip() {
    if (state.phase === 'done') return;
    clearCompleteTimer();
    clearSettle();
    completeSentence('skip');
  }

  function completeSentence(grade) {
    if (state.phase === 'done') return;
    const s = currentSentence();
    const id = s ? s.id : null;
    clearCompleteTimer();
    clearSettle();
    clearHold();

    // record this sentence's result before advancing
    if (id != null) {
      cbComplete(id, grade);
    }

    state.si++;
    if (state.si >= state.total) {
      state.phase = 'done';
      emit();
      fireAllComplete();
      return;
    }
    loadSentence();
  }

  function fireAllComplete() {
    if (allDoneFired) return;
    allDoneFired = true;
    cbAllComplete();
  }

  // ---- settings / control ----
  function setStrictHand(b) {
    strictHand = !!b;
    // re-evaluate any in-progress hold under the new policy on the next detection;
    // proactively drop the hold so the user gets immediate feedback.
    if (holdActive) {
      clearHold();
      if (state.phase === 'words') emit();
    }
  }

  function reset() {
    clearCompleteTimer();
    clearSettle();
    clearHold();
    allDoneFired = false;
    repeatArmed = true;
    lastTickAt = 0;
    state.si = 0;
    state.total = sentences.length;
    state.words = [];
    state.gloss = [];
    state.phon = [];
    state.wi = 0;
    state.revealedCount = 0;
    state.spokenMask = [];
    state.phase = 'words';
    state.expected = expectedFor(0, 0);
    state.gestureProgress = 0;
    state.repeatCount = 0;
    state.repeatTarget = repeatTargetFor();
    state.pattern = '';
    state.tense = '';
    state.tenseLabel = '';
    state.level = '';
    state.isNew = false;
    state.translation = '';
    state.fullText = '';
    state.lastDetected = null;
    state.wrongFlash = 0;
    emit();
  }

  return {
    start,
    loadSentence,
    handleDetection,
    pressDirection,
    advanceWord,
    notifyWordSpoken,
    enterRepeat,
    tickRepeat,
    notifyPhraseSpoken,
    notifySpeechActivity,
    skip,
    completeSentence,
    setStrictHand,
    reset,
    getState,
  };
}

export default createTrainer;
