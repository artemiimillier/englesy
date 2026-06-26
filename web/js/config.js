// ENGLESY Web — config.js  [PURE — no DOM, no browser globals at import time]
// Static configuration + gesture mapping. All values are plain data / pure functions.

export const CONFIG = {
  mediapipe: {
    visionUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18',
    wasmUrl:   'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm',
    modelUrl:  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    numHands: 2,
  },
  gesture: { confidenceThreshold: 0.55, holdMs: 320 }, // удерживать жест holdMs мс выше порога
  strictHand: true,   // требовать правильную руку (Swap/Toggle меняет на лету)
  // Коррекция СТОРОНЫ руки из MediaPipe. Видео всегда показывается как селфи (зеркально);
  // этот флаг — только про метку Left/Right. Для большинства фронталок верно false
  // (рука не переворачивается). Кнопка ⇄ и localStorage переопределяют на лету.
  mirror: false,
  dataBase: '/data',  // serve.js маппит /data/* → repo data/*
  configUrl: '/config.json', // serve.js маппит /config.json → repo config.json
};

// Имена жестов из встроенной модели MediaPipe Gesture Recognizer:
export const GESTURE = { THUMB_UP: 'Thumb_Up', FIST: 'Closed_Fist' };

// Сборка подсказки по жесту/руке.
function handCue(gesture, hand, emoji) {
  const ru = hand === 'Left' ? 'ЛЕВАЯ' : 'ПРАВАЯ';
  return { gesture, hand, key: hand === 'Left' ? 'left' : 'right', label: `${emoji} — ${ru} рука` };
}

// Маппинг чередуется КАЖДОЕ предложение, чтобы паттерн не был монотонным:
//   чётное предложение (0,2,…): палец вверх = ЛЕВАЯ, кулак = ПРАВАЯ
//   нечётное предложение (1,3,…): палец вверх = ПРАВАЯ, кулак = ЛЕВАЯ
// Внутри предложения слова чередуются: чётный индекс слова → палец вверх, нечётный → кулак.
export function expectedFor(i, sentenceIndex) {
  const sEven = ((sentenceIndex || 0) % 2) === 0;
  const thumbHand = sEven ? 'Left' : 'Right';
  const fistHand = sEven ? 'Right' : 'Left';
  return (i % 2 === 0)
    ? handCue(GESTURE.THUMB_UP, thumbHand, '👍 Палец вверх')
    : handCue(GESTURE.FIST, fistHand, '✊ Кулак');
}

// Фаза повторения: всё время показываем КУЛАК; рука кулака чередуется по предложениям
// (чётное предложение → правый кулак, нечётное → левый кулак).
export function repeatExpected(sentenceIndex) {
  const sEven = ((sentenceIndex || 0) % 2) === 0;
  return handCue(GESTURE.FIST, sEven ? 'Right' : 'Left', '✊ Кулак');
}

// Рука кулака для предложения (для подписи фазы повторения).
export function fistHandFor(sentenceIndex) {
  return (((sentenceIndex || 0) % 2) === 0) ? 'Right' : 'Left';
}

// Переворачивает сторону руки (коррекция зеркала): 'Left' ↔ 'Right'.
export function flipHand(h) {
  return h === 'Left' ? 'Right' : 'Left';
}
