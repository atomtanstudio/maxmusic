/** Export MP4/WebM: cover art + scrolling lyrics + audio (Suno-style lyric video). */

function safeFilename(title) {
  return (title || 'track').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load cover art'));
    img.src = url;
  });
}

export function lyricDisplayLines(lyrics) {
  if (!lyrics?.trim()) return ['♪  ♪  ♪'];
  return lyrics.split('\n').map((l) => l.trim()).filter(Boolean);
}

function pickRecorderMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4',
  ];
  return candidates.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || null;
}

function renderLyricFrame(ctx, size, { coverImg, title, lines, progress, lineHeight }) {
  ctx.save();
  if (coverImg) {
    const s = Math.min(coverImg.width, coverImg.height);
    const sx = (coverImg.width - s) / 2;
    const sy = (coverImg.height - s) / 2;
    ctx.drawImage(coverImg, sx, sy, s, s, 0, 0, size, size);
  } else {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#3d3530');
    g.addColorStop(1, '#1a1816');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  ctx.fillStyle = 'rgba(18, 17, 16, 0.58)';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#ece6dc';
  ctx.font = '600 40px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((title || 'Untitled').slice(0, 42), size / 2, 88);

  const totalHeight = lines.length * lineHeight;
  const scroll = progress * (totalHeight + size * 0.9);
  const startY = size * 0.78 - scroll;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = startY + i * lineHeight;
    if (y < 130 || y > size + 50) continue;
    const isTag = /^\[[^\]]+\]$/.test(line);
    ctx.fillStyle = isTag ? '#d4926a' : 'rgba(236, 230, 220, 0.94)';
    ctx.font = isTag
      ? '600 26px "DM Sans", system-ui, sans-serif'
      : '400 34px "DM Sans", system-ui, sans-serif';
    const text = line.length > 52 ? `${line.slice(0, 51)}…` : line;
    ctx.fillText(text, size / 2, y);
  }
  ctx.restore();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Overall export job progress (0–1). Bar width and % in the message use the same value. */
const EXPORT_PHASE = {
  load: 0.06,
  prep: 0.14,
  renderStart: 0.14,
  renderEnd: 0.9,
  finalize: 0.96,
  done: 1,
};

function overallProgress(songFraction = 0) {
  const t = Math.min(1, Math.max(0, songFraction));
  return EXPORT_PHASE.renderStart + t * (EXPORT_PHASE.renderEnd - EXPORT_PHASE.renderStart);
}

function report(onProgress, message, progress) {
  if (!onProgress) return;
  if (typeof onProgress === 'function') {
    onProgress({ message, progress: progress ?? null });
  }
}

function reportPhase(onProgress, message, progress) {
  const p = Math.min(1, Math.max(0, progress));
  const pct = Math.round(p * 100);
  const label = message.includes('%') ? message : `${message} ${pct}%`;
  report(onProgress, label, p);
}

/**
 * @param {object} track
 * @param {(update: { message: string, progress: number|null }) => void} onProgress
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function exportLyricVideo(track, onProgress, opts = {}) {
  if (!track?.url) throw new Error('No audio URL for this track');
  const mime = pickRecorderMime();
  if (!mime) throw new Error('Video export is not supported in this browser');

  const signal = opts.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Lyric video cancelled');
  };

  reportPhase(onProgress, 'Loading audio…', EXPORT_PHASE.load);
  throwIfAborted();

  const audioRes = await fetch(track.url);
  if (!audioRes.ok) throw new Error('Could not fetch audio file');
  const audioData = await audioRes.arrayBuffer();

  const audioCtx = new AudioContext();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(audioData.slice(0));
  } catch {
    await audioCtx.close();
    throw new Error('Could not decode audio — try MP3 format');
  }

  const duration = audioBuffer.duration;
  if (!Number.isFinite(duration) || duration < 1) {
    await audioCtx.close();
    throw new Error('Audio is too short or duration is unknown');
  }

  const timeoutMs = opts.timeoutMs ?? Math.ceil(duration * 1000) + 45_000;
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; }, timeoutMs);

  try {
    reportPhase(onProgress, 'Preparing visuals…', EXPORT_PHASE.prep);
    throwIfAborted();

    const size = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');

    let coverImg = null;
    if (track.coverArtUrl) {
      try {
        coverImg = await loadImage(track.coverArtUrl);
      } catch {
        reportPhase(onProgress, 'Cover art skipped — using gradient', EXPORT_PHASE.prep);
      }
    }

    const lines = lyricDisplayLines(track.lyrics);
    const lineHeight = 54;
    const title = track.title || 'Untitled';

    const bufferSource = audioCtx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    const dest = audioCtx.createMediaStreamDestination();
    bufferSource.connect(dest);

    const videoStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const recorder = new MediaRecorder(combined, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 192_000,
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };

    const stopPromise = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error('Recording failed'));
      bufferSource.onended = () => {
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop();
        }, 400);
      };
    });

    reportPhase(onProgress, 'Rendering lyric video…', EXPORT_PHASE.renderStart);
    recorder.start(250);
    renderLyricFrame(ctx, size, { coverImg, title, lines, progress: 0, lineHeight });

    await audioCtx.resume();
    const start = performance.now();
    bufferSource.start(0);

    await new Promise((resolve, reject) => {
      const tick = () => {
        throwIfAborted();
        if (timedOut) {
          reject(new Error('Lyric video timed out — try a shorter track'));
          return;
        }
        const elapsed = (performance.now() - start) / 1000;
        const songT = Math.min(1, elapsed / duration);
        const jobP = overallProgress(songT);
        renderLyricFrame(ctx, size, {
          coverImg,
          title,
          lines,
          progress: songT,
          lineHeight,
        });
        reportPhase(onProgress, 'Rendering…', jobP);
        if (elapsed < duration + 0.5) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    renderLyricFrame(ctx, size, { coverImg, title, lines, progress: 1, lineHeight });
    reportPhase(onProgress, 'Finalizing file…', EXPORT_PHASE.finalize);
    await stopPromise;

    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (!blob.size) throw new Error('Video recording produced an empty file');

    const filename = `${safeFilename(title)}-lyric-video.${ext}`;
    triggerDownload(blob, filename);
    reportPhase(onProgress, 'Download started', EXPORT_PHASE.done);

    return { ext, filename, label: ext === 'mp4' ? 'MP4' : 'WebM' };
  } finally {
    clearTimeout(timeoutId);
    try {
      await audioCtx.close();
    } catch { /* ignore */ }
  }
}