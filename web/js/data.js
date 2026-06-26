// ENGLESY Web — data.js  [browser fetch]
// Read-only loaders for app config, language list, sentences, and seed progress.
// All network failures throw with a clear, actionable message; loadSeedProgress
// is the one exception — a 404 is a normal "no seed" signal and yields null.

import { CONFIG } from './config.js';

// --- internal fetch helper ----------------------------------------------------
// Performs a fetch and returns the parsed JSON. On a non-OK response (other than
// the optional allow404 case) or a transport error, throws an Error whose message
// names the resource so the integrator can surface it directly.
async function fetchJson(url, { label, allow404 = false } = {}) {
  const what = label || url;
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    // Network-level failure (offline, DNS, CORS, server down, etc.).
    throw new Error(
      `Не удалось загрузить ${what} (${url}): сеть недоступна. ${err && err.message ? err.message : err}`
    );
  }
  if (allow404 && res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Не удалось загрузить ${what}: HTTP ${res.status} ${res.statusText} (${url}).`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(
      `Повреждённые данные для ${what} (${url}): не удалось разобрать JSON. ${err && err.message ? err.message : err}`
    );
  }
}

// loadAppConfig(): fetch the raw config object from CONFIG.configUrl.
export async function loadAppConfig() {
  const cfg = await fetchJson(CONFIG.configUrl, { label: 'конфигурацию приложения' });
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`Конфигурация приложения пуста или имеет неверный формат (${CONFIG.configUrl}).`);
  }
  return cfg;
}

// loadLanguages(): from the app config, derive the enabled languages as
// [{ code, label, flag }], preserving config insertion order. Falls back to the
// language code for a missing label and an empty string for a missing flag.
export async function loadLanguages() {
  const cfg = await loadAppConfig();
  const langs = (cfg && cfg.languages && typeof cfg.languages === 'object') ? cfg.languages : {};
  const out = [];
  for (const code of Object.keys(langs)) {
    const entry = langs[code] || {};
    if (entry.enabled === false) continue; // explicitly disabled → skip
    out.push({
      code,
      label: typeof entry.label === 'string' && entry.label ? entry.label : code,
      flag: typeof entry.flag === 'string' ? entry.flag : '',
    });
  }
  return out;
}

// loadSentences(lang): fetch the curriculum sentences for a language.
export async function loadSentences(lang) {
  if (!lang) throw new Error('loadSentences: язык не указан.');
  const url = `${CONFIG.dataBase}/languages/${encodeURIComponent(lang)}/sentences.json`;
  const json = await fetchJson(url, { label: `предложения для «${lang}»` });
  if (!json || !Array.isArray(json.groups)) {
    throw new Error(`Неверный формат предложений для «${lang}»: ожидался объект с массивом groups (${url}).`);
  }
  return json;
}

// loadSeedProgress(lang): fetch the bundled seed progress for a language.
// Returns the parsed progress object, or null when no seed exists (HTTP 404).
export async function loadSeedProgress(lang) {
  if (!lang) throw new Error('loadSeedProgress: язык не указан.');
  const url = `${CONFIG.dataBase}/languages/${encodeURIComponent(lang)}/progress.json`;
  return fetchJson(url, { label: `начальный прогресс для «${lang}»`, allow404: true });
}
