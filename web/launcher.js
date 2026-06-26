// web/launcher.js — ENGLESY auto-popup daemon for the browser-first app.
//
// Restores the "it opens itself at the right time" feature we had in the Electron
// tray, but for the browser version: this process serves the app AND, per the
// per-language schedule in config.json, opens the trainer in Chrome at each slot.
//
//   node web/launcher.js            → serve + schedule, run forever (use under launchd)
//   node web/launcher.js --now      → also pop the browser once right now
//   node web/launcher.js --now en   → pop a specific language now (no long-running schedule kept)
//
// Open in Chrome (voice recognition needs Chrome); falls back to the default browser.
// Built-ins only.

'use strict';

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const serve = require('./serve.js');

const REPO_ROOT = serve.REPO_ROOT || path.resolve(__dirname, '..');
const PORT = serve.PORT || 8000;
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const LANG_DIR = path.join(REPO_ROOT, 'data', 'languages');
const DAY_MS = 86400000;

const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 16, everyMinutes: 60 };

const timers = {};   // lang -> timeout
const nextAt = {};   // lang -> ts

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}

// Enabled languages that actually have data on disk (mirrors the Electron registry).
function languages(cfg) {
  const langs = (cfg && cfg.languages) || { en: {} };
  return Object.keys(langs)
    .filter((code) => langs[code] && langs[code].enabled !== false)
    .filter((code) => fs.existsSync(path.join(LANG_DIR, code, 'sentences.json')));
}

function scheduleFor(cfg, lang) {
  const L = (cfg.languages && cfg.languages[lang]) || {};
  const s = L.schedule || cfg.schedule || {};
  return {
    days: Array.isArray(s.days) ? s.days : DEFAULT_SCHEDULE.days,
    startHour: s.startHour != null ? s.startHour : DEFAULT_SCHEDULE.startHour,
    endHour: s.endHour != null ? s.endHour : DEFAULT_SCHEDULE.endHour,
    everyMinutes: Number(s.everyMinutes) || DEFAULT_SCHEDULE.everyMinutes,
  };
}

// Next scheduled slot strictly after fromTs (ported verbatim from src/main.js nextSlot).
function nextSlot(fromTs, schedule) {
  const from = new Date(fromTs);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const base = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, 0, 0, 0, 0);
    if (!schedule.days.includes(base.getDay())) continue;
    const startMin = schedule.startHour * 60;
    const endMin = schedule.endHour * 60;
    for (let m = startMin; m <= endMin; m += schedule.everyMinutes) {
      const slot = new Date(base.getTime() + m * 60000);
      if (slot.getTime() > fromTs) return slot.getTime();
    }
  }
  return fromTs + DAY_MS;
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `сегодня ${hm}` : `${days[d.getDay()]} ${hm}`;
}

// Pop the trainer in Chrome (fallback: default browser). macOS `open`; basic *nix/win fallback.
function openBrowser(lang) {
  const url = `http://localhost:${PORT}/?lang=${encodeURIComponent(lang || '')}&auto=1`;
  const platform = process.platform;
  let primary;
  let fallback;
  if (platform === 'darwin') {
    primary = `open -a "Google Chrome" "${url}"`;
    fallback = `open "${url}"`;
  } else if (platform === 'win32') {
    primary = `start chrome "${url}"`;
    fallback = `start "" "${url}"`;
  } else {
    primary = `google-chrome "${url}" || chromium "${url}"`;
    fallback = `xdg-open "${url}"`;
  }
  console.log(`[ENGLESY] открываю тренажёр (${lang || 'default'}): ${url}`);
  exec(primary, (err) => {
    if (err && fallback) exec(fallback, () => { /* best effort */ });
  });
}

function scheduleLang(cfg, lang) {
  if (timers[lang]) clearTimeout(timers[lang]);
  const sched = scheduleFor(cfg, lang);
  nextAt[lang] = nextSlot(Date.now(), sched);
  const delay = Math.max(1000, nextAt[lang] - Date.now());
  // setTimeout caps ~24.8 days; our delays are always < 8 days.
  timers[lang] = setTimeout(() => {
    openBrowser(lang);
    scheduleLang(readConfig(), lang); // re-read config each cycle so edits take effect
  }, delay);
}

function scheduleAll() {
  const cfg = readConfig();
  const langs = languages(cfg);
  // Drop timers for languages no longer enabled.
  for (const code of Object.keys(timers)) {
    if (!langs.includes(code)) { clearTimeout(timers[code]); delete timers[code]; delete nextAt[code]; }
  }
  for (const code of langs) scheduleLang(cfg, code);
  printSchedule(langs);
}

function printSchedule(langs) {
  console.log('[ENGLESY] расписание авто-запуска:');
  if (!langs.length) { console.log('   (нет включённых языков с данными)'); return; }
  for (const code of langs) {
    console.log(`   ${code}: следующее — ${nextAt[code] ? fmtWhen(nextAt[code]) : '…'}`);
  }
}

// ---- main -------------------------------------------------------------------
const args = process.argv.slice(2);
const now = args.includes('--now');
const nowLangArg = args.find((a) => !a.startsWith('-'));

serve.start(PORT, () => {
  const cfg = readConfig();
  if (now) {
    // Manual launch: pop the browser immediately (chosen lang or the active one).
    const chosen = nowLangArg || cfg.activeLanguage || languages(cfg)[0] || 'en';
    setTimeout(() => openBrowser(chosen), 400);
  }
  scheduleAll();
  // Re-evaluate the schedule hourly as a safety net (covers clock changes / config edits).
  setInterval(scheduleAll, 60 * 60 * 1000);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
