# ENGLESY Web — Interface Contract (single source of truth)

The **best version** of ENGLESY: a browser-first PWA that fuses ENGLESY's real
spaced-repetition engine (SRS, curriculum, levels, stats, offline ElevenLabs audio cache)
with NEUROLING's three signature features:

1. **Camera gestures** — MediaPipe Gesture Recognizer drives word-by-word advance
   (👍 thumb-up LEFT for even word index, ✊ fist RIGHT for odd), with a live confidence
   meter and hold-to-confirm. Keyboard (←/→ or Ctrl) is always a fallback.
2. **Voice tracking** — Web Speech highlights spoken words green during the words phase,
   and counts repetitions during the repeat phase.
3. **Premium design** — NEUROLING's aurora/grid/glass/neon HUD, adapted to ENGLESY's
   curriculum, level bar, stats, two-phase drill and done screen.

Everything runs in the browser. No build step. Pure ES modules. Engine ported from
`../src/main.js` to run client-side; progress persists in `localStorage`; audio plays from
the bundled `data/tts-cache/` (works offline). Graceful degradation everywhere: no camera /
no mic / offline / no MediaPipe → keyboard drill still works perfectly.

NEUROLING reference source (read & adapt, don't reinvent the proven parts) lives at:
`/private/tmp/claude-501/-Users-artemiimiller-Documents-ENGLESY/684cd8eb-0e4b-4f9c-be8c-c174e0b7c90a/scratchpad/NEUROLING/`
— notably `js/gestures.js`, `js/camera.js`, `js/speech.js`, `js/tts.js`, `js/ui.js`, `styles.css`, `index.html`.

---

## Run / dev

Camera needs a secure context (https or **localhost**). A no-dependency static server
`web/serve.js` serves the app and the data:

```
node web/serve.js          # → http://localhost:8000  (open in Chrome)
```

`serve.js` maps `GET /data/*` → repo `data/*`, and everything else → `web/*`.
So the app fetches its own assets at `/...` and ENGLESY data at `/data/...`.
This keeps `web/` portable (deploy `web/` as site root with `data/` mounted at `/data`).

---

## Files

```
web/
  index.html              landing (hero) + trainer view + repeat + done + celebrate + toast
  styles.css              ported premium design + ENGLESY additions (levelbar, repeat dots, phonetics, bigword)
  manifest.webmanifest    PWA manifest (name ENGLESY, dark theme, icons optional)
  sw.js                   service worker: cache app shell for offline; network-first for /data
  js/
    config.js   CONFIG + expectedFor(step) + flipHand(h)   [PURE]
    data.js     loadConfig() / loadSentences(lang) via fetch  [browser fetch]
    store.js    localStorage progress (seed from bundled progress.json)  [browser]
    engine.js   ported SRS: buildSession/recordResult/statsSummary/...  [PURE except Date.now]
    audio.js    cache-key sha1 → fetch mp3; Web Speech / ElevenLabs fallback; prewarm  [browser]
    camera.js   startCamera(videoEl) — getUserMedia(video+audio)  [browser]  (port NEUROLING)
    gestures.js createGestureEngine(...) — MediaPipe wrapper  [browser]  (port NEUROLING)
    speech.js   createSpeechMatcher(...) — Web Speech word + phrase match  [browser]  (extend NEUROLING)
    trainer.js  createTrainer(...) — ENGLESY two-phase drill state machine  [PURE except timers]
    ui.js       createUI(...) — render everything from state  [browser/DOM]
    main.js     bootstrap + wiring  [browser]
  serve.js      no-dep static server (repo root) for local dev
```

`config.js`, `engine.js`, `trainer.js` must pass `node --check` as **ES modules** when renamed
`.mjs` for the check (no DOM/browser globals at import time; browser globals only inside functions).
The integration phase verifies this.

---

## Data shapes (fetched read-only from /data)

### /data/languages/<lang>/sentences.json
```jsonc
{ "groups": [ {
  "level": "A2", "pattern": "I want to ...", "tense": "present",
  "tenseBucket": "present",                 // optional; if absent, compute via tenseBucket(tense,pattern)
  "sentences": [ {
    "text": "I want to go home",
    "translation": "Я хочу пойти домой",
    "gloss": [ { "w":"I", "t":"я" }, { "w":"want", "t":"хочу", "p":"уонт" } ]  // p = russian-letter reading (optional, e.g. French)
  } ]
} ] }
```
Sentence id = `"<groupIndex>:<sentenceIndex>"`.

### /config.json  (served at /data/../config.json — fetch it at `/data/../config.json` OR copy: actually fetch `/config.json` is NOT served; fetch it at `/data/..`? NO.)
**Important:** `serve.js` ALSO maps `GET /config.json` → repo `config.json`. Fetch config at `/config.json`.
Shape (relevant parts): `{ activeLanguage, languages:{<lang>:{label,flag,enabled,targetLevel,tenseRotation,tts:{voiceId}}}, sentencesPerRun, drill:{repeatTarget,tenseRotation,targetLevel}, srs:{enabled,newPerSession,intervalsDays}, tts:{enabled,apiKey,voiceId,modelId,stability,similarityBoost,speed,repeatCount,gapMs} }`

### /data/languages/<lang>/progress.json  (initial SEED only; runtime state lives in localStorage)
`{ "srs": { "gi:si": { idx, reps, lapses, due, last } }, "stats": { byDay, totalDone, totalSkipped, streak, lastDoneDate, timing } }`

---

## DOM contract (index.html — exact ids/classes)

Landing overlay `#start-overlay` (NEUROLING hero, ENGLESY-branded):
- logo word "ENGLESY"; hero title; sub.
- **language picker** `#lang-picker` with `<button class="lang-opt" data-lang="en">🇬🇧 English</button>` etc (built from config at runtime; mark `.active`).
- `#start-btn` (START TRAINING). Optional `#eleven-key` password input (label "ELEVENLABS KEY · OPTIONAL — voice already bundled").
- method/compare section (gesture/voice/word-by-word/feedback) — keep NEUROLING's, translate copy to ENGLESY.

Trainer view `#trainer-view`:
- **Level bar** (top, spans grid): `#levelbar` → `#lang-badge`, `#level-cur`, `.level-track > #level-fill`, `#level-next`, `#level-info`, plus `#progress` ("3 / 10"), `#timer`, `#streak`, `#mic`.
- **Left panel** `.cam-panel`:
  - head: `[ LIVE · VISION ]`, `#cam-status` (load/permission status)
  - `#cam-wrap` → `#video` (mirrored), `#overlay-canvas`, `.cam-corners`, `.cam-scan`
  - `#gesture-hud` → `.gh-top`(`#expected-cue`, `#hand-detected`), `.meter-wrap`(`#gesture-meter > .meter-fill`, `#gesture-percent`), `#gesture-name`
  - `#hands` (ENGLESY L/R lit indicator): `#handL`, `#handR` — lit shows which hand/gesture is expected for current word
- **Right panel** `.phrase-side`:
  - `#pattern` (tense badge + pattern + NEW badge)
  - `#phrase-panel` → `#phrase-words` (`.word[data-i]` with child `.word-gloss` + `.word-text`), `#phonetic` (russian-letter subtitles, hidden when empty), `#phrase-translation`
  - `#bigword-wrap` → `#bigword` (current cumulative chunk, focal), `#bigword-phon`
  - `#status-line`
  - `.legend` (gesture rules: even word → 👍 left, odd → ✊ right)
  - `#repeat` (hidden during words): `.repeat-label` "Повтори вслух <span id=repeat-target>10</span>×", `#repeat-phrase`, `#repeat-phon`, `#repeat-dots`
  - `#controls` → `#replay-btn` (R), `#skip-btn` (S), `#strict-toggle`, `#swap-btn`
- `#done` (done screen, hidden)
- `#celebrate` (hidden), `#error-toast` (hidden), `#wordtip` (legacy hover tip — optional, gloss is inline now)

Word classes: `.word.hidden` (masked •••), `.word.revealed`, `.word.current` (pulse underline), `.word.spoken` (green glow). `#bigword.pop/.hit/.wrong` animations (port from ENGLESY styles).

---

## Module interfaces

### js/config.js  [PURE — no DOM]
```js
export const CONFIG = {
  mediapipe: {
    visionUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18',
    wasmUrl:   'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
    modelUrl:  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    numHands: 2,
  },
  gesture: { confidenceThreshold: 0.55, holdMs: 320 },
  strictHand: true,
  mirror: true,
  dataBase: '/data',
  configUrl: '/config.json',
};
export const GESTURE = { THUMB_UP: 'Thumb_Up', FIST: 'Closed_Fist' };
// Word index i is 0-based. EVEN index (0,2,4 = 1st,3rd word) → thumb-up LEFT; ODD → fist RIGHT.
export function expectedFor(i) {
  return (i % 2 === 0)
    ? { gesture: GESTURE.THUMB_UP, hand: 'Left',  key: 'left',  label: '👍 Палец вверх — ЛЕВАЯ рука' }
    : { gesture: GESTURE.FIST,     hand: 'Right', key: 'right', label: '✊ Кулак — ПРАВАЯ рука' };
}
export function flipHand(h){ return h === 'Left' ? 'Right' : 'Left'; }
```

### js/data.js  [browser fetch]
```js
// loadAppConfig(): fetch CONFIG.configUrl → returns the effective per-... raw config object.
// loadLanguages(): from config → [{code,label,flag}] for enabled langs.
// loadSentences(lang): fetch `${CONFIG.dataBase}/languages/${lang}/sentences.json` → {groups:[...]}.
// loadSeedProgress(lang): fetch `${CONFIG.dataBase}/languages/${lang}/progress.json` → progress|null (404 ok).
// All throw on hard network error with a clear message; loadSeedProgress returns null on 404.
export async function loadAppConfig() {}
export async function loadLanguages() {}
export async function loadSentences(lang) {}
export async function loadSeedProgress(lang) {}
```

### js/store.js  [browser localStorage]
```js
// Progress persistence. Key: `englesy:progress:<lang>`. On first access for a lang with no
// stored value, SEED from loadSeedProgress(lang) (so existing SRS history carries over).
// getProgress(lang) → {srs:{}, stats:{byDay:{},totalDone:0,totalSkipped:0,streak:0,lastDoneDate:null,timing:{totalMs:0,sessions:0,totalSentences:0}}}
// saveProgress(lang, progress) → persist.
// Also: getSetting(k,def)/setSetting(k,v) for ui prefs (selected lang, strictHand, apiKey) under `englesy:set:<k>`.
export async function getProgress(lang) {}
export function saveProgress(lang, progress) {}
export function getSetting(k, def) {}
export function setSetting(k, v) {}
```

### js/engine.js  [PURE port of ../src/main.js — keep logic IDENTICAL]
Port these functions verbatim, swapping Node fs/crypto for injected data:
`tenseBucket, slotIndexFor, targetTenseBucket, relatedBuckets, currentLevel, eligibleForTarget,
oldestSeenFirst, oldestGroupFirst, chooseFocusGroup, sortCurriculum, sortDueFirst,
flattenGroups, groupSentences, buildSession, recordResult, statsSummary, levelInfo`.
Signatures (data/config/progress passed in, NOT read from disk):
```js
export const LEVELS = ["A1","A2","B1","B2","B2+"];
export function effectiveConfig(rawCfg, lang) {}      // = src loadConfig(lang) shape, from fetched rawCfg
export function flattenSentences(sentencesJson) {}     // = src flattenSentences but over passed json (groups)
export function buildSession(sentencesJson, cfg, progress, now) {}   // = src buildSession; now = Date.now()
export function recordResult(progress, cfg, id, grade, now) {}       // mutate+return progress (= src recordResult)
export function statsSummary(sentencesJson, cfg, progress, reg, now) {} // = src statsSummary; reg={code,label,flag}
export function finishSessionStats(progress, durationMs, count, now) {} // update timing (= ipc finish-session)
```
**SOURCE TO PORT — copy the algorithm exactly from `../src/main.js` lines 158–464.**
Constants: `DAY_MS=86400000`, `LEVEL_RANK={A1:0,A2:1,B1:2,B2:3,"B2+":4}`,
`DEFAULT_TENSE_ROTATION=["present","past","future","present","modal","conditional","perfect","present"]`,
`TENSE_BUCKET_LABELS` same as source. `dateStr(ts)` same. Do NOT change selection logic — it is the crown jewel.

### js/audio.js  [browser]
Cache key MUST match the bundled files exactly. From `../generate-audio.js`:
`key = sha1_hex(`${voice}|${model}|${speed}|${stab}|${sim}|${text}`)` where the tts params are the
effective per-language tts (global `cfg.tts` overlaid with `cfg.languages[lang].tts`):
`voice=tts.voiceId, model=tts.modelId??"eleven_multilingual_v2", speed=tts.speed??0.85, stab=tts.stability??0.5, sim=tts.similarityBoost??0.8`.
Compute sha1 via `crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))` → hex.
```js
export function createAudio(rawCfg, lang) {
  // speakSentence(text): play `${dataBase}/tts-cache/<key>.mp3` repeatCount times (gapMs gaps), set #mic speaking.
  //   on 404 / no file: fallback to Web Speech speechSynthesis (en/fr voice by lang); never throw.
  // speakWord(text): quick single play — cached mp3 if present else Web Speech. (used on word reveal, optional)
  // stop(): cancel playback + speechSynthesis.cancel(). returns {speakSentence,speakWord,stop,setApiKey}
}
```
If `cfg.tts.apiKey` (or pasted key) is set and a clip is uncached, may POST ElevenLabs to generate
(same body as generate-audio.js) — but NEVER block; fall back to Web Speech on any failure.
Mic indicator element `#mic`: text 🔊 + class `speaking` while audio plays, 🔇 if nothing available.

### js/camera.js  [browser]  — PORT NEUROLING js/camera.js verbatim (startCamera(videoEl)).

### js/gestures.js [browser] — PORT NEUROLING js/gestures.js verbatim
`createGestureEngine({videoEl,onResult,onStatus}) → {start,stop,setMirror}`; imports `{CONFIG,flipHand}` from config.js.
Graceful no-op engine if MediaPipe fails to load (offline) — app must keep working on keyboard.

### js/speech.js [browser] — EXTEND NEUROLING js/speech.js
Keep `createSpeechMatcher({onWordMatch,onTranscript,onStatus})` with `startForTarget(words)` (word highlight).
ADD a phrase-repeat mode for the repeat phase:
```js
// startForPhrase(fullText, onRep): listen continuously; each time the spoken transcript contains
// (fuzzily, ≥70% of) the target phrase's words in a window, fire onRep() once per utterance and reset.
// stop()/reset() as before. supported flag as before.
```
Both modes share one recognition instance; switching mode calls reset.

### js/trainer.js  [PURE except setTimeout]
ENGLESY two-phase drill over a built session. `onState(state)` on every change.
```js
// createTrainer({ session, cfg, onState, onReveal, onPhraseRepeatStart, onComplete, onAllComplete })
// session = engine.buildSession(...) → { focus, sentences:[{id,text,translation,gloss,pattern,tense,tenseLabel,level,isNew}] }
// state = {
//   si, total,                    // sentence index / count
//   words:string[], gloss, phon,  // current sentence split; phon[] = gloss[i].p reading
//   wi, revealedCount,            // word phase progress (revealedCount = wi+1 visible)
//   expected,                     // expectedFor(wi)
//   gestureProgress: 0..1,        // hold progress
//   spokenMask: boolean[],        // words highlighted by voice
//   phase: 'words'|'repeat'|'done',
//   repeatCount, repeatTarget,
//   pattern, tense, tenseLabel, level, isNew, translation, fullText,
//   lastDetected,
// }
// Methods:
//   start(): si=0, loadSentence()
//   loadSentence(): split words, wi=0, revealedCount=1, spokenMask=[], phase='words', expected=expectedFor(0); onReveal(word0, idx0, fullText, isFirst=true)
//   handleDetection({gesture,score,hand}): only in 'words'. If matches expected (gesture==exp.gesture && score>=thr && (!strictHand||hand==exp.hand)) accumulate hold via performance.now(); at holdMs → advanceWord(true)
//   pressDirection('left'|'right'): keyboard equivalent — if matches expected.key → advanceWord(true) else flag wrong (onState with a transient wrongFlash)
//   advanceWord(hit): wi++; if wi>=words.length → enterRepeat(); else revealedCount=wi+1, expected=expectedFor(wi), onReveal(word_wi, wi, ...)
//   notifyWordSpoken(i): spokenMask[i]=true (words phase only)
//   enterRepeat(): phase='repeat', repeatCount=0, repeatTarget=cfg.drill.repeatTarget||10, onPhraseRepeatStart(fullText)
//   tickRepeat(): repeatCount++; if >=repeatTarget → completeSentence('pass') after small delay
//   notifyPhraseSpoken(): same as one tickRepeat (voice-driven rep)
//   skip(): completeSentence('skip')
//   completeSentence(grade): onComplete(id, grade); si++; if si>=total → phase='done', onAllComplete(); else loadSentence()
//   setStrictHand(b), reset()
//   getState()
```
Gesture mapping note: word index `wi` 0-based; `expectedFor(wi)` (config.js): even→thumb-up LEFT, odd→fist RIGHT.

### js/ui.js  [browser/DOM]  — render from state; NO business logic
Adapt NEUROLING `js/ui.js` + add ENGLESY widgets. Functions:
```js
// createUI({config}) → {
//   buildLangPicker(langs, selected, onPick),
//   renderState(state),          // pattern, words(hidden/revealed/current/spoken+gloss), phonetic, translation, bigword(+phon), hands L/R lit, progress, repeat dots
//   setMeter({gesture,score,hand,expected,progress}),
//   drawLandmarks(landmarks, videoEl),
//   renderStats(stats),          // levelbar (lang badge, level cur→next, fill, info, streak)
//   setStatus(msg), setCamStatus(msg), showError(msg),
//   celebrate(), allDone(), showDone(statsSummaryObj, sessionMeta), reset(),
//   bindControls({onStart,onReplay,onSkip,onToggleStrict,onSwapHands,onApiKey,onPickLang}),
//   wordHoverTip(),              // hover word → gloss (inline .word-gloss handles it via CSS)
//   els
// }
```
Repeat dots: ENGLESY style — N numbered circles, grow in size, red→green as filled (hsl 0→120), `.current` outlined.
Done screen: ENGLESY layout (time, avg, per-sentence, today done/skipped, streak, level line). Port markup from `../src/renderer.js` finishSession().

### js/main.js  [browser]
Bootstrap order:
1. DOMContentLoaded → ui = createUI; load app config + languages; build lang picker (selected = stored or activeLanguage); bind controls.
2. On START: read selected lang + optional key. Load sentences(lang) + progress(lang). Build session via engine.buildSession. Create audio(rawCfg,lang). Create trainer(session,...). Render initial stats (statsSummary). Hide landing, show trainer.
3. Attempt camera: startCamera(video) → createGestureEngine → on each result: ui.setMeter + ui.drawLandmarks + trainer.handleDetection. If camera/MediaPipe fail → ui.setCamStatus('Камера недоступна — играй на клавишах ←/→') and continue (keyboard works).
4. Speech: createSpeechMatcher. trainer.onReveal → audio.speakWord(word) (and on first word audio.speakSentence(fullText)) + speech.startForTarget(revealed slice) (words phase). onPhraseRepeatStart → speech.startForPhrase(fullText, ()=>trainer.notifyPhraseSpoken()). speech.onWordMatch → trainer.notifyWordSpoken.
5. trainer.onState → ui.renderState. onComplete(id,grade) → progress=engine.recordResult(progress,cfg,id,grade,Date.now()); store.saveProgress(lang,progress); ui.renderStats(statsSummary). onAllComplete → finishSessionStats + ui.showDone.
6. Keyboard: ArrowLeft/ControlLeft → trainer.pressDirection('left'); ArrowRight/ControlRight → 'right'; Space → advance (no-hit); in repeat phase any key → trainer.tickRepeat(); R → replay; S → skip; Esc → back to landing.
7. Controls: replay→audio.speakSentence(current); skip→trainer.skip; strict→trainer.setStrictHand; swap→flip mirror→gestures.setMirror; apiKey→audio.setApiKey.
All wrapped so a thrown callback never breaks the loop; errors → ui.showError.

### web/serve.js  [node, no deps]
```
http server on PORT (env PORT || 8000). For GET:
  /                      → web/index.html
  /data/<p>              → repo ../data/<p>
  /config.json           → repo ../config.json
  /<p>                   → web/<p>
Content-Type by extension (html,css,js→text/javascript,json,mp3→audio/mpeg,webmanifest,svg,png).
404 on missing. No directory listing. Log requests minimally.
```

### web/manifest.webmanifest + web/sw.js
Manifest: name "ENGLESY", short_name "ENGLESY", display standalone, background/theme `#07080c`, start_url "/".
SW: cache app shell (index.html, styles.css, js/*.js, config.js) on install (cache-first);
network-first (fallback cache) for `/data/*` (so audio works offline once played). Keep it small & resilient.

---

## Design (styles.css)

Base = NEUROLING `styles.css` (reuse tokens, bg layers, panels, meter, words, celebrate, toast, responsive).
ADD ENGLESY widgets, matched to the same token system (`--violet/--mint/--coral/--accent`, `--mono/--sans`):
- `#levelbar` spanning the grid: lang badge pill, `--mint` current level, track + gradient fill (mint→accent), next level, info, `#streak` 🔥, `#timer` tabular-nums, `#mic`.
- `#hands` L/R circles: `.hand` neutral, `.hand.lit` glowing accent (left) / violet (right) to mirror which gesture is expected.
- `#bigword` focal current chunk (big, weight 800), `.pop/.hit(mint)/.wrong(shake)`; `#bigword-phon` gold reading.
- `#phonetic` gold russian-letter subtitles (hidden when empty).
- `#pattern .tense-badge` + `.new-badge`.
- `#repeat` + growing numbered `.dot` (red→green hsl), `.dot.current` outline, `.dot.on` filled.
- `#done` screen rows of stat cards (value `--accent`, label muted).
- `#lang-picker .lang-opt` pills (active = violet border/glow).
Keep Inter Tight + JetBrains Mono. Keep aurora/grid/noise/scanline/corners/celebrate. Perfectionist: shadows, blur, cubic-bezier. `prefers-reduced-motion` respected.

---

## Acceptance (Definition of Done)
1. `node web/serve.js` → open http://localhost:8000 in Chrome → landing renders (aurora HUD), pick language, START.
2. Camera+mic prompt; mirrored video with hand landmark overlay + live confidence meter.
3. Real ENGLESY curriculum sentence appears (from SRS buildSession), word-by-word, with tense badge, RU gloss on hover, translation, phonetic subtitles for FR.
4. Show 👍 left / ✊ fist right to advance each word (hold ~320ms); keyboard ←/→ also advances; wrong hand/key flashes.
5. Speaking the words highlights them green (Web Speech). Repeat phase: say the phrase (or press a key) 10× — dots fill red→green.
6. Sentence completion records SRS to localStorage; level bar + streak update; done screen shows time/avg/today/level.
7. Offline / no camera / no mic / no MediaPipe → no crash; keyboard drill + bundled audio still work.
8. Design is genuinely premium and cohesive end-to-end.
