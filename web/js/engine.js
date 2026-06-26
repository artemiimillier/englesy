// ENGLESY — SRS engine (browser port of ../src/main.js, lines ~158–464 + finish-session).
//
// PURE module: no DOM, no fetch, no Node fs/crypto. Data, config and progress are
// passed in as arguments instead of being read from disk. The selection logic is a
// FAITHFUL, line-for-line port of the desktop engine — do not "improve" it.
//
// The only impurity is the caller-supplied `now` (= Date.now()), which is always
// threaded in explicitly so this file stays deterministic and testable.

// ---------- Constants (identical to ../src/main.js) ----------
export const DAY_MS = 86400000;
export const LEVELS = ["A1", "A2", "B1", "B2", "B2+"];
export const LEVEL_RANK = { A1: 0, A2: 1, B1: 2, B2: 3, "B2+": 4 };
export const DEFAULT_TENSE_ROTATION = ["present", "past", "future", "present", "modal", "conditional", "perfect", "present"];
export const TENSE_BUCKET_LABELS = {
  present: "present",
  past: "past",
  future: "future",
  modal: "modal",
  conditional: "would/if",
  perfect: "perfect",
  mixed: "mixed",
};

// ---------- Date helper (identical to source) ----------
export function dateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Effective config (= src loadConfig(lang), from a fetched raw config) ----------
// rawCfg is the parsed /config.json object. The language block overlays the globals,
// so schedule / target level / tense rotation / voice are all per-language.
export function effectiveConfig(rawCfg, lang) {
  const cfg = rawCfg || {};
  const langs = cfg.languages || {};
  const L = (lang && langs[lang]) || {};
  const sc = L.schedule || cfg.schedule || {};
  const srs = cfg.srs || {};
  const drill = cfg.drill || {};
  const t = { ...(cfg.tts || {}), ...(L.tts || {}) }; // per-language voiceId overrides global
  return {
    lang: lang || cfg.activeLanguage || "en",
    schedule: {
      days: Array.isArray(sc.days) ? sc.days : [1, 2, 3, 4, 5],
      startHour: sc.startHour ?? 10,
      endHour: sc.endHour ?? 17,
      everyMinutes: Number(sc.everyMinutes) || 60,
    },
    sentencesPerRun: Number(cfg.sentencesPerRun) || 10,
    autoAdvanceMs: cfg.autoAdvanceMs === undefined ? 0 : Number(cfg.autoAdvanceMs) || 0,
    popupOnStart: cfg.popupOnStart === true,
    drill: {
      repeatTarget: Number(drill.repeatTarget) || 10,
      tenseRotation:
        Array.isArray(L.tenseRotation) && L.tenseRotation.length
          ? L.tenseRotation
          : Array.isArray(drill.tenseRotation) && drill.tenseRotation.length
          ? drill.tenseRotation
          : DEFAULT_TENSE_ROTATION,
      targetLevel: L.targetLevel || drill.targetLevel || "B2",
    },
    srs: {
      enabled: srs.enabled !== false,
      newPerSession: Number(srs.newPerSession) || 10,
      intervalsDays: Array.isArray(srs.intervalsDays) ? srs.intervalsDays : [0, 1, 3, 7, 16, 35, 90],
    },
    tts: {
      enabled: t.enabled !== false,
      apiKey: t.apiKey || "",
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

// ---------- Tense bucketing (identical) ----------
export function tenseBucket(tense = "", pattern = "") {
  const hay = `${tense} ${pattern}`.toLowerCase();
  if (/conditional|hypothetical|supposing|if i were|if .* would|would have|had i known|weren't for|provided that|assuming that|as long as/.test(hay)) return "conditional";
  if (/past|used to|did you|didn't|were you|wasn't|went|saw|had to|in hindsight|looking back|dawned|wish i had|if only i had|should never have|paved the way/.test(hay)) return "past";
  if (/present[- ]perfect|perfect continuous|have you ever|i've|haven't .* yet|has far-reaching/.test(hay)) return "perfect";
  if (/future|will|going to|matter of time|chances are|every chance/.test(hay)) return "future";
  if (/modal|should|could|can|can't|might|must|would you mind|had better|i'd like|i'd love/.test(hay)) return "modal";
  if (/mixed|whereas|although|even though|despite|while/.test(hay)) return "mixed";
  return "present";
}

// ---------- Flatten sentences over a passed sentences.json (= src flattenSentences) ----------
// sentencesJson = { groups: [ { level, pattern, tense, tenseBucket?, sentences: [...] } ] }
// id = "<groupIndex>:<sentenceIndex>". Same fields the desktop engine produces.
export function flattenSentences(sentencesJson) {
  const data = sentencesJson || { groups: [] };
  const groups = data.groups || [];
  const all = [];
  groups.forEach((g, gi) => {
    const bucket = g.tenseBucket || tenseBucket(g.tense, g.pattern);
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

// ---------- Grouping (identical) ----------
export function groupSentences(all) {
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

// ---------- Schedule / rotation helpers (identical) ----------
export function slotIndexFor(ts, schedule) {
  const d = new Date(ts);
  const startMin = schedule.startHour * 60;
  const every = Math.max(1, Number(schedule.everyMinutes) || 60);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, Math.floor((nowMin - startMin) / every));
}

export function targetTenseBucket(ts, cfg) {
  const rotation = cfg.drill.tenseRotation || DEFAULT_TENSE_ROTATION;
  return rotation[slotIndexFor(ts, cfg.schedule) % rotation.length] || "present";
}

export function relatedBuckets(bucket) {
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

// ---------- Level helpers (identical) ----------
export function currentLevel(all, srs) {
  const present = LEVELS.filter((level) => all.some((s) => s.level === level));
  return present.find((level) => all.some((s) => s.level === level && !srs[s.id])) || present[present.length - 1] || "A2";
}

function targetLevelRank(cfg) {
  return LEVEL_RANK[cfg.drill.targetLevel] ?? LEVEL_RANK.B2;
}

export function eligibleForTarget(s, cfg) {
  return (LEVEL_RANK[s.level] ?? LEVEL_RANK.A2) <= targetLevelRank(cfg);
}

// ---------- Sort comparators (identical) ----------
export function sortCurriculum(a, b) {
  return a.groupIndex - b.groupIndex || a.sentenceIndex - b.sentenceIndex;
}

export function oldestSeenFirst(srs) {
  return (a, b) => (srs[a.id]?.last || 0) - (srs[b.id]?.last || 0) || sortCurriculum(a, b);
}

export function oldestGroupFirst(srs) {
  return (a, b) => {
    const oldestA = Math.min(...a.sentences.filter((s) => srs[s.id]).map((s) => srs[s.id].last || 0));
    const oldestB = Math.min(...b.sentences.filter((s) => srs[s.id]).map((s) => srs[s.id].last || 0));
    return oldestA - oldestB || a.groupIndex - b.groupIndex;
  };
}

export function sortDueFirst(srs) {
  return (a, b) => (srs[a.id]?.due || 0) - (srs[b.id]?.due || 0) || sortCurriculum(a, b);
}

// ---------- Focus group selection — the crown jewel (identical) ----------
export function chooseFocusGroup(groups, srs, level, bucket, now, sessionSize) {
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

// ---------- Build a session (= src buildSession) ----------
// sentencesJson = the fetched sentences.json; cfg = effectiveConfig(...);
// progress = { srs, stats }; now = Date.now() (caller-supplied).
export function buildSession(sentencesJson, cfg, progress, now) {
  const all = flattenSentences(sentencesJson);
  const eligible = all.filter((s) => eligibleForTarget(s, cfg));
  const prog = progress || { srs: {} };
  const srs = prog.srs || {};
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

// ---------- Record a graded result (= src recordResult) ----------
// Mutates AND returns progress so the caller can persist it to localStorage.
export function recordResult(progress, cfg, id, grade, now) {
  const intervals = cfg.srs.intervalsDays;
  const prog = progress || {};
  prog.srs = prog.srs || {};
  prog.stats = prog.stats || { byDay: {}, totalDone: 0, totalSkipped: 0, streak: 0, lastDoneDate: null };
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
  return prog;
}

// ---------- Slots per day (identical) ----------
export function slotsPerDay(cfg) {
  const s = cfg.schedule;
  return Math.max(1, Math.floor(((s.endHour - s.startHour) * 60) / s.everyMinutes) + 1);
}

// ---------- Stats summary (= src statsSummary) ----------
// reg = { code, label, flag } for the active language (injected; replaces languageRegistry()).
export function statsSummary(sentencesJson, cfg, progress, reg, now) {
  const prog = progress || {};
  const all = flattenSentences(sentencesJson);
  const lang = cfg.lang;
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
  let current = presentLevels.find((l) => perLevel[l].learned < perLevel[l].total) || presentLevels[presentLevels.length - 1] || "A1";
  const cl = perLevel[current];
  const ci = presentLevels.indexOf(current);
  const nextLevel = ci >= 0 && ci < presentLevels.length - 1 ? presentLevels[ci + 1] : null;
  const levelRemaining = Math.max(0, cl.total - cl.learned);
  const levelPct = cl.total ? Math.round((cl.learned / cl.total) * 100) : 100;
  const newPerDay = Math.max(cfg.sentencesPerRun, cfg.srs.newPerSession || 1) * slotsPerDay(cfg);
  const daysToNext = newPerDay > 0 ? Math.ceil(levelRemaining / newPerDay) : null;

  // Timing.
  const tm = (prog.stats && prog.stats.timing) || { totalMs: 0, sessions: 0, totalSentences: 0 };
  const avgSessionMs = tm.sessions ? Math.round(tm.totalMs / tm.sessions) : 0;
  const avgPerSentenceMs = tm.totalSentences ? Math.round(tm.totalMs / tm.totalSentences) : 0;

  const registry = reg || { code: lang, label: lang.toUpperCase(), flag: "" };

  return {
    language: { code: lang, label: registry.label, flag: registry.flag },
    streak: (prog.stats && prog.stats.streak) || 0,
    learned,
    total: all.length,
    dueNow,
    todayDone: today.done,
    todaySkipped: today.skipped,
    todaySessions: today.sessions || 0,
    targetSessions: slotsPerDay(cfg),
    totalDone: (prog.stats && prog.stats.totalDone) || 0,
    totalSkipped: (prog.stats && prog.stats.totalSkipped) || 0,
    level: { current, next: nextLevel, pct: levelPct, learned: cl.learned, total: cl.total, remaining: levelRemaining, daysToNext },
    timing: { avgSessionMs, avgPerSentenceMs, sessions: tm.sessions },
  };
}

// ---------- Finish-session timing (= src ipc "finish-session") ----------
// Mutates AND returns progress; caller persists. durationMs/count from the trainer.
export function finishSessionStats(progress, durationMs, count, now) {
  const prog = progress || {};
  prog.stats = prog.stats || { byDay: {}, totalDone: 0, totalSkipped: 0, streak: 0, lastDoneDate: null };
  const tm = prog.stats.timing || { totalMs: 0, sessions: 0, totalSentences: 0 };
  tm.totalMs += Math.max(0, Number(durationMs) || 0);
  tm.sessions += 1;
  tm.totalSentences += Math.max(0, Number(count) || 0);
  prog.stats.timing = tm;
  prog.stats.lastSession = { durationMs: Number(durationMs) || 0, count: Number(count) || 0, at: now };
  // Count one completed session for TODAY (drives the "sessions today X / Y" stat).
  prog.stats.byDay = prog.stats.byDay || {};
  const d = dateStr(now);
  prog.stats.byDay[d] = prog.stats.byDay[d] || { done: 0, skipped: 0 };
  prog.stats.byDay[d].sessions = (prog.stats.byDay[d].sessions || 0) + 1;
  return prog;
}
