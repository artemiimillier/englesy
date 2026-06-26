// src/menubar.js — ENGLESY menu-bar launcher (Electron, tray only — no window).
//
// Brings back the macOS menu-bar icon for the browser-first app: click to start a
// session now, see the next scheduled time, and the trainer opens in CHROME (where
// camera gestures + voice work). Also auto-opens at the scheduled slots.
//
// Run:  npm run menubar          (icon appears in the menu bar)
// Auto-start at login: install com.englesy.menubar.plist (see that file).
//
// It serves the web app on :8000 itself (reusing web/serve.js) unless something is
// already serving there (e.g. a headless launcher) — then it just reuses it.

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LANG_DIR = path.join(ROOT, 'data', 'languages');
const PORT = Number(process.env.PORT) || 8000;
const URL_BASE = `http://localhost:${PORT}`;
const DAY_MS = 86400000;
const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 16, everyMinutes: 60 };

let tray = null;
const timers = {};
const nextAt = {};

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}

function languages(cfg) {
  const langs = (cfg && cfg.languages) || { en: {} };
  return Object.keys(langs)
    .filter((c) => langs[c] && langs[c].enabled !== false)
    .filter((c) => fs.existsSync(path.join(LANG_DIR, c, 'sentences.json')))
    .map((c) => ({ code: c, label: langs[c].label || c.toUpperCase(), flag: langs[c].flag || '' }));
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

// Next scheduled slot strictly after fromTs (same logic as src/main.js / launcher.js).
function nextSlot(fromTs, sch) {
  const from = new Date(fromTs);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const base = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, 0, 0, 0, 0);
    if (!sch.days.includes(base.getDay())) continue;
    for (let m = sch.startHour * 60; m <= sch.endHour * 60; m += sch.everyMinutes) {
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

// Open the trainer in Chrome (voice needs Chrome); fall back to the default browser.
function openTrainer(lang) {
  const url = `${URL_BASE}/?lang=${encodeURIComponent(lang || '')}&auto=1`;
  exec(`open -a "Google Chrome" "${url}"`, (err) => {
    if (err) exec(`open "${url}"`, () => { /* best effort */ });
  });
}

// Ensure something is serving on :8000. If not, start web/serve.js in-process.
function ensureServer() {
  const req = http.get(`${URL_BASE}/`, (res) => { res.resume(); /* already up */ });
  req.on('error', () => {
    try { require(path.join(ROOT, 'web', 'serve.js')).start(PORT); }
    catch (e) { console.error('[menubar] не удалось поднять сервер:', e && e.message); }
  });
  req.setTimeout(900, () => { try { req.destroy(); } catch (_) { /* ignore */ } });
}

function scheduleLang(cfg, lang) {
  if (timers[lang]) clearTimeout(timers[lang]);
  const sch = scheduleFor(cfg, lang);
  nextAt[lang] = nextSlot(Date.now(), sch);
  const delay = Math.max(1000, nextAt[lang] - Date.now());
  timers[lang] = setTimeout(() => {
    openTrainer(lang);
    scheduleLang(readConfig(), lang);
    buildMenu();
  }, delay);
}

function scheduleAll() {
  const cfg = readConfig();
  const langs = languages(cfg).map((l) => l.code);
  for (const code of Object.keys(timers)) {
    if (!langs.includes(code)) { clearTimeout(timers[code]); delete timers[code]; delete nextAt[code]; }
  }
  for (const code of langs) scheduleLang(cfg, code);
  buildMenu();
}

function buildMenu() {
  if (!tray) return;
  const cfg = readConfig();
  const langs = languages(cfg);
  const items = [];

  if (!langs.length) {
    items.push({ label: 'Нет включённых языков', enabled: false });
  } else {
    for (const { code, label, flag } of langs) {
      items.push({ label: `${flag} ${label} — практика сейчас`, click: () => openTrainer(code) });
      items.push({ label: `      следующее: ${nextAt[code] ? fmtWhen(nextAt[code]) : '…'}`, enabled: false });
    }
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Открыть тренажёр',
    click: () => openTrainer((cfg.activeLanguage) || (langs[0] && langs[0].code) || 'en'),
  });
  items.push({ label: 'Сбросить расписание', click: () => scheduleAll() });
  items.push({ type: 'separator' });
  items.push({ label: 'Выход', click: () => app.quit() });

  tray.setContextMenu(Menu.buildFromTemplate(items));
  const flags = languages(cfg).map((l) => l.flag).join('') || '📕';
  tray.setToolTip('ENGLESY — клик для запуска');
  tray.setTitle(` ${flags}`);
}

// Single instance: a second launch just rebuilds the menu instead of a second icon.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => buildMenu());
  app.whenReady().then(() => {
    if (app.dock) app.dock.hide(); // menu-bar only, no Dock icon
    tray = new Tray(nativeImage.createEmpty());
    ensureServer();
    scheduleAll();          // also builds the menu
    setInterval(scheduleAll, 60 * 60 * 1000); // refresh next-run labels hourly
  });
  // Never quit when no windows are open — this app has no windows by design.
  app.on('window-all-closed', () => { /* keep running in the menu bar */ });
}
