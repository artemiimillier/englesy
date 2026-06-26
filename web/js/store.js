// ENGLESY Web — store.js  [browser localStorage]
// Progress persistence + UI settings, backed by localStorage. On first access for
// a language with no stored progress, the engine's seed progress (bundled
// progress.json) is loaded so existing SRS history carries over. Every accessor is
// defensive: a missing/disabled/quota-full localStorage degrades to an in-memory
// fallback rather than throwing.

import { loadSeedProgress } from './data.js';

const PROGRESS_PREFIX = 'englesy:progress:';
const SETTING_PREFIX = 'englesy:set:';

// In-memory fallback used when localStorage is unavailable (private mode, quota,
// disabled storage). Keeps the app fully functional for the current session.
const memFallback = new Map();

// --- safe localStorage access -------------------------------------------------
function ls() {
  try {
    // Touch the API to confirm it is actually usable (some environments expose
    // window.localStorage but throw on access).
    const s = globalThis.localStorage;
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

function lsGet(key) {
  const s = ls();
  if (s) {
    try {
      const v = s.getItem(key);
      if (v !== null) return v;
    } catch {
      /* fall through to memory */
    }
  }
  return memFallback.has(key) ? memFallback.get(key) : null;
}

function lsSet(key, value) {
  // Always mirror into memory so reads stay consistent even if persistence fails.
  memFallback.set(key, value);
  const s = ls();
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    /* quota / disabled — memory fallback already holds the value */
  }
}

// --- default progress shape ---------------------------------------------------
// Fresh, empty progress matching the engine's expected shape.
function defaultProgress() {
  return {
    srs: {},
    stats: {
      byDay: {},
      totalDone: 0,
      totalSkipped: 0,
      streak: 0,
      lastDoneDate: null,
      timing: { totalMs: 0, sessions: 0, totalSentences: 0 },
    },
  };
}

// Normalize an arbitrary (possibly partial / legacy / seeded) progress object into
// the full default shape so downstream engine code can rely on every field.
function normalizeProgress(raw) {
  const base = defaultProgress();
  if (!raw || typeof raw !== 'object') return base;

  const srs = (raw.srs && typeof raw.srs === 'object') ? raw.srs : {};
  const stats = (raw.stats && typeof raw.stats === 'object') ? raw.stats : {};
  const timing = (stats.timing && typeof stats.timing === 'object') ? stats.timing : {};

  return {
    srs,
    stats: {
      byDay: (stats.byDay && typeof stats.byDay === 'object') ? stats.byDay : {},
      totalDone: Number.isFinite(stats.totalDone) ? stats.totalDone : 0,
      totalSkipped: Number.isFinite(stats.totalSkipped) ? stats.totalSkipped : 0,
      streak: Number.isFinite(stats.streak) ? stats.streak : 0,
      lastDoneDate: (typeof stats.lastDoneDate === 'string') ? stats.lastDoneDate : null,
      timing: {
        totalMs: Number.isFinite(timing.totalMs) ? timing.totalMs : 0,
        sessions: Number.isFinite(timing.sessions) ? timing.sessions : 0,
        totalSentences: Number.isFinite(timing.totalSentences) ? timing.totalSentences : 0,
      },
    },
  };
}

function progressKey(lang) {
  return PROGRESS_PREFIX + lang;
}

// getProgress(lang): async. Returns the stored progress for a language. On first
// access (no stored value), seeds from the bundled progress.json (via
// loadSeedProgress); if no seed exists or it fails to load, returns fresh empty
// progress. The result is always normalized to the full shape and persisted so the
// seed is captured locally going forward.
export async function getProgress(lang) {
  const key = progressKey(lang);

  const stored = lsGet(key);
  if (stored !== null) {
    try {
      return normalizeProgress(JSON.parse(stored));
    } catch {
      // Corrupted stored value — fall through to reseed rather than throw.
    }
  }

  // First access for this language: try to seed from the bundled progress.json.
  let seed = null;
  try {
    seed = await loadSeedProgress(lang);
  } catch {
    // Seed load failed (offline, server error). Start fresh; not fatal.
    seed = null;
  }

  const progress = normalizeProgress(seed);
  // Persist the seeded/empty baseline so subsequent loads are stable and offline.
  saveProgress(lang, progress);
  return progress;
}

// saveProgress(lang, progress): persist a progress object (serialized JSON).
// Sync. Never throws — a serialization or storage failure is swallowed (the
// in-memory mirror still holds the latest value for the session).
export function saveProgress(lang, progress) {
  try {
    const safe = normalizeProgress(progress);
    lsSet(progressKey(lang), JSON.stringify(safe));
  } catch {
    /* never let persistence break the drill loop */
  }
}

// --- UI settings --------------------------------------------------------------
// getSetting(k, def): read a UI preference; returns def when unset or unparsable.
export function getSetting(k, def) {
  const raw = lsGet(SETTING_PREFIX + k);
  if (raw === null) return def;
  try {
    return JSON.parse(raw);
  } catch {
    // Legacy / plain-string value — return as-is.
    return raw;
  }
}

// setSetting(k, v): write a UI preference (JSON-serialized). Never throws.
export function setSetting(k, v) {
  try {
    lsSet(SETTING_PREFIX + k, JSON.stringify(v));
  } catch {
    /* ignore persistence failures */
  }
}
