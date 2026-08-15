/**
 * Redo the cover art — the whole flow in one small dialog.
 *
 * Two ways, as asked for: let the studio compose the brief from the song's
 * own style, lyrics and title (the same composer the Art screen uses), or
 * type a quick prompt. Either way the artwork attaches straight to the
 * song, and the row art updates the moment it lands.
 *
 * @module cover-redo
 */

import * as api from './api.js';
import { composeBrief } from './screens/art.js';
import { loadRecords, updateRecord } from './records.js';

let open = false;

/** The composed brief for this record — same text the Art screen would use. */
function autoBrief(record) {
  const plan = composeBrief({
    style: String(record.prompt || ''),
    lyrics: String(record.lyrics || ''),
    title: String(record.title || ''),
    instrumental: Boolean(record.isInstrumental),
    useStyle: true,
    useLyrics: true,
    useTitle: true,
  });
  return plan?.text || '';
}

export function redoCoverArt(ctx, record) {
  if (open) return;
  open = true;

  const dialog = document.createElement('dialog');
  dialog.className = 'coverdlg';
  dialog.innerHTML = `
    <form method="dialog" class="coverdlg__body">
      <h2 class="coverdlg__title">New cover art</h2>
      <p class="coverdlg__song">for “${String(record.title || 'Untitled').replace(/[<>&]/g, '')}”</p>

      <div class="segment coverdlg__modes" role="group" aria-label="How the artwork is described">
        <button type="button" class="segment__item is-active" data-mode="auto">From the song</button>
        <button type="button" class="segment__item" data-mode="manual">My own prompt</button>
      </div>

      <p class="coverdlg__hint" data-role="hint">The artwork is described from the song’s style, lyrics and title.</p>
      <textarea class="textarea coverdlg__prompt" data-role="prompt" rows="4" hidden
        aria-label="Describe the artwork" placeholder="Describe the artwork in a line or two."></textarea>

      <p class="coverdlg__status" data-role="status" hidden></p>

      <div class="row row--end coverdlg__acts">
        <button type="button" class="btn btn--ghost" data-role="cancel">Cancel</button>
        <button type="button" class="btn" data-role="go">Make the artwork</button>
      </div>
    </form>`;

  // One stylesheet for the dialog, added once.
  if (!document.querySelector('style[data-coverdlg]')) {
    const css = document.createElement('style');
    css.dataset.coverdlg = '';
    css.textContent = `
      .coverdlg { border: 1px solid var(--border-strong, #2A2F3A); border-radius: 14px;
        background: var(--surface-raised, #12141B); color: inherit; padding: 0;
        width: min(440px, calc(100vw - 48px)); }
      .coverdlg::backdrop { background: rgba(4,5,9,0.62); }
      .coverdlg__body { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
      .coverdlg__title { margin: 0; font-size: 18px; }
      .coverdlg__song { margin: -6px 0 0; color: var(--text-dim, #6E7889); font-size: 13px; }
      .coverdlg__hint { margin: 0; color: var(--text-dim, #6E7889); font-size: 13px; }
      .coverdlg__status { margin: 0; font-size: 13px; }
      .coverdlg__status[data-kind="error"] { color: var(--danger, #F04060); }
      .coverdlg__prompt { resize: vertical; }
      .coverdlg__acts { gap: 10px; }`;
    document.head.append(css);
  }

  const q = (sel) => dialog.querySelector(sel);
  const modes = Array.from(dialog.querySelectorAll('[data-mode]'));
  const promptBox = q('[data-role="prompt"]');
  const hint = q('[data-role="hint"]');
  const status = q('[data-role="status"]');
  const goBtn = q('[data-role="go"]');
  let mode = 'auto';
  let busy = false;
  let aborter = null;

  for (const b of modes) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      for (const x of modes) x.classList.toggle('is-active', x === b);
      promptBox.hidden = mode !== 'manual';
      hint.hidden = mode !== 'auto';
      if (mode === 'manual') promptBox.focus();
    });
  }

  const close = () => {
    if (busy) aborter?.abort(new DOMException('closed', 'AbortError'));
    open = false;
    dialog.close();
    dialog.remove();
  };
  q('[data-role="cancel"]').addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  goBtn.addEventListener('click', async () => {
    if (busy) return;
    const prompt = mode === 'manual' ? promptBox.value.trim() : autoBrief(record);
    if (!prompt) {
      status.hidden = false;
      status.dataset.kind = 'error';
      status.textContent = mode === 'manual'
        ? 'Describe the artwork first.'
        : 'This song has nothing to describe the artwork from yet — write a prompt instead.';
      return;
    }
    busy = true;
    aborter = new AbortController();
    goBtn.disabled = true;
    status.hidden = false;
    delete status.dataset.kind;
    status.textContent = 'Making the artwork — usually under a minute…';

    try {
      const result = await api.coverArt({
        prompt,
        title: String(record.title || ''),
        mode: record.isInstrumental ? 'instrumental' : 'vocal',
        musicPrompt: String(record.prompt || ''),
        aspect_ratio: '1:1',
        n: 1,
      }, { signal: aborter.signal });
      const cover = result?.cover;
      if (!cover?.url) throw new api.ApiError('The studio reported success but sent no artwork back.', { status: 200 });

      updateRecord(ctx.storage, record.id, { cover: cover.url });
      ctx.bus.emit('library:changed', { source: 'shell', count: loadRecords(ctx.storage).length, id: record.id });
      ctx.toast(`“${record.title}” has new artwork.`, { kind: 'success', title: 'Cover art' });
      busy = false;
      close();
    } catch (err) {
      busy = false;
      goBtn.disabled = false;
      if (err?.name === 'AbortError') return;
      status.hidden = false;
      status.dataset.kind = 'error';
      status.textContent = api.errorText(err);
    }
  });

  document.body.append(dialog);
  dialog.showModal();
}
