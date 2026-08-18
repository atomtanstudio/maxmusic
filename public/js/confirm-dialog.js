/**
 * The app's own confirmation, for the handful of things that cannot be undone.
 *
 * `window.confirm` is the browser's dialog, not this program's: it arrives in a
 * different typeface, it cannot say what is about to happen in any detail, and
 * its buttons are labelled OK and Cancel whatever the question was. A person
 * about to delete twelve songs deserves to be told it is twelve songs, to read
 * some of their names, and to press a button that says Delete.
 *
 * Returns a promise for the answer. Escape and the backdrop both mean no, which
 * is the only safe default for a question whose yes cannot be taken back.
 *
 * @module confirm-dialog
 */

const esc = (value) => String(value ?? '').replace(/[<>&"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
));

function ensureStyles() {
  if (document.querySelector('style[data-confirmdlg]')) return;
  const css = document.createElement('style');
  css.dataset.confirmdlg = '';
  css.textContent = `
    .confirmdlg { border: 1px solid var(--border-strong, #2A2F3A); border-radius: 14px;
      background: var(--surface-raised, #12141B); color: inherit; padding: 0;
      width: min(420px, calc(100vw - 48px)); }
    .confirmdlg::backdrop { background: rgba(4,5,9,0.62); }
    .confirmdlg__body { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
    .confirmdlg__title { margin: 0; font-size: 18px; }
    .confirmdlg__text { margin: 0; color: var(--text-lo, #6E7889); font-size: 13px; line-height: 1.5; }
    .confirmdlg__list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;
      gap: 2px; max-height: 148px; overflow-y: auto; font-size: 13px; }
    .confirmdlg__list li { color: var(--text, #E7ECF1); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .confirmdlg__more { color: var(--text-lo, #6E7889); font-size: 13px; margin: 0; }
    .confirmdlg__acts { gap: 10px; }
    .confirmdlg__go[data-tone="danger"] { background: var(--danger, #F04060); border-color: transparent;
      color: #fff; }`;
  document.head.append(css);
}

/**
 * Ask a question that cannot be taken back.
 *
 * @param {object}   options
 * @param {string}   options.title    the question, as a heading
 * @param {string}   [options.body]   a sentence saying what will happen
 * @param {string[]} [options.items]  names of the things affected, shown in full
 *                                    up to a point and then counted
 * @param {string}   [options.confirm] the affirmative button's label
 * @param {string}   [options.cancel]  the negative button's label
 * @param {'danger'|'normal'} [options.tone]
 * @returns {Promise<boolean>} whether the person said yes
 */
export function confirmAction({
  title,
  body = '',
  items = [],
  confirm = 'Confirm',
  cancel = 'Cancel',
  tone = 'danger',
} = {}) {
  ensureStyles();

  const shown = items.slice(0, 6);
  const rest = items.length - shown.length;
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmdlg';
  dialog.innerHTML = `
    <form method="dialog" class="confirmdlg__body">
      <h2 class="confirmdlg__title">${esc(title)}</h2>
      ${body ? `<p class="confirmdlg__text">${esc(body)}</p>` : ''}
      ${shown.length ? `<ul class="confirmdlg__list">${shown.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${rest > 0 ? `<p class="confirmdlg__more">and ${rest} more</p>` : ''}
      <div class="row row--end confirmdlg__acts">
        <button type="button" class="btn btn--ghost" data-role="no">${esc(cancel)}</button>
        <button type="button" class="btn confirmdlg__go" data-tone="${esc(tone)}" data-role="yes">${esc(confirm)}</button>
      </div>
    </form>`;

  document.body.append(dialog);
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
      dialog.remove();
    };
    dialog.querySelector('[data-role="yes"]').addEventListener('click', () => finish(true));
    dialog.querySelector('[data-role="no"]').addEventListener('click', () => finish(false));
    // Escape closes the dialog natively; a close with no answer is a no.
    dialog.addEventListener('close', () => finish(false));
    // A click on the backdrop lands on the dialog element itself, not its body.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });
    dialog.showModal();
    // The safe choice takes the focus, so a stray Enter cannot delete anything.
    dialog.querySelector('[data-role="no"]').focus();
  });
}
