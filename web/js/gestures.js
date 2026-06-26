// js/gestures.js
// MediaPipe GestureRecognizer wrapper (VIDEO mode).
// Loads the model from CONFIG, runs a requestAnimationFrame loop over videoEl,
// and emits { gesture, score, hand, landmarks } | null each frame via onResult.
//   gesture  : top gesture category name (e.g. 'Thumb_Up','Closed_Fist','None')
//   score    : 0..1 confidence of that top gesture
//   hand     : USER hand 'Left'|'Right' (mirror-aware: userHand = mirror ? flipHand(raw) : raw)
//   landmarks: that hand's normalized landmark array as [{x,y}, ...]
// The hand with the highest top-gesture score is chosen each frame.
// onStatus(msg) reports load progress.
//
// GRACEFUL FALLBACK: if MediaPipe import or model load fails (offline, blocked CDN, no WASM/GPU),
// createGestureEngine resolves to a no-op engine { start, stop, setMirror } so the rest of the
// app keeps running on keyboard. It never rejects on a MediaPipe failure.

import { CONFIG, flipHand } from './config.js';

export async function createGestureEngine({ videoEl, onResult, onStatus }) {
  const status = (msg) => {
    try { onStatus && onStatus(msg); } catch (_) { /* ignore status sink errors */ }
  };
  const emit = (payload) => {
    try { onResult && onResult(payload); } catch (_) { /* never let consumer throw into loop */ }
  };

  let recognizer = null;
  let running = false;
  let rafId = null;
  let lastVideoTime = -1;
  // Mirror flag — corrects raw handedness into the user's perspective.
  let mirror = (CONFIG && CONFIG.mirror !== undefined) ? !!CONFIG.mirror : true;

  // --- Load MediaPipe vision tasks from CDN (ESM) + create the recognizer ---
  try {
    status('Загрузка MediaPipe Vision…');
    const vision = await import(/* @vite-ignore */ CONFIG.mediapipe.visionUrl);
    const { GestureRecognizer, FilesetResolver } = vision;
    if (!GestureRecognizer || !FilesetResolver) {
      throw new Error('MediaPipe exports not found (GestureRecognizer/FilesetResolver).');
    }

    status('Инициализация WASM…');
    const filesetResolver = await FilesetResolver.forVisionTasks(CONFIG.mediapipe.wasmUrl);

    status('Загрузка модели жестов…');
    recognizer = await GestureRecognizer.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: CONFIG.mediapipe.modelUrl,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: (CONFIG.mediapipe && CONFIG.mediapipe.numHands) || 2,
    });

    status('Модель готова.');
  } catch (err) {
    status('Ошибка загрузки MediaPipe: ' + (err && err.message ? err.message : err));
    // Graceful fallback: return a no-op engine so the rest of the app can still run.
    return {
      start() { /* no recognizer available */ },
      stop() { /* nothing to stop */ },
      setMirror(m) { mirror = !!m; },
    };
  }

  // --- Per-frame processing: pick the hand with the best top gesture ---
  function processFrame() {
    if (!running) return;
    try {
      const now = performance.now();
      // Only run inference when the video advanced to a new frame and is playable.
      const ready =
        videoEl &&
        videoEl.readyState >= 2 &&
        videoEl.videoWidth > 0 &&
        videoEl.currentTime !== lastVideoTime;

      if (ready) {
        lastVideoTime = videoEl.currentTime;
        const result = recognizer.recognizeForVideo(videoEl, now);

        const gestures = (result && result.gestures) || [];
        const handednesses = (result && result.handednesses) || [];
        const allLandmarks = (result && result.landmarks) || [];

        if (!gestures.length) {
          emit(null);
        } else {
          // Find the hand index whose top gesture has the highest score.
          let bestIdx = -1;
          let bestScore = -1;
          for (let i = 0; i < gestures.length; i++) {
            const top = gestures[i] && gestures[i][0];
            if (top && typeof top.score === 'number' && top.score > bestScore) {
              bestScore = top.score;
              bestIdx = i;
            }
          }

          if (bestIdx < 0) {
            emit(null);
          } else {
            const top = gestures[bestIdx][0];
            const rawHandObj = handednesses[bestIdx] && handednesses[bestIdx][0];
            const rawHand = rawHandObj ? rawHandObj.categoryName : null; // 'Left' | 'Right'
            const userHand = rawHand ? (mirror ? flipHand(rawHand) : rawHand) : null;

            const rawPoints = allLandmarks[bestIdx] || [];
            const landmarks = rawPoints.map((p) => ({ x: p.x, y: p.y }));

            emit({
              gesture: top.categoryName,
              score: top.score,
              hand: userHand,
              landmarks,
            });
          }
        }
      }
    } catch (err) {
      // Never throw out of the loop — report once and keep going.
      status('Кадр пропущен: ' + (err && err.message ? err.message : err));
    } finally {
      if (running) {
        rafId = requestAnimationFrame(processFrame);
      }
    }
  }

  return {
    start() {
      if (running || !recognizer) return;
      running = true;
      lastVideoTime = -1;
      rafId = requestAnimationFrame(processFrame);
    },
    stop() {
      running = false;
      if (rafId !== null) {
        try { cancelAnimationFrame(rafId); } catch (_) { /* ignore */ }
        rafId = null;
      }
    },
    setMirror(m) {
      mirror = !!m;
    },
  };
}
