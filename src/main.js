const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const SENTENCES_PATH = path.join(ROOT, "data", "sentences.json");
const PROGRESS_PATH = path.join(ROOT, "data", "progress.json");
const TTS_CACHE_DIR = path.join(ROOT, "data", "tts-cache");

const DAY_MS = 86400000;
const LEVELS = ["A2", "B1", "B2", "B2+"];
const LEVEL_RANK = { A2: 1, B1: 2, B2: 3, "B2+": 4 };
const DEFAULT_TENSE_ROTATION = ["present", "past", "future", "present", "modal", "conditional", "perfect", "present"];
const TENSE_BUCKET_LABELS = {
  present: "present",
  past: "past",
  future: "future",
  modal: "modal",
  conditional: "would/if",
  perfect: "perfect",
  mixed: "mixed",
};

let win = null;
let tray = null;
let timer = null;
let nextRunAt = 0;

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {});
  const t = cfg.tts || {};
  const sc = cfg.schedule || {};
  const srs = cfg.srs || {};
  const drill = cfg.drill || {};
  return {
    schedule: {
      days: Array.isArray(sc.days) ? sc.days : [1, 2, 3, 4, 5],
      startHour: sc.startHour ?? 10,
      endHour: sc.endHour ?? 17,
      everyMinutes: Number(sc.everyMinutes) || 60,
    },
    sentencesPerRun: Number(cfg.sentencesPerRun) || 10,
    autoAdvanceMs: cfg.autoAdvanceMs === undefined ? 0 : Number(cfg.autoAdvanceMs) || 0,
    popupOnStart: cfg.popupOnStart === true || process.env.ELECTRON_POPUP_ON_START === "1",
    drill: {
      repeatTarget: Number(drill.repeatTarget) || 10,
      tenseRotation: Array.isArray(drill.tenseRotation) && drill.tenseRotation.length ? drill.tenseRotation : DEFAULT_TENSE_ROTATION,
      targetLevel: drill.targetLevel || "B2",
    },
    srs: {
      enabled: srs.enabled !== false,
      newPerSession: Number(srs.newPerSession) || 10,
      intervalsDays: Array.isArray(srs.intervalsDays) ? srs.intervalsDays : [0, 1, 3, 7, 16, 35, 90],
    },
    tts: {
      enabled: t.enabled !== false,
      apiKey: t.apiKey || process.env.ELEVENLABS_API_KEY || "",
      proxyUrl: (t.proxyUrl || "").replace(/\/$/, ""),
      proxySecret: t.proxySecret || "",
      voiceId: t.voiceId || "Gfpl8Yo74Is0W6cPUWWT",
      modelId: t.modelId || "eleven_multilingual_v2",
      stability: t.stability ?? 0.5,
      similarityBoost: t.similarityBoost ?? 0.8,
      speed: t.speed ?? 0.85,
      repeatCount: Number(t.repeatCount) || 3,
      gapMs: t.gapMs ?? 550,
    },
  };
}

// ---------- Progress / SRS state ----------
function loadProgress() {
  return readJson(PROGRESS_PATH, { srs: {}, stats: { byDay: {}, totalDone: 0, totalSkipped: 0, streak: 0, lastDoneDate: null } });
}
function saveProgress(p) {
  try {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
  } catch (e) {}
}
function dateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tenseBucket(tense = "", pattern = "") {
  const hay = `${tense} ${pattern}`.toLowerCase();
  if (/conditional|hypothetical|supposing|if i were|if .* would|would have|had i known|weren't for|provided that|assuming that|as long as/.test(hay)) return "conditional";
  if (/past|used to|did you|didn't|were you|wasn't|went|saw|had to|in hindsight|looking back|dawned|wish i had|if only i had|should never have|paved the way/.test(hay)) return "past";
  if (/present[- ]perfect|perfect continuous|have you ever|i've|haven't .* yet|has far-reaching/.test(hay)) return "perfect";
  if (/future|will|going to|matter of time|chances are|every chance/.test(hay)) return "future";
  if (/modal|should|could|can|can't|might|must|would you mind|had better|i'd like|i'd love/.test(hay)) return "modal";
  if (/mixed|whereas|although|even though|despite|while/.test(hay)) return "mixed";
  return "present";
}

function flattenSentences() {
  const data = readJson(SENTENCES_PATH, { groups: [] });
  const groups = data.groups || [];
  const all = [];
  groups.forEach((g, gi) => {
    const bucket = tenseBucket(g.tense, g.pattern);
    (g.sentences || []).forEach((s, si) => {
      all.push({
        id: `${gi}:${si}`,
        text: s.text,
        translation: s.translation,
        gloss: s.gloss || [],
        pattern: g.pattern,
        tense: g.tense,
        tenseBucket: bucket,
        tenseLabel: TENSE_BUCKET_LABELS[bucket] || g.tense || "present",
        level: g.level || "A2",
        groupIndex: gi,
        sentenceIndex: si,
      });
    });
  });
  return all;
}

function groupSentences(all) {
  const map = new Map();
  for (const s of all) {
    if (!map.has(s.groupIndex)) {
      map.set(s.groupIndex, {
        groupIndex: s.groupIndex,
        pattern: s.pattern,
        tense: s.tense,
        tenseBucket: s.tenseBucket,
        tenseLabel: s.tenseLabel,
        level: s.level,
        sentences: [],
      });
    }
    map.get(s.groupIndex).sentences.push(s);
  }
  return [...map.values()].sort((a, b) => a.groupIndex - b.groupIndex);
}

function slotIndexFor(ts, schedule) {
  const d = new Date(ts);
  const startMin = schedule.startHour * 60;
  const every = Math.max(1, Number(schedule.everyMinutes) || 60);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, Math.floor((nowMin - startMin) / every));
}

function targetTenseBucket(ts, cfg) {
  const rotation = cfg.drill.tenseRotation || DEFAULT_TENSE_ROTATION;
  return rotation[slotIndexFor(ts, cfg.schedule) % rotation.length] || "present";
}

function relatedBuckets(bucket) {
  const byBucket = {
    present: ["present", "modal", "perfect", "mixed"],
    past: ["past", "perfect", "mixed"],
    future: ["future", "conditional", "modal"],
    modal: ["modal", "conditional", "future", "present"],
    conditional: ["conditional", "future", "modal", "past"],
    perfect: ["perfect", "past", "present"],
    mixed: ["mixed", "present", "past", "future"],
  };
  return byBucket[bucket] || [bucket, "present", "past", "future"];
}

function currentLevel(all, srs) {
  const present = LEVELS.filter((level) => all.some((s) => s.level === level));
  return present.find((level) => all.some((s) => s.level === level && !srs[s.id])) || present[present.length - 1] || "A2";
}

function targetLevelRank(cfg) {
  return LEVEL_RANK[cfg.drill.targetLevel] || LEVEL_RANK.B2;
}

function eligibleForTarget(s, cfg) {
  return (LEVEL_RANK[s.level] || LEVEL_RANK.A2) <= targetLevelRank(cfg);
}

function oldestSeenFirst(srs) {
  return (a, b) => (srs[a.id]?.last || 0) - (srs[b.id]?.last || 0) || sortCurriculum(a, b);
}

function oldestGroupFirst(srs) {
  return (a, b) => {
    const oldestA = Math.min(...a.sentences.filter((s) => srs[s.id]).map((s) => srs[s.id].last || 0));
    const oldestB = Math.min(...b.sentences.filter((s) => srs[s.id]).map((s) => srs[s.id].last || 0));
    return oldestA - oldestB || a.groupIndex - b.groupIndex;
  };
}

function chooseFocusGroup(groups, srs, level, bucket, now, sessionSize) {
  const hasNew = (g) => g.sentences.some((s) => !srs[s.id]);
  const hasDue = (g) => g.sentences.some((s) => srs[s.id] && srs[s.id].due <= now);
  const hasSeen = (g) => g.sentences.some((s) => srs[s.id]);
  const availableCount = (g) => g.sentences.filter((s) => !srs[s.id] || (srs[s.id] && srs[s.id].due <= now)).length;
  const open = groups.filter((g) => g.level === level && hasNew(g));
  const due = groups.filter((g) => g.level === level && hasDue(g));
  const seen = groups.filter((g) => g.level === level && hasSeen(g)).sort(oldestGroupFirst(srs));
  const related = relatedBuckets(bucket);
  const fullOpen = open.filter((g) => availableCount(g) >= sessionSize);
  const fullDue = due.filter((g) => availableCount(g) >= sessionSize);
  const fullSeen = seen.filter((g) => g.sentences.filter((s) => srs[s.id]).length >= sessionSize);
  return (
    fullDue.find((g) => g.tenseBucket === bucket) ||
    fullOpen.find((g) => g.tenseBucket === bucket) ||
    fullSeen.find((g) => g.tenseBucket === bucket) ||
    fullDue.find((g) => related.includes(g.tenseBucket)) ||
    fullOpen.find((g) => related.includes(g.tenseBucket)) ||
    fullSeen.find((g) => related.includes(g.tenseBucket)) ||
    due.find((g) => g.tenseBucket === bucket) ||
    open.find((g) => g.tenseBucket === bucket) ||
    seen.find((g) => g.tenseBucket === bucket) ||
    due.find((g) => related.includes(g.tenseBucket)) ||
    open.find((g) => related.includes(g.tenseBucket)) ||
    seen.find((g) => related.includes(g.tenseBucket)) ||
    open[0] ||
    due[0] ||
    seen[0] ||
    groups.find(hasDue) ||
    groups.find(hasNew) ||
    groups.filter(hasSeen).sort(oldestGroupFirst(srs))[0] ||
    null
  );
}

function sortCurriculum(a, b) {
  return a.groupIndex - b.groupIndex || a.sentenceIndex - b.sentenceIndex;
}

function sortDueFirst(srs) {
  return (a, b) => (srs[a.id]?.due || 0) - (srs[b.id]?.due || 0) || sortCurriculum(a, b);
}

// Build a session: 10 items when available, anchored to a construction and a time bucket.
function buildSession() {
  const cfg = loadConfig();
  const all = flattenSentences();
  const eligible = all.filter((s) => eligibleForTarget(s, cfg));
  const prog = loadProgress();
  const srs = prog.srs || {};
  const now = Date.now();
  const N = cfg.sentencesPerRun;
  const groups = groupSentences(eligible);
  const level = currentLevel(eligible, srs);
  const bucket = targetTenseBucket(now, cfg);
  const focus = chooseFocusGroup(groups, srs, level, bucket, now, N);
  const seen = new Set();
  const out = [];

  const add = (items) => {
    for (const s of items) {
      if (seen.has(s.id) || out.length >= N) continue;
      seen.add(s.id);
      out.push({ ...s, isNew: !srs[s.id] });
    }
  };
  // Never show the same sentence twice in one calendar day (no within-day repetition).
  const today = dateStr(now);
  const seenToday = (s) => srs[s.id] && srs[s.id].last && dateStr(srs[s.id].last) === today;
  const due = (predicate) => eligible.filter((s) => predicate(s) && srs[s.id] && srs[s.id].due <= now && !seenToday(s)).sort(sortDueFirst(srs));
  const news = (predicate) => eligible.filter((s) => predicate(s) && !srs[s.id]).sort(sortCurriculum);
  const maintenance = (predicate) => eligible.filter((s) => predicate(s) && srs[s.id] && !seenToday(s)).sort(oldestSeenFirst(srs));

  if (focus) {
    add(due((s) => s.groupIndex === focus.groupIndex));
    add(news((s) => s.groupIndex === focus.groupIndex));
    add(maintenance((s) => s.groupIndex === focus.groupIndex));
  }

  const related = relatedBuckets(focus ? focus.tenseBucket : bucket);
  for (const b of related) {
    add(due((s) => s.level === level && s.tenseBucket === b));
    add(news((s) => s.level === level && s.tenseBucket === b));
    add(maintenance((s) => s.level === level && s.tenseBucket === b));
    if (out.length >= N) break;
  }

  add(due((s) => s.level === level));
  add(due(() => true));
  add(news((s) => s.level === level));
  add(news(() => true));
  add(maintenance((s) => s.level === level));
  add(maintenance(() => true));

  return {
    focus: focus
      ? {
          level: focus.level,
          pattern: focus.pattern,
          tense: focus.tense,
          tenseBucket: focus.tenseBucket,
          tenseLabel: focus.tenseLabel,
          targetBucket: bucket,
          targetLabel: TENSE_BUCKET_LABELS[bucket] || bucket,
        }
      : null,
    sentences: out,
  };
}

function recordResult(id, grade) {
  const cfg = loadConfig();
  const intervals = cfg.srs.intervalsDays;
  const prog = loadProgress();
  prog.srs = prog.srs || {};
  prog.stats = prog.stats || { byDay: {}, totalDone: 0, totalSkipped: 0, streak: 0, lastDoneDate: null };
  const now = Date.now();
  const e = prog.srs[id] || { idx: -1, reps: 0, lapses: 0 };
  if (grade === "pass") {
    e.idx = Math.min(e.idx + 1, intervals.length - 1);
    e.reps++;
  } else {
    e.idx = 0; // bring skipped items back soon
    e.lapses++;
  }
  e.due = now + (intervals[Math.max(0, e.idx)] || 0) * DAY_MS;
  e.last = now;
  prog.srs[id] = e;

  const d = dateStr(now);
  prog.stats.byDay[d] = prog.stats.byDay[d] || { done: 0, skipped: 0 };
  if (grade === "pass") {
    prog.stats.byDay[d].done++;
    prog.stats.totalDone++;
    if (prog.stats.lastDoneDate !== d) {
      const yest = dateStr(now - DAY_MS);
      prog.stats.streak = prog.stats.lastDoneDate === yest ? (prog.stats.streak || 0) + 1 : 1;
      prog.stats.lastDoneDate = d;
    }
  } else {
    prog.stats.byDay[d].skipped++;
    prog.stats.totalSkipped++;
  }
  saveProgress(prog);
}

function slotsPerDay() {
  const s = loadConfig().schedule;
  return Math.max(1, Math.floor(((s.endHour - s.startHour) * 60) / s.everyMinutes) + 1);
}

function statsSummary() {
  const cfg = loadConfig();
  const prog = loadProgress();
  const all = flattenSentences();
  const now = Date.now();
  const srs = prog.srs || {};
  const learned = Object.keys(srs).length;
  const dueNow = all.filter((s) => srs[s.id] && srs[s.id].due <= now).length;
  const d = dateStr(now);
  const today = (prog.stats && prog.stats.byDay && prog.stats.byDay[d]) || { done: 0, skipped: 0 };

  // Per-level progress.
  const perLevel = {};
  LEVELS.forEach((l) => (perLevel[l] = { total: 0, learned: 0 }));
  all.forEach((s) => {
    const l = perLevel[s.level] ? s.level : "A2";
    perLevel[l].total++;
    if (srs[s.id]) perLevel[l].learned++;
  });
  const presentLevels = LEVELS.filter((l) => perLevel[l].total > 0);
  let current = presentLevels.find((l) => perLevel[l].learned < perLevel[l].total) || presentLevels[presentLevels.length - 1];
  const cl = perLevel[current];
  const ci = presentLevels.indexOf(current);
  const nextLevel = ci >= 0 && ci < presentLevels.length - 1 ? presentLevels[ci + 1] : null;
  const levelRemaining = Math.max(0, cl.total - cl.learned);
  const levelPct = cl.total ? Math.round((cl.learned / cl.total) * 100) : 100;
  const newPerDay = Math.max(cfg.sentencesPerRun, cfg.srs.newPerSession || 1) * slotsPerDay();
  const daysToNext = newPerDay > 0 ? Math.ceil(levelRemaining / newPerDay) : null;

  // Timing.
  const tm = (prog.stats && prog.stats.timing) || { totalMs: 0, sessions: 0, totalSentences: 0 };
  const avgSessionMs = tm.sessions ? Math.round(tm.totalMs / tm.sessions) : 0;
  const avgPerSentenceMs = tm.totalSentences ? Math.round(tm.totalMs / tm.totalSentences) : 0;

  return {
    streak: (prog.stats && prog.stats.streak) || 0,
    learned,
    total: all.length,
    dueNow,
    todayDone: today.done,
    todaySkipped: today.skipped,
    totalDone: (prog.stats && prog.stats.totalDone) || 0,
    totalSkipped: (prog.stats && prog.stats.totalSkipped) || 0,
    level: { current, next: nextLevel, pct: levelPct, learned: cl.learned, total: cl.total, remaining: levelRemaining, daysToNext },
    timing: { avgSessionMs, avgPerSentenceMs, sessions: tm.sessions },
  };
}

// ---------- ElevenLabs TTS ----------
async function getAudioDataUrl(text) {
  const cfg = loadConfig();
  const t = cfg.tts;
  if (!t.enabled) return null;

  const key = crypto
    .createHash("sha1")
    .update(`${t.voiceId}|${t.modelId}|${t.speed}|${t.stability}|${t.similarityBoost}|${text}`)
    .digest("hex");
  const file = path.join(TTS_CACHE_DIR, `${key}.mp3`);

  let buf;
  if (fs.existsSync(file)) {
    // Bundled/cached audio — works with no API key (the normal case for end users).
    buf = fs.readFileSync(file);
  } else {
    // Not cached → need the API to generate it.
    if (!t.apiKey) throw new Error("NO_API_KEY");
    const base = t.proxyUrl ? `${t.proxyUrl}/elevenlabs` : "https://api.elevenlabs.io";
    const url = `${base}/v1/text-to-speech/${t.voiceId}`;
    const headers = { "xi-api-key": t.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" };
    if (t.proxyUrl && t.proxySecret) headers["X-Proxy-Secret"] = t.proxySecret;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        model_id: t.modelId,
        voice_settings: { stability: t.stability, similarity_boost: t.similarityBoost, speed: t.speed },
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`TTS ${res.status}: ${err.slice(0, 200)}`);
    }
    buf = Buffer.from(await res.arrayBuffer());
    try {
      fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, buf);
    } catch (e) {}
  }
  return `data:audio/mpeg;base64,${buf.toString("base64")}`;
}

// ---------- Window / tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 620,
    show: false,
    frame: true,
    resizable: true,
    alwaysOnTop: true,
    center: true,
    title: "ENGLESY",
    backgroundColor: "#0e1116",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showPopup() {
  if (!win) createWindow();
  win.webContents.send("start-session");
  win.show();
  win.focus();
  win.moveTop();
}

// Next scheduled slot: a day in schedule.days, time stepping by everyMinutes from startHour..endHour.
function nextSlot(fromTs) {
  const cfg = loadConfig().schedule;
  const from = new Date(fromTs);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const base = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, 0, 0, 0, 0);
    if (!cfg.days.includes(base.getDay())) continue;
    const startMin = cfg.startHour * 60;
    const endMin = cfg.endHour * 60;
    for (let m = startMin; m <= endMin; m += cfg.everyMinutes) {
      const slot = new Date(base.getTime() + m * 60000);
      if (slot.getTime() > fromTs) return slot.getTime();
    }
  }
  return fromTs + DAY_MS; // fallback
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  nextRunAt = nextSlot(Date.now());
  const delay = Math.max(1000, nextRunAt - Date.now());
  // setTimeout caps around 24.8 days; our delays are always < 8 days, safe.
  timer = setTimeout(() => {
    showPopup();
    scheduleNext();
  }, delay);
  updateTray();
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const days = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const same = dateStr(ts) === dateStr(Date.now());
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return same ? `сегодня ${hm}` : `${days[d.getDay()]} ${hm}`;
}

function updateTray() {
  if (!tray) return;
  const st = statsSummary();
  const menu = Menu.buildFromTemplate([
    { label: nextRunAt ? `Следующее окно: ${fmtWhen(nextRunAt)}` : "Запуск…", enabled: false },
    { label: `🔥 серия: ${st.streak} дн.  •  выучено ${st.learned}/${st.total}`, enabled: false },
    { type: "separator" },
    { label: "Практика сейчас", click: () => showPopup() },
    { label: "Сбросить таймер", click: () => scheduleNext() },
    { type: "separator" },
    { label: "Выход", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`ENGLESY — серия ${st.streak} дн., выучено ${st.learned}/${st.total}`);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("🇬🇧");
  updateTray();
}

// ---------- IPC ----------
ipcMain.handle("get-data", () => {
  const cfg = loadConfig();
  return { config: cfg, session: buildSession(), stats: statsSummary() };
});

ipcMain.handle("get-audio", async (_e, text) => {
  try {
    return { ok: true, dataUrl: await getAudioDataUrl(text) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.on("record-result", (_e, id, grade) => {
  recordResult(id, grade);
  updateTray();
});

ipcMain.handle("finish-session", (_e, durationMs, count) => {
  const prog = loadProgress();
  prog.stats = prog.stats || { byDay: {}, totalDone: 0, totalSkipped: 0, streak: 0, lastDoneDate: null };
  const tm = prog.stats.timing || { totalMs: 0, sessions: 0, totalSentences: 0 };
  tm.totalMs += Math.max(0, Number(durationMs) || 0);
  tm.sessions += 1;
  tm.totalSentences += Math.max(0, Number(count) || 0);
  prog.stats.timing = tm;
  prog.stats.lastSession = { durationMs: Number(durationMs) || 0, count: Number(count) || 0, at: Date.now() };
  saveProgress(prog);
  updateTray();
  return statsSummary();
});

ipcMain.on("session-done", () => {
  if (win) win.hide();
  updateTray();
});
ipcMain.on("close-window", () => {
  if (win) win.hide();
});

// ---------- Boot ----------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
  if (loadConfig().popupOnStart) setTimeout(showPopup, 600);
  scheduleNext();
});

app.on("window-all-closed", () => {});
