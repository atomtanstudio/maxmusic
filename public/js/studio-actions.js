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
  const v = (record.videos || []).find((x) => x.mode === mode);
  if (!v) return;
  saveFile(v.url, v.filename);
  ctx.toast('Saving it to your downloads.', { kind: 'success', title: 'Downloading' });
}

/** The one active render, whichever screen started it. */
let activeJob = null;

/** The server only accepts `/tracks/<name>` — normalise what screens hold. */
function trackPath(record) {
  const url = String(record?.url || '');
  if (url.startsWith('/tracks/')) return url;
  const name = String(record?.filename || url.split('/').pop() || '').trim();
  return name ? `/tracks/${name}` : null;
}

/** Save the song itself, as the original FLAC or a 320k MP3. */
export function downloadAudio(ctx, record, format) {
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
  const noun = { film: 'lyric video', scroll: 'lyric scroll', visualizer: 'visualizer video' }[mode];
  if (activeJob) {
    ctx.toast('One video at a time — this one is still rendering.', { kind: 'info', title: 'Already working' });
    return;
  }
  const track = trackPath(record);
  if (!track) {
    ctx.toast('This song has no audio file to build a video from.', { kind: 'warn', title: 'Nothing to render' });
    return;
  }

  const key = 'studio:video';
  const title = `Making the ${noun}`;
  ctx.toast('Starting the render…', { kind: 'info', title, key, timeout: 0 });

  try {
    activeJob = await api.videoJobCreate({
      trackUrl: track,
      mode,
      title: record.title,
      artist: record.artist || '',
      lyrics: record.isInstrumental ? '' : (record.lyrics || ''),
      cover: record.cover && String(record.cover).startsWith('/covers/') ? record.cover : null,
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!activeJob) return;                        // cancelled from elsewhere
      const job = await api.videoJobStatus(activeJob.id);
      activeJob = job;

      if (job.status === 'completed') {
        // The video joins the song in the Library; nothing is forced into
        // the downloads folder. The toast offers the shortcut anyway.
        try {
          const existing = loadRecords(ctx.storage).find((r) => r.id === record.id);
          const videos = [
            { mode, url: job.downloadUrl, filename: job.filename || 'video.mp4', at: Date.now() },
            ...(existing?.videos || []).filter((v) => v.mode !== mode),
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
      ctx.toast(line, { kind: 'info', title, key, timeout: 0 });
    }
  } catch (err) {
    const id = activeJob?.id;
    activeJob = null;
    if (id) api.videoJobCancel(id);
    ctx.toast(api.errorText(err), { kind: 'error', title: 'Couldn’t make the video' });
  }
}
