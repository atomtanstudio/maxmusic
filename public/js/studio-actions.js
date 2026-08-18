/**
 * Studio actions — the deliverables menu, shared by every screen that
 * lists songs.
 *
 * Create and the Library both show finished songs; both offer the same four
 * ways out: the audio itself (FLAC or MP3), a lyric scroll, and a lyric
 * film. The one-render-at-a-time guard lives here so the rule holds no
 * matter which screen asked.
 *
 * @module studio-actions
 */

import * as api from './api.js';
import { loadRecords, updateRecord } from './records.js';

/** A same-origin download, when the user asks for one. */
function saveFile(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Download a song's kept video (latest of the given kind). */
export function downloadVideo(ctx, record, mode) {
  const v = (record.videos || [])
    .filter((x) => x.mode === mode)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0];
  if (!v) return;
  saveFile(v.url, v.filename);
  ctx.toast('Saving it to your downloads.', { kind: 'success', title: 'Downloading' });
}

/** The one active render, whichever screen started it. */
let activeJob = null;

/** Section headings are useful structure, but they are not words to display. */
export function hasDisplayableLyrics(record) {
  if (record?.isInstrumental) return false;
  return String(record?.lyrics || '')
    .split(/\r?\n/)
    .some((line) => line.trim() && !/^\s*\[[^\]]+\]\s*$/.test(line));
}

/**
 * A visualizer is intentionally a no-lyrics deliverable. On vocal songs we
 * make that tradeoff explicit so two adjacent menu choices cannot silently
 * produce the wrong video.
 *
 * @returns {Promise<'film'|'visualizer'|null>}
 */
export function chooseVocalVideoKind() {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'videokinddlg';
    dialog.innerHTML = `
      <form method="dialog" class="videokinddlg__body">
        <h2 class="videokinddlg__title">Show the lyrics?</h2>
        <p class="videokinddlg__copy">This song has written lyrics. A lyric video puts every line on screen. An audio visualizer intentionally shows no lyric text.</p>
        <div class="row row--end videokinddlg__acts">
          <button type="button" class="btn btn--ghost" data-role="cancel">Cancel</button>
          <button type="button" class="btn btn--ghost" data-role="visualizer">Visualizer without lyrics</button>
          <button type="button" class="btn" data-role="lyrics">Make lyric video</button>
        </div>
      </form>`;

    if (!document.querySelector('style[data-videokinddlg]')) {
      const css = document.createElement('style');
      css.dataset.videokinddlg = '';
      css.textContent = `
        .videokinddlg { border: 1px solid var(--border-strong, #2A2F3A); border-radius: 14px;
          background: var(--surface-raised, #12141B); color: inherit; padding: 0;
          width: min(560px, calc(100vw - 48px)); }
        .videokinddlg::backdrop { background: rgba(4,5,9,0.68); }
        .videokinddlg__body { display: flex; flex-direction: column; gap: 16px; padding: 22px; }
        .videokinddlg__title { margin: 0; font-size: 19px; }
        .videokinddlg__copy { margin: 0; color: var(--text-dim, #8E98AA); font-size: 14px; line-height: 1.55; }
        .videokinddlg__acts { flex-wrap: wrap; gap: 10px; }
        @media (max-width: 620px) {
          .videokinddlg__acts { align-items: stretch; flex-direction: column-reverse; }
          .videokinddlg__acts .btn { width: 100%; }
        }`;
      document.head.append(css);
    }

    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(choice);
    };
    dialog.querySelector('[data-role="cancel"]').addEventListener('click', () => finish(null));
    dialog.querySelector('[data-role="visualizer"]').addEventListener('click', () => finish('visualizer'));
    dialog.querySelector('[data-role="lyrics"]').addEventListener('click', () => finish('film'));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-role="lyrics"]').focus();
  });
}

function videoNoun(mode) {
  return { film: 'lyric video', scroll: 'lyric scroll', visualizer: 'audio visualizer' }[mode] || 'video';
}

/**
 * The song as it is SAVED, not as the caller remembers it.
 *
 * Screens hold their own copies of a song — a row painted minutes ago, a list
 * built at mount — and a menu opened from one of those carries whatever was
 * true when it was drawn. Rename a song and export it, and the export can
 * still go out under the old name. It happened: a song renamed in the library
 * rendered a video titled "The Source Stays Open" with no artist on it.
 *
 * So anything that leaves this app reads the ledger first. The caller's copy
 * fills in only what the ledger has no opinion about.
 */
function asSaved(ctx, record) {
  try {
    const stored = loadRecords(ctx.storage).find((r) => String(r.id) === String(record?.id));
    return stored ? { ...record, ...stored } : record;
  } catch {
    return record;
  }
}

/** The server only accepts `/tracks/<name>` — normalise what screens hold. */
function trackPath(record) {
  const url = String(record?.url || '');
  if (url.startsWith('/tracks/')) return url;
  const name = String(record?.filename || url.split('/').pop() || '').trim();
  return name ? `/tracks/${name}` : null;
}

/** Save the song itself, as the original FLAC or a 320k MP3. */
export function downloadAudio(ctx, record, format) {
  record = asSaved(ctx, record);
  const track = trackPath(record);
  if (!track) {
    ctx.toast('This song has no audio file on the server yet.', { kind: 'warn', title: 'Nothing to download' });
    return;
  }
  const a = document.createElement('a');
  a.href = api.audioDownloadUrl(track, format, record.title);
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  ctx.toast(`Saving the ${format === 'mp3' ? 'MP3' : 'FLAC'} to your downloads.`, { kind: 'success', title: 'Downloading' });
}

/**
 * Render a song to MP4 in the studio and hand the file over when it lands.
 *
 * Two kinds: a lyric scroll (the cover, softened, with the words gliding up
 * in time) and a lyric film (a directed, animated piece). Both are built on
 * this machine; a two-minute song takes a few minutes.
 *
 * Polling is a chain of delayed single requests rather than an interval,
 * the same shape the sign-in poll uses, so two are never in flight.
 */
export async function makeLyricVideo(ctx, record, mode) {
  if (activeJob) {
    ctx.toast('One video at a time — this one is still rendering.', { kind: 'info', title: 'Already working' });
    return;
  }
  // The words are already sung and cannot change, but the name on the screen
  // is decided here, at export time. Take the current one.
  record = asSaved(ctx, record);
  let effectiveMode = mode;
  let visualizerConfirmed = false;
  if (mode === 'visualizer' && hasDisplayableLyrics(record)) {
    const choice = await chooseVocalVideoKind();
    if (!choice) return;
    effectiveMode = choice;
    visualizerConfirmed = choice === 'visualizer';
  }
  const track = trackPath(record);
  if (!track) {
    ctx.toast('This song has no audio file to build a video from.', { kind: 'warn', title: 'Nothing to render' });
    return;
  }

  const key = 'studio:video';
  let noun = videoNoun(effectiveMode);
  let title = `Making the ${noun}`;
  ctx.toast('Starting the render…', { kind: 'info', title, key, timeout: 0, progress: 0 });

  try {
    activeJob = await api.videoJobCreate({
      trackId: record.id,
      trackUrl: track,
      mode: effectiveMode,
      title: record.title,
      artist: record.artist || '',
      lyrics: record.isInstrumental ? '' : (record.lyrics || ''),
      cover: record.cover && String(record.cover).startsWith('/covers/') ? record.cover : null,
      visualizerConfirmed,
    });
    // The server is authoritative. A stale browser that asked for an
    // unconfirmed vocal visualizer is safely corrected to a lyric video.
    if (activeJob.mode && activeJob.mode !== effectiveMode) {
      effectiveMode = activeJob.mode;
      noun = videoNoun(effectiveMode);
      title = `Making the ${noun}`;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!activeJob) return;                        // cancelled from elsewhere
      const job = await api.videoJobStatus(activeJob.id);
      activeJob = job;
      if (job.mode && job.mode !== effectiveMode) {
        effectiveMode = job.mode;
        noun = videoNoun(effectiveMode);
        title = `Making the ${noun}`;
      }

      if (job.status === 'completed') {
        // The video joins the song in the Library; nothing is forced into
        // the downloads folder. The toast offers the shortcut anyway.
        try {
          const existing = loadRecords(ctx.storage).find((r) => r.id === record.id);
          const videos = [
            { mode: job.mode || effectiveMode, url: job.downloadUrl, filename: job.filename || 'video.mp4', at: Date.now() },
            ...(existing?.videos || []),
          ];
          updateRecord(ctx.storage, record.id, { videos });
          ctx.bus.emit('library:changed', { source: 'shell', count: loadRecords(ctx.storage).length, id: record.id });
        } catch (err) {
          console.error('[studio] could not attach the video to its song', err);
        }
        ctx.toast(`It’s on “${record.title}” in your Library, ready to download any time.`, {
          kind: 'success',
          title: `${noun[0].toUpperCase()}${noun.slice(1)} ready`,
          key,
          timeout: 9000,
          action: { label: 'Download now', onClick: () => saveFile(job.downloadUrl, job.filename) },
        });
        activeJob = null;
        return;
      }
      if (job.status === 'failed' || job.status === 'cancelled') {
        ctx.toast(job.error || 'The render stopped before it finished.', { kind: 'error', title: 'Video didn’t finish', key });
        activeJob = null;
        return;
      }
      const pct = Math.round((job.progress || 0) * 100);
      const line = job.status === 'queued'
        ? 'Waiting for a free slot…'
        : `${job.step || 'Working'} — ${pct}%`;
      ctx.toast(line, {
        kind: 'info', title, key, timeout: 0,
        progress: Math.max(0, Math.min(1, Number(job.progress) || 0)),
      });
    }
  } catch (err) {
    const id = activeJob?.id;
    activeJob = null;
    if (id) api.videoJobCancel(id);
    ctx.toast(api.errorText(err), { kind: 'error', title: 'Couldn’t make the video' });
  }
}
