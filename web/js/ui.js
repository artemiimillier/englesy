// js/ui.js
// ENGLESY web — render layer. NO business logic; this module only reflects state into the DOM.
//
// createUI({ config }) → {
//   buildLangPicker, renderState, setMeter, drawLandmarks, renderStats,
//   setStatus, setCamStatus, showError, celebrate, allDone, showDone, reset,
//   bindControls, wordHoverTip, els
// }
//
// Ids/classes match web/CONTRACT.md exactly so the integrator can wire the pieces together.
// Browser globals (document, requestAnimationFrame, performance, setTimeout) are touched only
// inside functions, never at import time. Every external callback is invoked through safeCall so a
// thrown handler can never break a render loop.

const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function createUI({ config } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const byId = (id) => (doc ? doc.getElementById(id) : null);

  // --- Element map (exact ids from the contract). Missing nodes are tolerated. ---
  const els = {
    // landing
    startOverlay: byId('start-overlay'),
    langPicker: byId('lang-picker'),
    startBtn: byId('start-btn'),
    elevenKey: byId('eleven-key'),
    // trainer view
    trainerView: byId('trainer-view'),
    // level bar
    levelbar: byId('levelbar'),
    langBadge: byId('lang-badge'),
    levelCur: byId('level-cur'),
    levelNext: byId('level-next'),
    levelFill: byId('level-fill'),
    levelInfo: byId('level-info'),
    progress: byId('progress'),
    sessionsToday: byId('sessions-today'),
    timer: byId('timer'),
    streak: byId('streak'),
    mic: byId('mic'),
    // camera panel
    camStatus: byId('cam-status'),
    camWrap: byId('cam-wrap'),
    video: byId('video'),
    overlayCanvas: byId('overlay-canvas'),
    camSideLeft: byId('cam-side-left'),
    camSideRight: byId('cam-side-right'),
    gestureHud: byId('gesture-hud'),
    expectedCue: byId('expected-cue'),
    handDetected: byId('hand-detected'),
    gestureMeter: byId('gesture-meter'),
    meterFill: byId('gesture-meter') ? byId('gesture-meter').querySelector('.meter-fill') : null,
    gesturePercent: byId('gesture-percent'),
    gestureName: byId('gesture-name'),
    hands: byId('hands'),
    handL: byId('handL'),
    handR: byId('handR'),
    legendTexts: doc ? Array.from(doc.querySelectorAll('.legend .legend-text')) : [],
    // phrase side
    pattern: byId('pattern'),
    phrasePanel: byId('phrase-panel'),
    phraseWords: byId('phrase-words'),
    phonetic: byId('phonetic'),
    phraseTranslation: byId('phrase-translation'),
    bigwordWrap: byId('bigword-wrap'),
    bigword: byId('bigword'),
    bigwordPhon: byId('bigword-phon'),
    statusLine: byId('status-line'),
    repeat: byId('repeat'),
    repeatTarget: byId('repeat-target'),
    repeatCue: byId('repeat-cue'),
    repeatPhrase: byId('repeat-phrase'),
    repeatPhon: byId('repeat-phon'),
    repeatDots: byId('repeat-dots'),
    // controls
    controls: byId('controls'),
    replayBtn: byId('replay-btn'),
    skipBtn: byId('skip-btn'),
    strictToggle: byId('strict-toggle'),
    swapBtn: byId('swap-btn'),
    // overlays
    done: byId('done'),
    celebrate: byId('celebrate'),
    errorToast: byId('error-toast'),
    wordtip: byId('wordtip'),
  };

  const cfg = config || {};
  let ctx = els.overlayCanvas && els.overlayCanvas.getContext
    ? els.overlayCanvas.getContext('2d')
    : null;

  // Local mirror of strict-hand purely for the toggle's own label/aria — the engine owns truth.
  let strict = cfg.strictHand !== undefined ? !!cfg.strictHand : true;
  let mirrored = cfg.mirror !== undefined ? !!cfg.mirror : true;

  let errorTimer = null;
  let celebrateTimer = null;
  let timerStart = 0;
  let timerRaf = 0;

  // For deciding when #phrase-words must be rebuilt (sentence changed).
  let lastWordsKey = '';
  // Gloss cache for hover tooltip lookups against the current sentence.
  let lastGloss = [];

  // ---------------------------------------------------------------- primitives
  function setText(el, text) {
    if (el) el.textContent = text == null ? '' : String(text);
  }
  function show(el) {
    if (!el) return;
    el.hidden = false;
    el.removeAttribute('hidden');
    el.classList.remove('hidden');
  }
  function hide(el) {
    if (!el) return;
    el.hidden = true;
    el.classList.add('hidden');
  }
  function clamp01(v) {
    if (typeof v !== 'number' || Number.isNaN(v)) return 0;
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
  function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch (e) {
      try { showError(e && e.message ? e.message : String(e)); } catch (_) { /* ignore */ }
      return undefined;
    }
  }
  function fmtClock(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function prettyGesture(g) {
    if (g === 'Thumb_Up') return '👍 Thumb Up';
    if (g === 'Closed_Fist') return '✊ Closed Fist';
    if (!g || g === 'None' || g === 'none') return '—';
    return String(g).replace(/_/g, ' ');
  }

  // ------------------------------------------------------------ buildLangPicker
  // langs: [{code,label,flag}]; selected: code; onPick(code) on click.
  function buildLangPicker(langs, selected, onPick) {
    const host = els.langPicker;
    if (!host || !doc) return;
    host.innerHTML = '';
    const list = Array.isArray(langs) ? langs : [];
    for (const lang of list) {
      if (!lang || !lang.code) continue;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-opt';
      btn.dataset.lang = lang.code;
      if (lang.code === selected) btn.classList.add('active');
      const flag = lang.flag ? `${lang.flag} ` : '';
      btn.textContent = `${flag}${lang.label || lang.code}`;
      btn.addEventListener('click', () => {
        for (const node of host.querySelectorAll('.lang-opt')) node.classList.remove('active');
        btn.classList.add('active');
        safeCall(onPick, lang.code);
      });
      host.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------- renderState
  function renderState(state) {
    if (!state) return;
    const phase = state.phase || 'words';

    renderPattern(state);
    renderProgress(state);
    renderTranslation(state);
    renderPhonetic(state);
    renderWords(state);
    renderBigword(state);
    renderHands(state);
    markExpectedSide(state.expected && state.expected.hand); // light the side immediately
    renderRepeat(state, phase);

    // Phase-driven panel visibility: words → bigword + hands; repeat → repeat block.
    if (phase === 'repeat') {
      hide(els.bigwordWrap);
      hide(els.bigword);
      if (els.hands) els.hands.style.display = 'none';
      show(els.repeat);
    } else if (phase === 'done') {
      hide(els.repeat);
    } else {
      show(els.bigwordWrap);
      show(els.bigword);
      if (els.hands) els.hands.style.display = 'flex';
      hide(els.repeat);
    }
  }

  function renderPattern(state) {
    if (!els.pattern) return;
    const tense = state.tenseLabel || state.tense || 'present';
    const level = state.level || '';
    let html = `<span class="tense-badge">${escapeHtml(level)}${level ? ' · ' : ''}${escapeHtml(tense)}</span>`;
    if (state.pattern) html += ` <span class="pattern-text">${escapeHtml(state.pattern)}</span>`;
    if (state.isNew) html += ` <span class="new-badge">НОВОЕ</span>`;
    els.pattern.innerHTML = html;
  }

  function renderProgress(state) {
    if (!els.progress) return;
    const si = typeof state.si === 'number' ? state.si : 0;
    const total = typeof state.total === 'number' ? state.total : 0;
    setText(els.progress, `${si + 1} / ${total}`);
  }

  function renderTranslation(state) {
    setText(els.phraseTranslation, state.translation || '');
  }

  function renderPhonetic(state) {
    if (!els.phonetic) return;
    const phon = Array.isArray(state.phon) ? state.phon.filter((x) => x) : [];
    if (phon.length) {
      setText(els.phonetic, phon.join(' '));
      show(els.phonetic);
    } else {
      setText(els.phonetic, '');
      hide(els.phonetic);
    }
  }

  function renderWords(state) {
    const host = els.phraseWords;
    if (!host || !doc) return;

    const words = Array.isArray(state.words) ? state.words : [];
    const gloss = Array.isArray(state.gloss) ? state.gloss : [];
    const phon = Array.isArray(state.phon) ? state.phon : [];
    const revealedCount = typeof state.revealedCount === 'number'
      ? state.revealedCount
      : (typeof state.wi === 'number' ? state.wi + 1 : 0);
    const wi = typeof state.wi === 'number' ? state.wi : revealedCount - 1;
    const spokenMask = Array.isArray(state.spokenMask) ? state.spokenMask : [];
    const phase = state.phase || 'words';

    lastGloss = gloss;

    // Rebuild structure only when the sentence itself changed.
    const key = words.join('␟');
    if (key !== lastWordsKey || host.childElementCount !== words.length) {
      lastWordsKey = key;
      host.innerHTML = '';
      words.forEach((w, i) => {
        const span = doc.createElement('span');
        span.className = 'word';
        span.dataset.i = String(i);
        span.dataset.text = w;

        // RU gloss floats above the word (gloss[i].t); inline, CSS handles hover reveal.
        const g = doc.createElement('span');
        g.className = 'word-gloss';
        g.textContent = (gloss[i] && gloss[i].t) || '';
        span.appendChild(g);

        // Visible word text lives in its own node so masking never erases the gloss.
        const txt = doc.createElement('span');
        txt.className = 'word-text';
        txt.textContent = w;
        span.appendChild(txt);

        host.appendChild(span);
      });
    }

    // Update per-word classes + masked/revealed text.
    Array.from(host.children).forEach((node, i) => {
      const isRevealed = i < revealedCount;
      const isCurrent = phase === 'words' && i === wi && isRevealed;
      const isSpoken = !!spokenMask[i];

      node.classList.toggle('hidden', !isRevealed);
      node.classList.toggle('masked', !isRevealed);
      node.classList.toggle('revealed', isRevealed);
      node.classList.toggle('current', isCurrent);
      node.classList.toggle('spoken', isSpoken);

      const gNode = node.querySelector('.word-gloss');
      if (gNode) {
        const t = (gloss[i] && gloss[i].t) || '';
        if (gNode.textContent !== t) gNode.textContent = t;
      }
      const txt = node.querySelector('.word-text');
      if (txt) {
        const raw = node.dataset.text || '';
        // Always show the real word — the FULL sentence stays readable. Upcoming words
        // are only dimmed via CSS (.word.hidden), never hidden behind • dots.
        if (txt.textContent !== raw) txt.textContent = raw;
        txt.removeAttribute('aria-hidden');
      }
      // store reading for potential subtitle alignment / tooltips
      const p = phon[i];
      if (p) node.dataset.phon = p; else node.removeAttribute('data-phon');
    });
  }

  function renderBigword(state) {
    if (!els.bigword) return;
    const words = Array.isArray(state.words) ? state.words : [];
    const phon = Array.isArray(state.phon) ? state.phon : [];
    const revealedCount = typeof state.revealedCount === 'number'
      ? state.revealedCount
      : (typeof state.wi === 'number' ? state.wi + 1 : 0);

    const chunk = words.slice(0, Math.max(0, revealedCount)).join(' ');
    if (els.bigword.textContent !== chunk) {
      setText(els.bigword, chunk);
      // pop animation on change
      els.bigword.classList.remove('pop');
      void els.bigword.offsetWidth;
      els.bigword.classList.add('pop');
    }
    setText(els.bigwordPhon, phon.slice(0, Math.max(0, revealedCount)).filter((x) => x).join(' '));

    // transient hit/wrong flashes driven by trainer state flags
    if (state.hitFlash) {
      els.bigword.classList.remove('hit');
      void els.bigword.offsetWidth;
      els.bigword.classList.add('hit');
    }
    if (state.wrongFlash) {
      els.bigword.classList.remove('wrong');
      void els.bigword.offsetWidth;
      els.bigword.classList.add('wrong');
    }
  }

  function renderHands(state) {
    const si = typeof state.si === 'number' ? state.si : 0;
    const sEven = si % 2 === 0;
    // Gesture↔hand pairing flips per sentence: even sentence → 👍 left / ✊ right; odd → swapped.
    const leftEmoji = sEven ? '👍' : '✊';
    const rightEmoji = sEven ? '✊' : '👍';
    const leftWord = sEven ? 'палец вверх' : 'кулак';
    const rightWord = sEven ? 'кулак' : 'палец вверх';
    setHand(els.handL, leftEmoji, `ЛЕВАЯ · ${leftWord}`);
    setHand(els.handR, rightEmoji, `ПРАВАЯ · ${rightWord}`);

    // Light the hand the trainer currently expects (works for words AND repeat phase).
    const expHand = state.expected && state.expected.hand;
    if (els.handL) els.handL.classList.toggle('lit', expHand === 'Left');
    if (els.handR) els.handR.classList.toggle('lit', expHand === 'Right');

    renderLegend(sEven);
  }

  function setHand(node, emoji, label) {
    if (!node) return;
    const e = node.querySelector('.hand-emoji');
    if (e && e.textContent !== emoji) e.textContent = emoji;
    const l = node.querySelector('.hand-label');
    if (l && l.textContent !== label) l.textContent = label;
  }

  // Legend reflects the CURRENT sentence's mapping (it alternates each sentence).
  function renderLegend(sEven) {
    if (!els.legendTexts || !els.legendTexts.length) return;
    const thumbHand = sEven ? 'левой' : 'правой';
    const fistHand = sEven ? 'правой' : 'левой';
    if (els.legendTexts[0]) els.legendTexts[0].innerHTML = `Палец вверх — <b>${thumbHand}</b> рукой`;
    if (els.legendTexts[1]) els.legendTexts[1].innerHTML = `Кулак — <b>${fistHand}</b> рукой · в повторе`;
  }

  function renderRepeat(state, phase) {
    if (!els.repeatDots) return;
    const target = typeof state.repeatTarget === 'number' && state.repeatTarget > 0
      ? state.repeatTarget
      : (cfg.drill && cfg.drill.repeatTarget) || 10;
    const count = typeof state.repeatCount === 'number' ? state.repeatCount : 0;

    setText(els.repeatTarget, target);
    if (els.repeatCue) {
      if (state.awaitingFinish) {
        // All reps done — waiting for the user to stop speaking before moving on.
        setText(els.repeatCue, '✓ Все повторения! Договаривай — перейдём дальше');
        els.repeatCue.classList.add('done');
      } else {
        // Fist hand alternates per sentence (even → right fist, odd → left fist).
        const si = typeof state.si === 'number' ? state.si : 0;
        const fist = (si % 2 === 0) ? 'ПРАВЫЙ' : 'ЛЕВЫЙ';
        setText(els.repeatCue, `✊ Показывай ${fist} кулак и говори фразу целиком`);
        els.repeatCue.classList.remove('done');
      }
    }
    if (els.repeatPhrase) setText(els.repeatPhrase, state.fullText || '');
    if (els.repeatPhon) {
      const phon = Array.isArray(state.phon) ? state.phon.filter((x) => x) : [];
      setText(els.repeatPhon, phon.length ? phon.join(' ') : '');
    }

    // Only (re)draw the dots while in the repeat phase or when count/target known.
    drawDots(target, count, phase === 'repeat');
  }

  function drawDots(target, count, active) {
    const host = els.repeatDots;
    if (!host || !doc) return;
    const T = Math.max(1, target | 0);

    // Rebuild only when target changes; otherwise just restyle.
    if (host.childElementCount !== T) {
      host.innerHTML = '';
      for (let i = 0; i < T; i++) {
        const d = doc.createElement('div');
        d.className = 'dot';
        const size = 26 + i * 3.2;       // each subsequent dot grows
        d.style.width = `${size}px`;
        d.style.height = `${size}px`;
        d.style.fontSize = `${12 + i * 0.7}px`;
        d.textContent = String(i + 1);
        host.appendChild(d);
      }
    }
    Array.from(host.children).forEach((node, i) => {
      const on = i < count;
      const current = active && i === count;
      node.classList.toggle('on', on);
      node.classList.toggle('current', current);
      if (on) {
        const hue = Math.round((i / Math.max(1, T - 1)) * 120); // 0 red → 120 green
        node.style.background = `hsl(${hue} 70% 50%)`;
        node.style.borderColor = `hsl(${hue} 70% 60%)`;
      } else {
        node.style.background = '';
        node.style.borderColor = '';
      }
    });
  }

  // ------------------------------------------------------------------- setMeter
  function setMeter(meter) {
    const m = meter || {};
    const score = typeof m.score === 'number' ? m.score : 0;
    const progress = typeof m.progress === 'number' ? m.progress : 0;
    const expected = m.expected || {};

    const pct = Math.round(clamp01(score) * 100);
    setText(els.gesturePercent, `${pct}%`);

    if (els.gestureName) setText(els.gestureName, prettyGesture(m.gesture));

    if (els.expectedCue && expected.label) setText(els.expectedCue, expected.label);

    // Width follows hold progress when holding, else raw confidence.
    const fillRatio = progress > 0 ? clamp01(progress) : clamp01(score);
    const widthPct = `${Math.round(fillRatio * 100)}%`;
    if (els.gestureMeter) {
      els.gestureMeter.style.setProperty('--p', widthPct);
      els.gestureMeter.classList.toggle('active', progress > 0);
    }
    if (els.meterFill) els.meterFill.style.width = widthPct;

    if (els.handDetected) {
      if (!m.hand) {
        setText(els.handDetected, 'Рука не найдена');
        els.handDetected.classList.remove('ok', 'bad');
        els.handDetected.removeAttribute('data-ok');
      } else {
        const handLabel = m.hand === 'Left' ? 'ЛЕВАЯ рука'
          : m.hand === 'Right' ? 'ПРАВАЯ рука'
          : String(m.hand);
        setText(els.handDetected, `Рука: ${handLabel}`);
        const ok = !expected.hand || m.hand === expected.hand;
        els.handDetected.classList.toggle('ok', ok);
        els.handDetected.classList.toggle('bad', !ok);
        els.handDetected.setAttribute('data-ok', ok ? 'true' : 'false');
      }
    }

    // Light the side of the VIDEO where your hand should be, right on the picture.
    updateCamSides(expected.hand, m.hand, progress);
  }

  // Light the expected side immediately on state change (before the camera loop runs).
  // Only toggles 'expected' — setMeter() owns the 'ok'/'bad' detection states.
  function markExpectedSide(hand) {
    if (els.camSideLeft) els.camSideLeft.classList.toggle('expected', hand === 'Left');
    if (els.camSideRight) els.camSideRight.classList.toggle('expected', hand === 'Right');
  }

  // The video is a selfie mirror, so the user's LEFT hand appears on the LEFT of the
  // screen → expected 'Left' lights the left side. Expected side glows green ("put your
  // hand here"); when the correct hand is detected and held it goes solid green; the
  // wrong hand lights its side red.
  function updateCamSides(expectedHand, detectedHand, progress) {
    const L = els.camSideLeft, R = els.camSideRight;
    if (!L && !R) return;
    [L, R].forEach((el) => { if (el) { el.classList.remove('expected', 'ok', 'bad'); el.style.removeProperty('--p'); } });
    const expEl = expectedHand === 'Left' ? L : expectedHand === 'Right' ? R : null;
    if (expEl) expEl.classList.add('expected');
    if (detectedHand) {
      if (detectedHand === expectedHand) {
        if (expEl && progress > 0) {
          expEl.classList.add('ok');
          expEl.style.setProperty('--p', String(clamp01(progress)));
        }
      } else {
        const wrongEl = detectedHand === 'Left' ? L : R;
        if (wrongEl) wrongEl.classList.add('bad');
      }
    }
  }

  // -------------------------------------------------------------- drawLandmarks
  // landmarks: [{x,y}] normalised 0..1 (relative to the displayed video frame).
  function drawLandmarks(landmarks, videoEl) {
    const canvas = els.overlayCanvas;
    if (!canvas) return;
    if (!ctx && canvas.getContext) ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.clientWidth || canvas.width || 0;
    const h = canvas.clientHeight || canvas.height || 0;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!Array.isArray(landmarks) || !landmarks.length) return;

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(142, 162, 255, 0.75)';
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) {
      const pa = landmarks[a];
      const pb = landmarks[b];
      if (!pa || !pb) continue;
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(179, 155, 255, 0.95)';
    for (const p of landmarks) {
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ------------------------------------------------------------------ renderStats
  // stats = engine.statsSummary(...) shape:
  // { language:{code,label,flag}, streak, learned, total, todayDone, todaySkipped,
  //   totalDone, totalSkipped, level:{current,next,pct,learned,total,remaining,daysToNext},
  //   timing:{avgSessionMs,avgPerSentenceMs,sessions} }
  function renderStats(stats) {
    if (!stats) return;

    if (els.langBadge && stats.language) {
      const flag = stats.language.flag || '';
      const label = stats.language.label || stats.language.code || '';
      setText(els.langBadge, `${flag} ${label}`.trim());
      els.langBadge.title = `Язык сессии: ${label}`;
    }

    if (els.streak) {
      setText(els.streak, `🔥 ${stats.streak || 0}`);
      const learned = stats.learned != null ? stats.learned : 0;
      const total = stats.total != null ? stats.total : 0;
      els.streak.title = `Серия: ${stats.streak || 0} дн. · Выучено ${learned} из ${total} · Сегодня: ${stats.todayDone || 0} сделано, ${stats.todaySkipped || 0} пропущено`;
    }

    // Sessions today: completed / scheduled-per-day.
    if (els.sessionsToday) {
      const did = stats.todaySessions || 0;
      const target = stats.targetSessions || 0;
      setText(els.sessionsToday, `📅 ${did}/${target}`);
      els.sessionsToday.title = `Занятий сегодня: ${did} из ${target} запланированных`;
      els.sessionsToday.classList.toggle('done', target > 0 && did >= target);
    }

    const L = stats.level;
    if (L) {
      setText(els.levelCur, L.current || '—');
      setText(els.levelNext, L.next || 'MAX');
      if (els.levelFill) els.levelFill.style.width = `${clamp01((L.pct || 0) / 100) * 100}%`;
      if (els.levelInfo) {
        setText(els.levelInfo, L.next
          ? `${L.learned}/${L.total} · до ${L.next} ~${L.daysToNext != null ? L.daysToNext : '∞'} дн.`
          : `${L.learned}/${L.total} · максимум`);
      }
    }
  }

  // -------------------------------------------------------------------- status
  function setStatus(msg) {
    setText(els.statusLine, msg);
  }
  function setCamStatus(msg) {
    setText(els.camStatus, msg);
  }

  // --------------------------------------------------------------------- error
  function showError(msg) {
    const toast = els.errorToast;
    const text = msg == null ? '' : String(msg);
    if (!toast) {
      setText(els.statusLine, text ? `Ошибка: ${text}` : '');
      return;
    }
    setText(toast, text);
    show(toast);
    toast.classList.add('show');
    if (errorTimer) { try { clearTimeout(errorTimer); } catch (_) { /* ignore */ } }
    errorTimer = setTimeout(() => {
      toast.classList.remove('show');
      hide(toast);
    }, 6000);
  }

  // ----------------------------------------------------------------- celebrate
  function celebrate() {
    const node = els.celebrate;
    if (!node) return;
    const title = node.querySelector('.celebrate-title');
    const sub = node.querySelector('.celebrate-sub');
    if (title) setText(title, 'Отлично!');
    if (sub) setText(sub, 'Фраза собрана целиком');
    show(node);
    node.classList.add('show');
    if (celebrateTimer) { try { clearTimeout(celebrateTimer); } catch (_) { /* ignore */ } }
    celebrateTimer = setTimeout(() => {
      node.classList.remove('show');
      hide(node);
    }, 1800);
  }

  function allDone() {
    const node = els.celebrate;
    if (node) {
      const title = node.querySelector('.celebrate-title');
      const sub = node.querySelector('.celebrate-sub');
      if (title) setText(title, 'Готово!');
      if (sub) setText(sub, 'Все фразы пройдены');
      show(node);
      node.classList.add('show');
      if (celebrateTimer) { try { clearTimeout(celebrateTimer); } catch (_) { /* ignore */ } }
      celebrateTimer = setTimeout(() => {
        node.classList.remove('show');
        hide(node);
      }, 3600);
    }
    setStatus('Все фразы пройдены. Великолепно!');
  }

  // ------------------------------------------------------------------ showDone
  // Port of src/renderer.js finishSession() markup into #done.
  // stats = engine.statsSummary(...) (after finishSessionStats);
  // sessionMeta = { durationMs, count, onAgain?, onHome? }.
  // onAgain/onHome (optional) wire the done-screen action buttons; if omitted the
  // buttons still render but are inert (Esc always returns to landing).
  function showDone(stats, sessionMeta) {
    stopTimer();
    const node = els.done;
    if (!node) return;
    const meta = sessionMeta || {};
    const durationMs = Number(meta.durationMs) || 0;

    const s = stats || {};
    const done = s.todayDone || 0;
    const skipped = s.todaySkipped || 0;
    const timing = s.timing || {};
    const avg = timing.avgSessionMs || 0;
    const perS = timing.avgPerSentenceMs ? Math.round(timing.avgPerSentenceMs / 1000) : 0;
    const streakVal = s.streak || 0;
    const didSessions = s.todaySessions || 0;
    const targetSessions = s.targetSessions || 0;
    const leftSessions = Math.max(0, targetSessions - didSessions);
    const sessionsLine = targetSessions > 0
      ? `📅 Сегодня: <b>${didSessions}</b> из ${targetSessions} занятий` +
        (leftSessions > 0 ? ` · осталось ${leftSessions}` : ' · всё на сегодня! 🎉')
      : `📅 Сегодня занятий: <b>${didSessions}</b>`;
    const L = s.level || null;
    const levelLine = L
      ? (L.next
        ? `Уровень <b>${escapeHtml(L.current)}</b> → ${escapeHtml(L.next)}: ${L.pct}% (${L.learned}/${L.total}, ~${L.daysToNext != null ? L.daysToNext : '∞'} дн.)`
        : `Уровень <b>${escapeHtml(L.current)}</b> — максимум`)
      : '';

    node.innerHTML = `
      <div class="big">✅ Готово за ${fmtClock(durationMs)}</div>
      <div class="done-sessions">${sessionsLine}</div>
      <div class="sub">${levelLine}</div>
      <div class="row">
        <div class="stat"><div class="v">${fmtClock(durationMs)}</div><div class="l">эта сессия</div></div>
        <div class="stat"><div class="v">${fmtClock(avg)}</div><div class="l">в среднем</div></div>
        <div class="stat"><div class="v">${perS}s</div><div class="l">на фразу</div></div>
      </div>
      <div class="row">
        <div class="stat"><div class="v">${done}</div><div class="l">сделано сегодня</div></div>
        <div class="stat"><div class="v">${skipped}</div><div class="l">пропущено</div></div>
        <div class="stat"><div class="v">🔥 ${streakVal}</div><div class="l">серия дней</div></div>
      </div>
      <div class="done-actions">
        <button id="done-again" class="btn btn-primary" type="button"><span>ЕЩЁ СЕССИЯ</span></button>
        <button id="done-home" class="btn btn-ghost" type="button"><span>НА ГЛАВНУЮ</span></button>
      </div>`;
    // Wire the freshly-rendered action buttons (innerHTML replaced any prior nodes).
    const againBtn = node.querySelector('#done-again');
    const homeBtn = node.querySelector('#done-home');
    if (againBtn) againBtn.addEventListener('click', () => safeCall(meta.onAgain));
    if (homeBtn) homeBtn.addEventListener('click', () => safeCall(meta.onHome));
    show(node);
    if (els.controls) els.controls.style.display = 'none';
  }

  // --------------------------------------------------------------------- reset
  // Clear the done overlay + transient flashes; ready the trainer view for a new run.
  function reset() {
    if (els.done) {
      els.done.innerHTML = '';
      hide(els.done);
    }
    if (els.controls) els.controls.style.display = '';
    if (els.celebrate) {
      els.celebrate.classList.remove('show');
      hide(els.celebrate);
    }
    if (els.errorToast) {
      els.errorToast.classList.remove('show');
      hide(els.errorToast);
    }
    if (els.bigword) els.bigword.classList.remove('hit', 'wrong', 'pop');
    hideTip();
    lastWordsKey = '';
    if (els.phraseWords) els.phraseWords.innerHTML = '';
    if (els.repeatDots) els.repeatDots.innerHTML = '';
    setText(els.progress, '');
    resetTimer();
  }

  // --------------------------------------------------------------------- timer
  function startTimer() {
    timerStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    stopTimer();
    const tick = () => {
      if (!els.timer) return;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      els.timer.textContent = fmtClock(now - timerStart);
      timerRaf = (typeof requestAnimationFrame !== 'undefined')
        ? requestAnimationFrame(loop) : 0;
    };
    let last = 0;
    const loop = (t) => {
      // throttle to ~1Hz to keep tabular timer cheap
      if (!last || t - last >= 250) { last = t; tick(); }
      else if (typeof requestAnimationFrame !== 'undefined') timerRaf = requestAnimationFrame(loop);
    };
    tick();
  }
  function stopTimer() {
    if (timerRaf && typeof cancelAnimationFrame !== 'undefined') {
      try { cancelAnimationFrame(timerRaf); } catch (_) { /* ignore */ }
    }
    timerRaf = 0;
  }
  function resetTimer() {
    stopTimer();
    if (els.timer) els.timer.textContent = '0:00';
  }

  // -------------------------------------------------------------- bindControls
  function bindControls(handlers) {
    const h = handlers || {};

    if (els.startBtn) {
      els.startBtn.addEventListener('click', () => {
        if (els.elevenKey && typeof h.onApiKey === 'function') {
          const key = els.elevenKey.value ? els.elevenKey.value.trim() : '';
          if (key) safeCall(h.onApiKey, key);
        }
        if (els.startOverlay) hide(els.startOverlay);
        if (els.trainerView) show(els.trainerView);
        startTimer();
        safeCall(h.onStart);
      });
    }

    if (els.replayBtn) els.replayBtn.addEventListener('click', () => safeCall(h.onReplay));
    if (els.skipBtn) els.skipBtn.addEventListener('click', () => safeCall(h.onSkip));
    // Clicking the mic icon re-plays the current sentence (premium voice).
    if (els.mic) {
      els.mic.style.cursor = 'pointer';
      els.mic.title = 'Озвучить фразу ещё раз';
      els.mic.addEventListener('click', () => safeCall(h.onReplay));
    }

    if (els.strictToggle) {
      updateStrictLabel();
      els.strictToggle.addEventListener('click', () => {
        strict = !strict;
        updateStrictLabel();
        safeCall(h.onToggleStrict, strict);
      });
    }

    if (els.swapBtn) {
      // Swap flips ONLY the Left/Right hand mapping. The video stays a natural selfie
      // mirror — we don't un-mirror it (that confused which hand is which). main.js owns
      // the mirror state, persists it, and calls setSwapActive() to reflect it here.
      els.swapBtn.addEventListener('click', () => safeCall(h.onSwapHands));
    }

    if (els.elevenKey) {
      els.elevenKey.addEventListener('change', () => {
        safeCall(h.onApiKey, els.elevenKey.value ? els.elevenKey.value.trim() : '');
      });
    }

    // Language picker clicks are bound in buildLangPicker, but allow direct rebinding too.
    if (typeof h.onPickLang === 'function' && els.langPicker) {
      els.langPicker.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.lang-opt') : null;
        if (!btn || !btn.dataset.lang) return;
        for (const node of els.langPicker.querySelectorAll('.lang-opt')) node.classList.remove('active');
        btn.classList.add('active');
        safeCall(h.onPickLang, btn.dataset.lang);
      });
    }
  }

  function updateStrictLabel() {
    if (!els.strictToggle) return;
    els.strictToggle.textContent = strict ? 'Строгая рука · ВКЛ' : 'Строгая рука · ВЫКЛ';
    els.strictToggle.setAttribute('aria-pressed', strict ? 'true' : 'false');
    els.strictToggle.classList.toggle('active', strict);
  }

  // ---------------------------------------------------------------- wordHoverTip
  // Inline .word-gloss handles hover via CSS, but a floating #wordtip is wired as a
  // legacy/accessible fallback for the current sentence's glosses.
  function wordHoverTip() {
    const host = els.phraseWords;
    const tip = els.wordtip;
    if (!host || !tip) return;
    host.addEventListener('mouseover', (e) => {
      const word = e.target && e.target.closest ? e.target.closest('.word') : null;
      if (!word) return;
      const i = Number(word.dataset.i);
      const t = (lastGloss[i] && lastGloss[i].t) || '';
      if (!t) return;
      showTip(t, word);
    });
    host.addEventListener('mouseout', (e) => {
      if (e.target && e.target.closest && e.target.closest('.word')) hideTip();
    });
  }

  function showTip(text, target) {
    const tip = els.wordtip;
    if (!tip || !target || !target.getBoundingClientRect) return;
    setText(tip, text);
    show(tip);
    const r = target.getBoundingClientRect();
    const tipW = tip.offsetWidth;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
    let x = r.left + r.width / 2 - tipW / 2;
    if (vw) x = Math.max(8, Math.min(x, vw - tipW - 8));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
  }
  function hideTip() {
    if (els.wordtip) hide(els.wordtip);
  }

  // ---------------------------------------------------------------- setSwapActive
  // Reflect the current hand-mirroring state on the Swap button (main.js owns the value).
  function setSwapActive(on) {
    mirrored = !!on;
    if (els.swapBtn) {
      els.swapBtn.classList.toggle('active', mirrored);
      els.swapBtn.setAttribute('aria-pressed', mirrored ? 'true' : 'false');
    }
  }

  // ------------------------------------------------------------------ escapeHtml
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  return {
    buildLangPicker,
    renderState,
    setMeter,
    drawLandmarks,
    renderStats,
    setStatus,
    setCamStatus,
    showError,
    celebrate,
    allDone,
    showDone,
    reset,
    bindControls,
    setSwapActive,
    wordHoverTip,
    els,
  };
}
