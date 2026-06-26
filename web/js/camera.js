// js/camera.js
// Запрашивает камеру И микрофон одним getUserMedia (оба промпта).
// Привязывает видеопоток к videoEl, проигрывает, затем останавливает аудио-треки,
// чтобы микрофоном владел SpeechRecognition (право доступа уже выдано).
// Возвращает { stream }. Бросает Error с понятным человекочитаемым .message при отказе/отсутствии устройства.

export async function startCamera(videoEl) {
  if (!videoEl) {
    throw new Error('Внутренняя ошибка: не передан элемент <video>.');
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('Браузер не поддерживает доступ к камере (getUserMedia). Откройте через localhost в Chrome/Edge.');
  }

  const videoConstraints = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

  let stream;
  try {
    // Happy path: one prompt for camera + mic.
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
  } catch (err) {
    // The COMBINED request often fails only because the MICROPHONE is busy/denied (Wispr Flow,
    // Loom, Zoom, Telegram… holding it) — which would otherwise also kill the camera. Retry with
    // VIDEO ONLY so you still see yourself and gestures work; voice just won't until the mic frees.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
    } catch (err2) {
      // Camera genuinely unavailable (denied / no device / truly busy).
      throw mapMediaError(err2);
    }
  }

  try {
    videoEl.srcObject = stream;
    // Зеркальное HUD-видео нуждается в этих атрибутах для автозапуска без звука.
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    await videoEl.play();
  } catch (err) {
    // Если прикрепить/проиграть не вышло — освобождаем все треки, чтобы не висела камера.
    stopAllTracks(stream);
    throw new Error('Не удалось запустить видео с камеры. Попробуйте перезагрузить страницу.');
  }

  // Микрофоном должен владеть SpeechRecognition — освобождаем аудио-треки,
  // сохранив выданное пользователем разрешение на микрофон.
  try {
    const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    audioTracks.forEach((track) => {
      try {
        track.stop();
      } catch (_) {
        /* игнорируем: трек уже мог завершиться */
      }
      try {
        stream.removeTrack(track);
      } catch (_) {
        /* removeTrack может быть недоступен — не критично */
      }
    });
  } catch (_) {
    /* отсутствие аудио-треков не мешает работе видео */
  }

  return { stream };
}

function mapMediaError(err) {
  const name = err && err.name ? err.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new Error('Доступ к камере/микрофону запрещён. Разрешите доступ в браузере и перезагрузите страницу.');
  }

  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('Камера или микрофон не найдены. Подключите устройство и перезагрузите страницу.');
  }

  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new Error('Камера или микрофон заняты другим приложением. Закройте его и повторите.');
  }

  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return new Error('Камера не поддерживает требуемые параметры видео. Попробуйте другое устройство.');
  }

  const detail = err && err.message ? ` (${err.message})` : '';
  return new Error(`Не удалось получить доступ к камере/микрофону${detail}.`);
}

function stopAllTracks(stream) {
  try {
    const tracks = stream && stream.getTracks ? stream.getTracks() : [];
    tracks.forEach((track) => {
      try {
        track.stop();
      } catch (_) {
        /* no-op */
      }
    });
  } catch (_) {
    /* no-op */
  }
}
