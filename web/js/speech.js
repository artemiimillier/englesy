// js/speech.js
// Web Speech matcher with TWO modes, sharing one SpeechRecognition instance.
//
//   Mode A — words   (startForTarget(words)):
//     Ordered word-pointer highlight. Walk a pointer through the target words; when
//     the next expected target word appears among the spoken tokens, fire
//     onWordMatch(pointerIndex) ONCE and advance the pointer.
//
//   Mode B — phrase  (startForPhrase(fullText, onRep)):
//     Continuously listen. Each time the *latest utterance window* contains ≥70% of the
//     target phrase's normalized words (in roughly the right order), fire onRep() ONCE
//     per utterance, then reset so the NEXT spoken repetition can fire again.
//
// Both modes auto-restart recognition (continuous) across browser timeouts. Switching
// modes always calls reset(). lang = 'en-US'.
//
// Normalize: lowercase → strip punctuation → collapse apostrophes (don't → dont).
//
// Graceful stub when webkitSpeechRecognition is absent:
//   { supported:false, startForTarget(){}, startForPhrase(){}, stop(){}, reset(){} }.

export function createSpeechMatcher({ onWordMatch, onTranscript, onStatus } = {}) {
  const safe = (fn, ...args) => {
    try { if (typeof fn === 'function') fn(...args); } catch (_) { /* swallow callback errors */ }
  };

  const SpeechRecognitionImpl =
    (typeof window !== 'undefined') &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  if (!SpeechRecognitionImpl) {
    safe(onStatus, 'Распознавание речи не поддерживается этим браузером');
    return {
      supported: false,
      startForTarget() {},
      startForPhrase() {},
      stop() {},
      reset() {},
    };
  }

  // --- constants ------------------------------------------------------------
  const MODE_IDLE = 'idle';
  const MODE_WORDS = 'words';
  const MODE_PHRASE = 'phrase';
  const PHRASE_MATCH_RATIO = 0.7;   // ≥70% of target words present → one rep
  // A SpeechRecognition "result" with isFinal marks the end of an utterance; we use
  // that boundary to allow the next phrase rep to fire. Interim results are evaluated
  // too so we can fire promptly, but each utterance only fires once.

  // --- internal state -------------------------------------------------------
  let recognition = null;
  let active = false;          // are we (re)started right now
  let restarting = false;      // guard against double restart races
  let mode = MODE_IDLE;        // 'idle' | 'words' | 'phrase'

  // words mode
  let targetWords = [];        // normalized target word list
  let pointer = 0;             // index of next expected target word
  const matched = new Set();   // word indices already fired (each once)

  // phrase mode
  let phraseWords = [];        // normalized words of the target phrase
  let phraseNeeded = 0;        // ceil(PHRASE_MATCH_RATIO * phraseWords.length)
  let onRepCb = null;          // callback fired once per matching utterance
  // Per-utterance firing is keyed by the result index of the SpeechRecognition entry
  // that currently represents the live utterance. Once we fire for that index we mark
  // it, and only allow the next fire when a *new* utterance index appears (i.e. the
  // previous one became final and a fresh one started).
  let firedResultIndex = -1;   // result index we already fired onRep for (-1 = none)
  // When phrase mode starts, the utterance the user is still finishing (the tail of their
  // word-by-word reading) must NOT count as rep #1. We capture that utterance's index on the
  // first result and ignore it; only a NEW utterance started afterwards can be a repetition.
  let phrasePrimed = false;
  let ignoreUtteranceIndex = -1;

  // Normalize a piece of text → array of lowercase tokens, punctuation stripped,
  // apostrophes collapsed (so "don't" → "dont").
  function normalize(text) {
    if (text === null || text === undefined) return [];
    return String(text)
      .toLowerCase()
      .replace(/['’`]/g, '')          // collapse apostrophes: don't -> dont
      .replace(/[^a-z0-9\s]/g, ' ')   // strip remaining punctuation
      .split(/\s+/)
      .filter(Boolean);
  }

  // Count how many of `needleWords` appear in `hayTokens` in roughly the same order.
  // Greedy ordered scan: advances a pointer through hayTokens, so each haystack token
  // is consumed once and order is respected (a target word out of order won't be
  // double-counted). Returns the count of in-order matches.
  function orderedMatchCount(needleWords, hayTokens) {
    if (!needleWords.length || !hayTokens.length) return 0;
    let count = 0;
    let h = 0;
    for (let n = 0; n < needleWords.length; n++) {
      const want = needleWords[n];
      // find `want` in hayTokens at or after position h
      let found = -1;
      for (let j = h; j < hayTokens.length; j++) {
        if (hayTokens[j] === want) { found = j; break; }
      }
      if (found !== -1) {
        count++;
        h = found + 1;
      }
      // if not found in remaining window, skip this needle word (allows minor gaps)
    }
    return count;
  }

  function buildRecognition() {
    const rec = new SpeechRecognitionImpl();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    if ('maxAlternatives' in rec) rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      try {
        if (mode === MODE_WORDS) {
          handleWordsResult(event);
        } else if (mode === MODE_PHRASE) {
          handlePhraseResult(event);
        } else {
          // idle: still surface the live transcript if anyone is listening
          safe(onTranscript, latestTranscript(event));
        }
      } catch (err) {
        safe(onStatus, 'Ошибка обработки речи: ' + (err && err.message ? err.message : err));
      }
    };

    rec.onerror = (event) => {
      const code = event && event.error ? event.error : 'unknown';
      // 'no-speech' / 'aborted' are benign; report quietly and let onend restart.
      safe(onStatus, 'Речь: ' + code);
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        // Permission denied — stop trying to restart.
        active = false;
      }
    };

    rec.onend = () => {
      // Auto-restart while active so recognition stays continuous across browser timeouts.
      if (active && !restarting) {
        restarting = true;
        try {
          rec.start();
          restarting = false;
        } catch (err) {
          // Some engines throw if start() called too soon after end; retry shortly.
          setTimeout(() => {
            if (active) {
              try { rec.start(); } catch (_) { /* give up silently */ }
            }
            restarting = false;
          }, 250);
        }
      }
    };

    return rec;
  }

  // Build the full live transcript string from an event (for onTranscript).
  function latestTranscript(event) {
    let latest = '';
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0] && result[0].transcript ? result[0].transcript : '';
      latest += transcript + ' ';
    }
    return latest.trim();
  }

  // --- WORDS mode -----------------------------------------------------------
  function handleWordsResult(event) {
    let latest = '';
    const tokens = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0] && result[0].transcript ? result[0].transcript : '';
      latest += transcript + ' ';
      for (const tok of normalize(transcript)) tokens.push(tok);
    }

    // Walk the pointer in order: when the next expected target word appears among the
    // spoken tokens, fire onWordMatch(pointer) once and advance. Each index fires once.
    if (targetWords.length) {
      let progressed = true;
      while (progressed && pointer < targetWords.length) {
        progressed = false;
        const expected = targetWords[pointer];
        if (expected && tokens.includes(expected)) {
          if (!matched.has(pointer)) {
            matched.add(pointer);
            safe(onWordMatch, pointer);
          }
          pointer++;
          progressed = true;
        }
      }
    }

    safe(onTranscript, latest.trim());
  }

  // --- PHRASE mode ----------------------------------------------------------
  function handlePhraseResult(event) {
    if (!phraseWords.length) {
      safe(onTranscript, latestTranscript(event));
      return;
    }

    // Evaluate the CURRENT live utterance window. We take the last result entry as the
    // active utterance; if it's interim we can still fire (prompt feedback), and we key
    // the "fired once" guard on that result's index so each spoken rep fires exactly once.
    const n = event.results.length;
    if (n === 0) {
      safe(onTranscript, '');
      return;
    }

    const liveIndex = n - 1;
    const liveResult = event.results[liveIndex];
    const liveTranscript = (liveResult && liveResult[0] && liveResult[0].transcript) || '';
    const liveTokens = normalize(liveTranscript);

    safe(onTranscript, liveTranscript.trim());

    // First result after entering phrase mode: the live utterance is the tail of the user's
    // word-by-word reading. Mark it so it can never be counted as a repetition.
    if (!phrasePrimed) {
      phrasePrimed = true;
      ignoreUtteranceIndex = liveIndex;
    }
    if (liveIndex === ignoreUtteranceIndex) return; // carried-over reading → not a rep

    // A brand-new utterance index means the previous rep is finished → allow firing again.
    // (Also resets if the engine ever rewinds the index, which shouldn't happen.)
    if (liveIndex !== firedResultIndex) {
      const hits = orderedMatchCount(phraseWords, liveTokens);
      if (hits >= phraseNeeded) {
        firedResultIndex = liveIndex;   // mark this utterance as fired
        safe(onRepCb);
      }
    }
  }

  function ensureRecognition() {
    if (!recognition) recognition = buildRecognition();
    return recognition;
  }

  // Start (or restart) the shared recognition instance.
  function startRecognition() {
    active = true;
    const rec = ensureRecognition();
    try {
      rec.start();
    } catch (err) {
      // start() throws "InvalidStateError" if already started — abort then restart.
      try { rec.abort(); } catch (_) { /* ignore */ }
      setTimeout(() => {
        if (active) {
          try { rec.start(); } catch (_) { /* ignore */ }
        }
      }, 200);
    }
  }

  // Reset ALL per-rep / per-target state for both modes.
  function reset() {
    pointer = 0;
    matched.clear();
    firedResultIndex = -1;
    phrasePrimed = false;
    ignoreUtteranceIndex = -1;
  }

  // --- public: WORDS mode ---------------------------------------------------
  function startForTarget(words) {
    mode = MODE_WORDS;
    targetWords = Array.isArray(words)
      ? words.flatMap((w) => normalize(w))
      : normalize(words);
    // switching mode → drop phrase target so a stale handler never fires
    phraseWords = [];
    phraseNeeded = 0;
    onRepCb = null;
    reset();
    startRecognition();
  }

  // --- public: PHRASE mode --------------------------------------------------
  function startForPhrase(fullText, onRep) {
    mode = MODE_PHRASE;
    phraseWords = normalize(fullText);
    // ≥70% of the target words (at least 1 if there are any words at all)
    phraseNeeded = phraseWords.length
      ? Math.max(1, Math.ceil(PHRASE_MATCH_RATIO * phraseWords.length))
      : 0;
    onRepCb = typeof onRep === 'function' ? onRep : null;
    // switching mode → drop words target
    targetWords = [];
    reset();
    startRecognition();
  }

  function stop() {
    active = false;
    mode = MODE_IDLE;
    if (recognition) {
      try { recognition.stop(); } catch (_) { /* ignore */ }
      try { recognition.abort(); } catch (_) { /* ignore */ }
    }
  }

  return {
    supported: true,
    startForTarget,
    startForPhrase,
    stop,
    reset,
  };
}
