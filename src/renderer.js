// ---------- DOM ----------
const el = {
  pattern: document.getElementById("pattern"),
  progress: document.getElementById("progress"),
  stats: document.getElementById("stats"),
  timer: document.getElementById("timer"),
  levelCur: document.getElementById("level-cur"),
  levelNext: document.getElementById("level-next"),
  levelFill: document.getElementById("level-fill"),
  levelInfo: document.getElementById("level-info"),
  mic: document.getElementById("mic"),
  sentence: document.getElementById("sentence"),
  translation: document.getElementById("translation"),
  hands: document.getElementById("hands"),
  handL: document.getElementById("handL"),
  handR: document.getElementById("handR"),
  bigword: document.getElementById("bigword"),
  repeat: document.getElementById("repeat"),
  repeatTarget: document.getElementById("repeat-target"),
  repeatPhrase: document.getElementById("repeat-phrase"),
  repeatDots: document.getElementById("repeat-dots"),
  stage: document.getElementById("stage"),
  done: document.getElementById("done"),
  wordtip: document.getElementById("wordtip"),
  btnReplay: document.getElementById("btn-replay"),
  btnSkip: document.getElementById("btn-skip"),
};

// ---------- State ----------
let cfg = null;
let session = null;
let stats = null;
let si = 0;
let wi = 0;
let words = [];
let glossArr = [];
let phase = "idle"; // idle | words | repeat | done
let repeatCount = 0;
let REPEAT_TARGET = 10;
let sessionStart = 0;
let timerInterval = null;

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function startTimer() {
  sessionStart = Date.now();
  stopTimer();
  const tick = () => { if (el.timer) el.timer.textContent = fmtClock(Date.now() - sessionStart); };
  tick();
  timerInterval = setInterval(tick, 1000);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function splitWords(s) {
  return s.text.trim().split(/\s+/);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

// ---------- Session ----------
async function startSession() {
  // Reset UI from any previous session (the done overlay must not linger).
  el.done.classList.add("hidden");
  el.done.innerHTML = "";
  el.stage.style.display = "";
  document.getElementById("controls").style.display = "";

  const data = await window.api.getData();
  cfg = data.config;
  session = data.session;
  stats = data.stats;
  REPEAT_TARGET = (cfg.drill && cfg.drill.repeatTarget) || 10;
  el.repeatTarget.textContent = REPEAT_TARGET;
  renderStats();

  if (!session || !session.sentences || !session.sentences.length) {
    stopTimer();
    if (el.timer) el.timer.textContent = "0:00";
    el.stage.style.display = "none";
    el.done.innerHTML = `<div class="big">👍 Нет заданий</div>
      <div class="sub">Все повторения на сейчас сделаны. Загляни в следующий час.</div>`;
    el.done.classList.remove("hidden");
    setTimeout(() => window.api.sessionDone(), 2200);
    return;
  }
  si = 0;
  startTimer();
  startSentence();
}

function renderStats() {
  if (!stats) return;
  el.stats.textContent = `🔥 ${stats.streak}`;
  el.stats.title = `Серия: ${stats.streak} дн. · Выучено ${stats.learned} из ${stats.total} · Сегодня: ${stats.todayDone} сделано, ${stats.todaySkipped} пропущено` +
    (stats.timing && stats.timing.sessions ? ` · среднее ${fmtClock(stats.timing.avgSessionMs)}/сессия` : "");
  const L = stats.level;
  if (L) {
    el.levelCur.textContent = L.current;
    el.levelNext.textContent = L.next || "MAX";
    el.levelFill.style.width = `${L.pct}%`;
    el.levelInfo.textContent = L.next
      ? `${L.learned}/${L.total} · до ${L.next} ~${L.daysToNext} дн.`
      : `${L.learned}/${L.total} · максимум`;
  }
}

function startSentence() {
  phase = "words";
  const s = session.sentences[si];
  words = splitWords(s);
  glossArr = s.gloss || [];
  wi = 0;
  const tense = s.tenseLabel || s.tenseBucket || s.tense || "present";
  el.pattern.innerHTML = `<span class="tense-badge">${escapeHtml(s.level || "")} · ${escapeHtml(tense)}</span> ${escapeHtml(s.pattern || "")}` +
    (s.isNew ? ` <span class="new-badge">НОВОЕ</span>` : "");
  el.progress.textContent = `${si + 1} / ${session.sentences.length}`;
  el.translation.textContent = s.translation || "";
  el.repeat.classList.add("hidden");
  el.hands.style.display = "flex";
  el.bigword.style.display = "";
  hideTip();
  renderSentence();
  showWord();
  speakSentence(s.text);
}

function glossFor(i) {
  // Align gloss entries to words by index; fall back to matching word text.
  if (glossArr[i] && glossArr[i].t) return glossArr[i].t;
  const w = (words[i] || "").toLowerCase().replace(/[^a-z']/g, "");
  const hit = glossArr.find((g) => (g.w || "").toLowerCase().replace(/[^a-z']/g, "") === w);
  return hit ? hit.t : "";
}

function renderSentence() {
  el.sentence.innerHTML = words
    .map((w, i) => {
      let cls = "w";
      if (i < wi) cls += " done";
      else if (i === wi) cls += " active";
      return `<span class="${cls}" data-i="${i}">${w}</span>`;
    })
    .join(" ");
}

function showWord() {
  const chunk = words.slice(0, wi + 1).join(" ");
  el.bigword.textContent = chunk;
  el.bigword.classList.remove("hit");
  el.bigword.classList.remove("pop");
  void el.bigword.offsetWidth;
  el.bigword.classList.add("pop");
  const left = wi % 2 === 0;
  el.handL.classList.toggle("lit", left);
  el.handR.classList.toggle("lit", !left);
  renderSentence();
}

function advanceWord(hit) {
  if (phase !== "words") return;
  if (hit) el.bigword.classList.add("hit");
  wi++;
  if (wi >= words.length) enterRepeat();
  else setTimeout(showWord, hit ? 110 : 0);
}

// ---------- Repeat phase: N reps, numbered dots red -> green ----------
function enterRepeat() {
  phase = "repeat";
  repeatCount = 0;
  el.hands.style.display = "none";
  el.bigword.style.display = "none";
  el.repeat.classList.remove("hidden");
  el.repeatPhrase.textContent = session.sentences[si].text;
  renderDots();
}

function renderDots() {
  el.repeatDots.innerHTML = "";
  for (let i = 0; i < REPEAT_TARGET; i++) {
    const d = document.createElement("div");
    d.className = "dot" + (i < repeatCount ? " on" : "") + (i === repeatCount ? " current" : "");
    const size = 26 + i * 3.2; // each subsequent dot grows
    d.style.width = `${size}px`;
    d.style.height = `${size}px`;
    d.style.fontSize = `${12 + i * 0.7}px`;
    if (i < repeatCount) {
      const hue = Math.round((i / (REPEAT_TARGET - 1)) * 120); // 0 red -> 120 green
      d.style.background = `hsl(${hue} 70% 50%)`;
    }
    d.textContent = i + 1;
    el.repeatDots.appendChild(d);
  }
}

function tickRepeat() {
  if (phase !== "repeat") return;
  repeatCount++;
  renderDots();
  if (repeatCount >= REPEAT_TARGET) setTimeout(() => completeSentence("pass"), 350);
}

// ---------- Sentence completion ----------
function completeSentence(grade) {
  const s = session.sentences[si];
  if (s) window.api.recordResult(s.id, grade);
  // optimistic local stat bump
  if (stats) {
    if (grade === "pass") stats.todayDone++;
    else stats.todaySkipped++;
  }
  stopAudio();
  si++;
  if (si >= session.sentences.length) finishSession();
  else startSentence();
}

async function finishSession() {
  phase = "done";
  stopAudio();
  stopTimer();
  const durationMs = Date.now() - sessionStart;
  const count = session.sentences.length;
  const fresh = await window.api.finishSession(durationMs, count);
  if (fresh) stats = fresh;
  renderStats();

  const done = stats ? stats.todayDone : 0;
  const skipped = stats ? stats.todaySkipped : 0;
  const avg = stats && stats.timing ? stats.timing.avgSessionMs : 0;
  const perS = stats && stats.timing ? Math.round(stats.timing.avgPerSentenceMs / 1000) : 0;
  const L = stats && stats.level ? stats.level : null;
  const levelLine = L
    ? (L.next ? `Уровень <b>${L.current}</b> → ${L.next}: ${L.pct}% (${L.learned}/${L.total}, ~${L.daysToNext} дн.)` : `Уровень <b>${L.current}</b> — максимум`)
    : "";

  el.stage.style.display = "none";
  el.done.innerHTML = `
    <div class="big">✅ Готово за ${fmtClock(durationMs)}</div>
    <div class="sub">${levelLine}</div>
    <div class="row">
      <div class="stat"><div class="v">${fmtClock(durationMs)}</div><div class="l">эта сессия</div></div>
      <div class="stat"><div class="v">${fmtClock(avg)}</div><div class="l">в среднем</div></div>
      <div class="stat"><div class="v">${perS}s</div><div class="l">на фразу</div></div>
    </div>
    <div class="row">
      <div class="stat"><div class="v">${done}</div><div class="l">сделано сегодня</div></div>
      <div class="stat"><div class="v">${skipped}</div><div class="l">пропущено</div></div>
      <div class="stat"><div class="v">🔥 ${stats ? stats.streak : 0}</div><div class="l">серия дней</div></div>
    </div>`;
  el.done.classList.remove("hidden");
  document.getElementById("controls").style.display = "none";
  setTimeout(() => window.api.sessionDone(), 3200);
}

// ---------- TTS ----------
let currentAudio = null;
let speakToken = 0;

function stopAudio() {
  speakToken++;
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
  el.mic.classList.remove("speaking");
}

async function speakSentence(text) {
  if (!cfg.tts || !cfg.tts.enabled) return;
  const myToken = ++speakToken;
  if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
  const res = await window.api.getAudio(text);
  if (myToken !== speakToken) return;
  if (!res || !res.ok || !res.dataUrl) {
    if (res && /NO_API_KEY/.test(res.error || "")) {
      el.mic.textContent = "🔇";
      el.mic.title = "Вставь ключ ElevenLabs в config.json → tts.apiKey";
    }
    return;
  }
  const times = cfg.tts.repeatCount || 3;
  const gap = cfg.tts.gapMs ?? 550;
  let n = 0;
  el.mic.textContent = "🔊";
  el.mic.classList.add("speaking");
  const playOnce = () => {
    if (myToken !== speakToken) return;
    currentAudio = new Audio(res.dataUrl);
    currentAudio.onended = () => {
      if (myToken !== speakToken) return;
      n++;
      if (n < times) setTimeout(playOnce, gap);
      else el.mic.classList.remove("speaking");
    };
    currentAudio.play().catch(() => {});
  };
  playOnce();
}

// ---------- Word translation tooltip (hover) ----------
function showTip(i, target) {
  const t = glossFor(i);
  if (!t) return;
  el.wordtip.textContent = t;
  el.wordtip.classList.remove("hidden");
  const r = target.getBoundingClientRect();
  const tipW = el.wordtip.offsetWidth;
  let x = r.left + r.width / 2 - tipW / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tipW - 8));
  el.wordtip.style.left = `${x}px`;
  el.wordtip.style.top = `${Math.max(8, r.top - el.wordtip.offsetHeight - 8)}px`;
}
function hideTip() { el.wordtip.classList.add("hidden"); }

el.sentence.addEventListener("mouseover", (e) => {
  const w = e.target.closest(".w");
  if (w) showTip(Number(w.dataset.i), w);
});
el.sentence.addEventListener("mouseout", (e) => {
  if (e.target.closest(".w")) hideTip();
});

// ---------- Controls ----------
el.btnReplay.addEventListener("click", () => {
  if (session && session.sentences[si]) speakSentence(session.sentences[si].text);
});
el.btnSkip.addEventListener("click", () => {
  if (phase === "words" || phase === "repeat") completeSentence("skip");
});

// ---------- Keyboard: left/right alternation ----------
const LEFT_KEYS = ["ControlLeft", "ArrowLeft"];
const RIGHT_KEYS = ["ControlRight", "ArrowRight"];

function flashWrong() {
  el.bigword.classList.remove("wrong");
  void el.bigword.offsetWidth;
  el.bigword.classList.add("wrong");
}

document.addEventListener("keydown", (e) => {
  const isLeft = LEFT_KEYS.includes(e.code);
  const isRight = RIGHT_KEYS.includes(e.code);

  if (e.code === "Escape") { stopAudio(); stopTimer(); window.api.closeWindow(); return; }
  if (e.key === "r" || e.key === "R") {
    if (session && session.sentences[si]) speakSentence(session.sentences[si].text);
    return;
  }
  if (e.key === "s" || e.key === "S") {
    if (phase === "words" || phase === "repeat") completeSentence("skip");
    return;
  }

  if (phase === "words") {
    if (isLeft || isRight) {
      e.preventDefault();
      const expectLeft = wi % 2 === 0;
      if ((expectLeft && isLeft) || (!expectLeft && isRight)) advanceWord(true);
      else flashWrong();
    } else if (e.code === "Space") {
      e.preventDefault();
      advanceWord(false);
    }
  } else if (phase === "repeat") {
    e.preventDefault(); // any key counts one repetition
    tickRepeat();
  }
});

// ---------- Wire up ----------
window.api.onStartSession(() => {
  document.getElementById("controls").style.display = "";
  startSession();
});
