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
  const noun = mode === 'film' ? 'lyric film' : 'lyric scroll';
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
  const title = mode === 'film' ? 'Making the lyric film' : 'Making the lyric scroll';
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
        ctx.toast('Saving it to your downloads now.', { kind: 'success', title: `${noun[0].toUpperCase()}${noun.slice(1)} ready`, key });
        // Same origin as the app, so the download needs no dance.
        const a = document.createElement('a');
        a.href = job.downloadUrl;
        a.download = job.filename || 'song.mp4';
        document.body.append(a);
        a.click();
        a.remove();
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
