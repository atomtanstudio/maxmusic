/**
 * Name a song — its title, and who it is by.
 *
 * Simple mode never asks for either: it writes a title from the idea and
 * leaves the artist blank, which is honest at the time and wrong the moment
 * you want a video with your name on it. This is where that gets fixed, and
 * everything downstream reads the song's own record — the lyric video and the
 * visualizer put the title and artist on screen, and an audio export is named
 * after the title — so renaming here is all it takes.
 *
 * Videos made BEFORE a rename keep the name they were rendered with. There is
 * no way to change words already burnt into a frame, so the dialog says so
 * rather than pretending otherwise.
 *
 * @module rename
 */

import { loadRecords, updateRecord } from './records.js';

let open = false;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * @param {Object} ctx      the screen context (storage, bus, toast)
 * @param {Object} record   the song to rename
 * @param {{onDone?: (patch: {title: string, artist: string}) => void}} [opts]
 */
export function renameSong(ctx, record, opts = {}) {
  if (open) return;
  open = true;

  const madeVideos = Array.isArray(record.videos) ? record.videos.length : 0;

  const dialog = document.createElement('dialog');
  dialog.className = 'namedlg';
  dialog.innerHTML = `
    <form method="dialog" class="namedlg__body">
      <h2 class="namedlg__title">Name this song</h2>

      <label class="label namedlg__field">Song title
        <input class="input" data-role="title" type="text" maxlength="120" autocomplete="off">
      </label>

      <label class="label namedlg__field">Artist
        <input class="input" data-role="artist" type="text" maxlength="80" autocomplete="off"
          placeholder="Leave empty to stay uncredited">
      </label>

      <p class="namedlg__hint">Used on new lyric videos and visualizers, and for the file name when you export the audio.</p>
      ${madeVideos ? `<p class="namedlg__hint namedlg__hint--note">The ${madeVideos === 1 ? 'video' : `${madeVideos} videos`} already made for this song will keep the name ${madeVideos === 1 ? 'it was' : 'they were'} rendered with — make ${madeVideos === 1 ? 'it' : 'them'} again to pick this up.</p>` : ''}

      <p class="namedlg__status" data-role="status" hidden></p>

      <div class="row row--end namedlg__acts">
        <button type="button" class="btn btn--ghost" data-role="cancel">Cancel</button>
        <button type="button" class="btn" data-role="save">Save</button>
      </div>
    </form>`;

  if (!document.querySelector('style[data-namedlg]')) {
    const css = document.createElement('style');
    css.dataset.namedlg = '';
    css.textContent = `
      .namedlg { border: 1px solid var(--border-strong, #2A2F3A); border-radius: 14px;
        background: var(--surface-raised, #12141B); color: inherit; padding: 0;
        width: min(440px, calc(100vw - 48px)); }
      .namedlg::backdrop { background: rgba(4,5,9,0.62); }
      .namedlg__body { display: flex; flex-direction: column; gap: 14px; padding: 20px; }
      .namedlg__title { margin: 0; font-size: 18px; }
      .namedlg__field { display: flex; flex-direction: column; gap: 6px; }
      .namedlg__hint { margin: -4px 0 0; color: var(--text-dim, #6E7889); font-size: 13px; }
      .namedlg__hint--note { margin-top: 0; }
      .namedlg__status { margin: 0; font-size: 13px; color: var(--danger, #F04060); }
      .namedlg__acts { gap: 10px; }`;
    document.head.append(css);
  }

  const q = (sel) => dialog.querySelector(sel);
  const titleBox = q('[data-role="title"]');
  const artistBox = q('[data-role="artist"]');
  const status = q('[data-role="status"]');

  titleBox.value = String(record.title || '');
  artistBox.value = String(record.artist || '');

  const close = () => {
    open = false;
    dialog.close();
    dialog.remove();
  };
  q('[data-role="cancel"]').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  function save() {
    const title = clean(titleBox.value);
    const artist = clean(artistBox.value);
    if (!title) {
      status.hidden = false;
      status.textContent = 'A song needs a title.';
      titleBox.focus();
      return;
    }
    try {
      const updated = updateRecord(ctx.storage, record.id, { title, artist });
      if (!updated) throw new Error('that song is no longer in your library');
      ctx.bus.emit('library:changed', {
        source: 'shell',
        count: loadRecords(ctx.storage).length,
        id: record.id,
      });
      ctx.toast(artist ? `Now “${title}” by ${artist}.` : `Now “${title}”.`, { kind: 'success', title: 'Renamed' });
      opts.onDone?.({ title, artist });
      close();
    } catch (err) {
      status.hidden = false;
      status.textContent = `Could not save that — ${err?.message || err}`;
    }
  }

  q('[data-role="save"]').addEventListener('click', save);
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); save(); }
  });

  document.body.append(dialog);
  dialog.showModal();
  titleBox.focus();
  titleBox.select();
}
