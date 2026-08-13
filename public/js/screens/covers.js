/**
 * Covers — album art over `POST /api/cover-art`.
 *
 * Owned by the covers lane (SPEC §6). The whole screen is driven by the real
 * `/api/health` snapshot:
 *
 *   coverArt: "disabled"              → the capability is off. The composer stays
 *                                       visible and inspectable, the request body
 *                                       is shown verbatim, Generate is disabled
 *                                       with the server's own reason, and the two
 *                                       concrete ways to switch it on are spelled
 *                                       out. No image is ever faked.
 *   coverArt: "local-comfy-workflow"  → ComfyUI renders it. Size comes from the
 *   coverArt: "local-media-broker"       workflow / LOCAL_MEDIA_BROKER_SIZE, one
 *                                        image per request, so `aspect_ratio` and
 *                                        `n` are locked with that reason shown.
 *   backend: "remote-minimax"         → the hosted image API honours aspect_ratio
 *                                        and n, so both unlock.
 *
 * Bus events used here:
 *   in  `track:new`     — offers the finished track's title/prompt as art direction.
 *   out `covers:new`    — `{ cover, meta }` after a real cover comes back.
 *                         (New event; documented here for the other lanes.)
 *
 * @module screens/covers
 */

export const meta = {
  title: 'Covers',
  subtitle: 'Album art from POST /api/cover-art',
  css: '/css/screens/covers.css',
};

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // only ever ctx.iconMarkup()
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const clock = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function bytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MODES = [
  { id: 'vocal', label: 'Vocal', hint: 'album cover, negative space for typography' },
  { id: 'instrumental', label: 'Instrumental', hint: 'cinematic wide composition, instrumental album art' },
  { id: 'cover', label: 'Cover version', hint: 'cover version album art' },
];

const HISTORY_KEY = 'covers.history';
const DRAFT_KEY = 'covers.draft';
const LYRICS_DRAFT_KEY = 'lyrics.draft'; // same lane — see screens/lyrics.js
const HISTORY_MAX = 24;

/* ========================================================================== *
 * Mount
 * ========================================================================== */

export async function mount(root, ctx) {
  const { api } = ctx;

  const saved = ctx.storage.get(DRAFT_KEY, null) || {};
  const state = {
    title: String(ctx.route.query.title || saved.title || ''),
    mode: MODES.some((m) => m.id === saved.mode) ? saved.mode : 'vocal',
    musicPrompt: String(ctx.route.query.prompt || saved.musicPrompt || ''),
    prompt: String(saved.prompt || ''),
    ratio: api.ASPECT_RATIOS.includes(saved.ratio) ? saved.ratio : '1:1',
    count: 1,
    health: null,
    busy: false,
    result: null,
    startedAt: 0,
    error: null,
    /** Verbatim 501 text from the endpoint, when we have actually seen one. */
    serverReason: '',
    history: (ctx.storage.get(HISTORY_KEY, []) || []).filter((c) => c && c.url).slice(0, HISTORY_MAX),
  };

  const page = el('div', { class: 'screen-covers', dataset: { state: 'checking' } });

  /* ---------------------------------------------------------- topbar slot */

  const providerBadge = el('span', { class: 'badge cov-provider' }, [
    el('span', { class: 'cov-provider__dot' }),
    el('span', { class: 'cov-provider__text', text: 'checking…' }),
  ]);
  const recheckBtn = el('button', {
    class: 'btn btn--sm btn--ghost', type: 'button',
    onclick: async () => {
      recheckBtn.disabled = true;
      try { await ctx.refreshHealth(); } finally { recheckBtn.disabled = false; }
    },
  }, [ctx.icon('refresh'), 'Re-check']);
  ctx.headerSlot.append(providerBadge, recheckBtn);

  /* ======================================================= COMPOSER ====== */

  const titleInput = el('input', {
    class: 'input', type: 'text', maxlength: '120',
    placeholder: 'Untitled', 'aria-label': 'Track title', value: state.title,
    oninput: () => { state.title = titleInput.value; onFormChange(); },
  });

  const modeSegment = el('div', { class: 'segment cov-modes', role: 'group', 'aria-label': 'Art mode' },
    MODES.map((mode) => el('button', {
      class: `segment__item${mode.id === state.mode ? ' is-active' : ''}`,
      type: 'button', text: mode.label, title: `mode: "${mode.id}" — ${mode.hint}`,
      dataset: { mode: mode.id },
      onclick: () => {
        state.mode = mode.id;
        for (const item of modeSegment.children) item.classList.toggle('is-active', item.dataset.mode === mode.id);
        modeHint.textContent = `The server adds “${mode.hint}” when you leave the art prompt empty.`;
        onFormChange();
      },
    })));
  const modeHint = el('p', {
    class: 'hint',
    text: `The server adds “${MODES.find((m) => m.id === state.mode).hint}” when you leave the art prompt empty.`,
  });

  const musicPromptInput = el('textarea', {
    class: 'textarea cov-music', rows: '3',
    placeholder: 'The music, in the words you would use to describe it — mood, palette, era.',
    'aria-label': 'Music description',
    oninput: () => { state.musicPrompt = musicPromptInput.value; onFormChange(); },
  });
  musicPromptInput.value = state.musicPrompt;

  const promptInput = el('textarea', {
    class: 'textarea cov-prompt', rows: '4',
    placeholder: 'Leave empty and the backend composes one from the title, the music description and the mode.',
    'aria-label': 'Art prompt',
    oninput: () => { state.prompt = promptInput.value; onFormChange(); },
  });
  promptInput.value = state.prompt;

  const promptCount = el('span', { class: 'label__hint mono' });

  const ratioRow = el('div', { class: 'cov-ratios', role: 'group', 'aria-label': 'Aspect ratio' },
    api.ASPECT_RATIOS.map((ratio) => el('button', {
      class: `chip chip--mono${ratio === state.ratio ? ' is-active' : ''}`,
      type: 'button', text: ratio, dataset: { ratio },
      'aria-pressed': ratio === state.ratio ? 'true' : 'false',
      onclick: () => {
        state.ratio = ratio;
        for (const chip of ratioRow.children) {
          const on = chip.dataset.ratio === ratio;
          chip.classList.toggle('is-active', on);
          chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        applyStageRatio();
        onFormChange();
      },
    })));

  const countRow = el('div', { class: 'segment cov-count', role: 'group', 'aria-label': 'Images per request' },
    [1, 2, 4].map((n) => el('button', {
      class: `segment__item${n === state.count ? ' is-active' : ''}`,
      type: 'button', text: `×${n}`, dataset: { n: String(n) },
      onclick: () => {
        state.count = n;
        for (const item of countRow.children) item.classList.toggle('is-active', Number(item.dataset.n) === n);
        onFormChange();
      },
    })));

  const paramLock = el('p', { class: 'hint cov-lock' });

  const payloadPre = el('pre', { class: 'cov-payload mono' });
  const payloadCopy = el('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: () => copy(payloadText(), 'Request body copied.'),
  }, [ctx.icon('copy'), 'Copy request body']);

  const payloadBlock = el('details', { class: 'cov-details' }, [
    el('summary', { class: 'cov-details__summary' }, [
      ctx.icon('chevron-right', 'icon cov-details__chev'),
      el('span', { text: 'Request body' }),
      el('span', { class: 'spacer' }),
      el('code', { class: 'code', text: 'POST /api/cover-art' }),
    ]),
    el('div', { class: 'cov-details__body' }, [payloadPre, el('div', { class: 'row' }, [payloadCopy])]),
  ]);

  const generateBtn = el('button', {
    class: 'btn btn--primary btn--lg btn--block', type: 'button',
    onclick: () => generate(),
  }, [ctx.icon('covers'), el('span', { text: 'Generate cover' })]);
  const generateHint = el('p', { class: 'hint cov-generate__hint' });

  const suggestion = el('div', { class: 'cov-suggest', hidden: true });

  const composer = el('section', { class: 'cov-compose' }, [
    el('div', { class: 'cov-compose__scroll' }, [
      el('div', { class: 'panel cov-panel' }, [
        el('div', { class: 'panel__head' }, [
          el('span', { class: 'panel__title', text: 'Art direction' }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'btn btn--sm', type: 'button', text: 'From Lyrics draft',
            title: 'Fill the title and music description from the draft on the Lyrics screen',
            onclick: () => fromLyricsDraft(),
          }),
        ]),
        el('div', { class: 'panel__body stack' }, [
          suggestion,
          el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Title' }),
            titleInput,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Mode' }),
            modeSegment,
            modeHint,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Music description' }),
            musicPromptInput,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label' }, [el('span', { text: 'Art prompt' }), promptCount]),
            promptInput,
            el('p', { class: 'hint', text: 'Whatever the server ends up using comes back with the cover and is shown next to it.' }),
          ]),
        ]),
      ]),

      el('div', { class: 'panel cov-panel' }, [
        el('div', { class: 'panel__head' }, [el('span', { class: 'panel__title', text: 'Output' })]),
        el('div', { class: 'panel__body stack' }, [
          el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Aspect ratio' }),
            ratioRow,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label', text: 'Images per request' }),
            countRow,
          ]),
          paramLock,
        ]),
      ]),

      payloadBlock,
    ]),

    el('div', { class: 'cov-generate' }, [generateBtn, generateHint]),
  ]);

  /* ========================================================= CANVAS ====== */

  const stageInner = el('div', { class: 'cov-stage__inner' });
  const stage = el('div', { class: 'cov-stage' }, [stageInner]);

  const detail = el('div', { class: 'cov-detail', hidden: true });

  const offCard = el('section', { class: 'cov-off', hidden: true });

  const historyStrip = el('div', { class: 'cov-history', hidden: true });

  const canvas = el('section', { class: 'cov-canvas' }, [stage, detail, offCard, historyStrip]);

  page.append(composer, canvas);
  root.append(page);

  /* ========================================================================
   * Derived state
   * ===================================================================== */

  const isRemote = () => state.health?.backend === 'remote-minimax';
  const enabled = () => Boolean(state.health?.coverArtEnabled) && state.health?.status !== 'offline';
  const hasDirection = () => Boolean(state.prompt.trim() || state.title.trim() || state.musicPrompt.trim());

  function blockingReason() {
    const h = state.health;
    if (!h) return 'Checking /api/health…';
    if (h.status === 'offline') return h.message;
    if (!h.coverArtEnabled) {
      return state.serverReason
        || `/api/health reports coverArt: "${h.coverArtProvider}". POST /api/cover-art answers 501 until an image provider is configured.`;
    }
    if (!hasDirection()) return 'Give it a title, a music description or an art prompt first.';
    return '';
  }

  function payload() {
    return {
      prompt: state.prompt.trim(),
      title: state.title.trim(),
      mode: state.mode,
      musicPrompt: state.musicPrompt.trim(),
      aspect_ratio: isRemote() ? state.ratio : '1:1',
      n: isRemote() ? state.count : 1,
    };
  }

  const payloadText = () => JSON.stringify(payload(), null, 2);

  function persist() {
    ctx.storage.set(DRAFT_KEY, {
      title: state.title, mode: state.mode, musicPrompt: state.musicPrompt,
      prompt: state.prompt, ratio: state.ratio,
    });
  }

  async function copy(text, message) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(message, { kind: 'success' });
    } catch (err) {
      ctx.toast(`Clipboard refused the copy: ${err?.message || err}`, { kind: 'warn' });
    }
  }

  function fromLyricsDraft() {
    const draft = ctx.storage.get(LYRICS_DRAFT_KEY, null);
    if (!draft || (!draft.title && !draft.styleTags)) {
      ctx.toast('No Lyrics draft yet — write one on the Lyrics screen first.', {
        kind: 'info',
        action: { label: 'Open Lyrics', onClick: () => ctx.navigate('lyrics') },
      });
      return;
    }
    if (draft.title) { state.title = String(draft.title); titleInput.value = state.title; }
    if (draft.styleTags) { state.musicPrompt = String(draft.styleTags); musicPromptInput.value = state.musicPrompt; }
    onFormChange();
    ctx.toast('Title and style tags pulled from the Lyrics draft.', { kind: 'success' });
  }

  /* ========================================================================
   * Rendering
   * ===================================================================== */

  function applyStageRatio() {
    const [w, h] = (isRemote() ? state.ratio : '1:1').split(':').map(Number);
    stage.style.setProperty('--stage-ratio', `${w || 1} / ${h || 1}`);
  }

  function renderStage() {
    stageInner.replaceChildren();

    if (state.busy) {
      stage.dataset.mode = 'busy';
      // Elapsed is anchored to the request, not to this render: a background
      // health poll repaints the stage and must not reset the clock.
      const started = state.startedAt || Date.now();
      const time = el('span', { class: 'cov-stage__time mono', text: clock((Date.now() - started) / 1000) });
      clearInterval(tick);
      tick = setInterval(() => { time.textContent = clock((Date.now() - started) / 1000); }, 1000);
      stageInner.append(
        el('span', { class: 'cov-stage__pulse' }),
        ctx.icon('spinner', 'icon spinner cov-stage__spinner'),
        el('p', { class: 'cov-stage__title', text: 'Rendering' }),
        el('p', { class: 'cov-stage__text', text: `${state.health?.coverArtProvider || 'the server'} is working. Local renders take a while.` }),
        time,
        el('button', {
          class: 'btn btn--sm', type: 'button', text: 'Cancel',
          onclick: () => inFlight?.abort(new DOMException('Cancelled', 'AbortError')),
        }),
      );
      return;
    }

    if (state.error) {
      stage.dataset.mode = 'error';
      stageInner.append(
        el('span', { class: 'cov-stage__icon', html: ctx.iconMarkup('alert') }),
        el('p', { class: 'cov-stage__title', text: `POST /api/cover-art — HTTP ${state.error.status || 0}` }),
        el('p', { class: 'cov-stage__text cov-stage__text--verbatim', text: state.error.text }),
        el('button', { class: 'btn btn--sm', type: 'button', text: 'Try again', onclick: () => generate() }),
      );
      return;
    }

    if (state.result) {
      stage.dataset.mode = 'image';
      const img = el('img', {
        class: 'cov-stage__img',
        src: api.mediaUrl(state.result.url),
        alt: state.result.title ? `Cover art for ${state.result.title}` : 'Generated cover art',
        onerror: () => {
          stage.dataset.mode = 'error';
          stageInner.replaceChildren(
            el('span', { class: 'cov-stage__icon', html: ctx.iconMarkup('alert') }),
            el('p', { class: 'cov-stage__title', text: 'The image file did not load' }),
            el('p', { class: 'cov-stage__text', text: `${api.mediaUrl(state.result.url)} returned nothing. The backend serves /covers/* — check that it still has the file.` }),
          );
        },
      });
      stageInner.append(img);
      return;
    }

    if (!enabled()) {
      stage.dataset.mode = 'off';
      stageInner.append(
        el('span', { class: 'cov-stage__icon', html: ctx.iconMarkup('lock') }),
        el('p', { class: 'cov-stage__title', text: 'No image' }),
        el('p', { class: 'cov-stage__text', text: 'This screen will not invent one. Nothing is rendered until the server has an image provider.' }),
      );
      return;
    }

    stage.dataset.mode = 'idle';
    stageInner.append(
      el('span', { class: 'cov-stage__icon', html: ctx.iconMarkup('covers') }),
      el('p', { class: 'cov-stage__title', text: 'Nothing generated yet' }),
      el('p', { class: 'cov-stage__text', text: 'Set the direction on the left, then generate. The cover lands here and is kept for this browser.' }),
    );
  }

  function renderDetail() {
    if (!state.result) { detail.hidden = true; detail.replaceChildren(); return; }
    const cover = state.result;
    const url = api.mediaUrl(cover.url);
    detail.hidden = false;
    detail.replaceChildren(
      el('div', { class: 'cov-detail__head' }, [
        el('div', { class: 'cov-detail__titles' }, [
          el('p', { class: 'cov-detail__title', text: cover.title || 'Untitled' }),
          el('p', { class: 'cov-detail__meta mono', text: `${cover.filename} · ${bytes(cover.size)} · ${cover.backend || state.health?.coverArtProvider || 'server'}` }),
        ]),
        el('span', { class: 'spacer' }),
        el('a', { class: 'btn btn--sm', href: url, download: cover.filename || '' }, [ctx.icon('download'), 'Download']),
        el('a', { class: 'btn btn--sm', href: url, target: '_blank', rel: 'noopener' }, [ctx.icon('external'), 'Open']),
      ]),
      el('div', { class: 'cov-detail__prompt' }, [
        el('div', { class: 'label' }, [
          el('span', { text: 'Prompt the server used' }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'iconbtn', type: 'button', title: 'Copy the prompt', 'aria-label': 'Copy the prompt',
            html: ctx.iconMarkup('copy'),
            onclick: () => copy(cover.prompt || '', 'Prompt copied.'),
          }),
        ]),
        el('p', { class: 'cov-detail__promptText', text: cover.prompt || '(the server did not report a prompt)' }),
      ]),
    );
  }

  function renderOff() {
    const h = state.health;
    const off = !enabled();
    offCard.hidden = !off;
    if (!off) { offCard.replaceChildren(); return; }

    const offline = h?.status === 'offline';
    const reasonText = offline
      ? h.message
      : (state.serverReason || `/api/health reports coverArt: "${h?.coverArtProvider ?? 'unknown'}" — the backend has no image provider configured, so POST /api/cover-art answers 501.`);

    const path = (n, title, body, envLines) => el('li', { class: 'cov-path' }, [
      el('span', { class: 'cov-path__n mono', text: String(n) }),
      el('div', { class: 'cov-path__body' }, [
        el('p', { class: 'cov-path__title', text: title }),
        el('p', { class: 'cov-path__text', text: body }),
        el('div', { class: 'cov-env' }, [
          el('pre', { class: 'cov-env__code mono', text: envLines.join('\n') }),
          el('button', {
            class: 'iconbtn cov-env__copy', type: 'button',
            title: 'Copy these lines', 'aria-label': 'Copy these lines',
            html: ctx.iconMarkup('copy'),
            onclick: () => copy(envLines.join('\n'), 'Environment lines copied.'),
          }),
        ]),
      ]),
    ]);

    const blocks = [
      el('header', { class: 'cov-off__head' }, [
        el('span', { class: 'badge badge--warn', text: offline ? 'Backend offline' : 'Disabled' }),
        el('h2', { class: 'cov-off__title', text: offline ? 'The backend is not answering' : 'Cover art is switched off on this server' }),
        el('p', { class: 'cov-off__reason', text: reasonText }),
      ]),
      offline ? null : el('div', { class: 'cov-off__paths' }, [
        el('p', { class: 'label', text: 'Two ways to turn it on' }),
        el('ol', { class: 'cov-paths' }, [
          path(1, 'Point it at a ComfyUI image workflow',
            'An API-format workflow containing the __MAXMUSIC_PROMPT__ and __MAXMUSIC_PREFIX__ placeholders. /api/health then reports coverArt: "local-comfy-workflow".',
            ['COMFY_COVER_WORKFLOW=/absolute/path/to/cover-workflow-api.json']),
          path(2, 'Or configure the local media broker',
            'A signed-in local image broker — the URL plus a token, or a file holding one. /api/health then reports coverArt: "local-media-broker", and LOCAL_MEDIA_BROKER_SIZE sets the image size.',
            [
              'LOCAL_MEDIA_BROKER_URL=http://127.0.0.1:8788',
              'LOCAL_MEDIA_BROKER_TOKEN_FILE=/absolute/path/to/media-broker-token',
            ]),
        ]),
        el('p', { class: 'hint', text: 'Set them where the backend on :3010 is started, restart it, then re-check. Everything else on this screen keeps working meanwhile: the prompt, the mode and the exact request body are all still yours to inspect.' }),
      ]),
      el('div', { class: 'cov-off__foot' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button',
          onclick: async () => { await ctx.refreshHealth(); },
        }, [ctx.icon('refresh'), 'Re-check /api/health']),
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', text: 'Open Settings',
          onclick: () => ctx.navigate('settings'),
        }),
        el('span', { class: 'spacer' }),
        el('span', {
          class: 'cov-off__stamp mono',
          text: h?.checkedAt ? `checked ${new Date(h.checkedAt).toLocaleTimeString()}` : '',
        }),
      ]),
    ];
    offCard.replaceChildren(...blocks.filter(Boolean));
  }

  function renderHistory() {
    const items = state.history;
    historyStrip.hidden = items.length === 0;
    historyStrip.replaceChildren();
    if (!items.length) return;

    historyStrip.append(el('div', { class: 'cov-history__head' }, [
      el('span', { class: 'label', text: `This browser · ${items.length} cover${items.length === 1 ? '' : 's'}` }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn btn--sm btn--ghost', type: 'button', text: 'Clear',
        onclick: () => {
          state.history = [];
          ctx.storage.set(HISTORY_KEY, []);
          renderHistory();
        },
      }),
    ]));

    const grid = el('div', { class: 'cov-history__grid' });
    for (const item of items) {
      grid.append(el('button', {
        class: `cov-thumb${state.result && state.result.id === item.id ? ' is-active' : ''}`,
        type: 'button',
        title: `${item.title || 'Untitled'} — ${item.filename}`,
        onclick: () => { state.result = item; state.error = null; renderStage(); renderDetail(); renderHistory(); },
      }, [
        el('img', { src: api.mediaUrl(item.url), alt: '', loading: 'lazy' }),
        el('span', { class: 'cov-thumb__label truncate', text: item.title || 'Untitled' }),
      ]));
    }
    historyStrip.append(grid);
  }

  function renderControls() {
    const remote = isRemote();
    const off = !enabled();

    const activeRatio = remote ? state.ratio : '1:1';
    for (const chip of ratioRow.children) {
      const locked = !remote && chip.dataset.ratio !== '1:1';
      const on = chip.dataset.ratio === activeRatio;
      chip.disabled = locked;
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      chip.title = locked ? 'Locked — this backend sets the image size itself' : `aspect_ratio: "${chip.dataset.ratio}"`;
    }
    const activeCount = remote ? state.count : 1;
    for (const item of countRow.children) {
      const locked = !remote && Number(item.dataset.n) !== 1;
      item.disabled = locked;
      item.classList.toggle('is-active', Number(item.dataset.n) === activeCount);
      item.title = locked ? 'Locked — this backend returns exactly one image per request' : `n: ${item.dataset.n}`;
    }

    paramLock.className = remote ? 'hint cov-lock' : 'hint cov-lock hint--warn';
    paramLock.textContent = remote
      ? 'The hosted MiniMax image API honours both of these.'
      : `Locked on backend: "${state.health?.backend ?? 'unknown'}" — the server picks the size (the ComfyUI workflow, or LOCAL_MEDIA_BROKER_SIZE) and returns one image. Only backend: "remote-minimax" acts on aspect_ratio and n.`;

    const chars = state.prompt.length;
    promptCount.textContent = chars ? `${chars.toLocaleString()} chars` : 'optional';

    payloadPre.textContent = payloadText();

    const reason = blockingReason();
    generateBtn.disabled = state.busy || Boolean(reason);
    generateBtn.title = reason || 'POST /api/cover-art';
    generateBtn.querySelector('span').textContent = state.busy ? 'Generating…' : 'Generate cover';

    if (reason) {
      generateHint.className = off && state.health ? 'hint cov-generate__hint hint--warn' : 'hint cov-generate__hint';
      generateHint.textContent = reason;
    } else {
      generateHint.className = 'hint cov-generate__hint';
      generateHint.textContent = `${state.health.coverArtProvider} · one request, one image, kept on the backend under /covers.`;
    }

    page.dataset.state = !state.health ? 'checking' : off ? 'off' : 'ready';
  }

  function renderAll() {
    applyStageRatio();
    renderControls();
    renderStage();
    renderDetail();
    renderOff();
    renderHistory();
  }

  function onFormChange() {
    persist();
    renderControls();
  }

  /* ========================================================================
   * The one real call
   * ===================================================================== */

  let inFlight = null;
  let tick = null;

  async function generate() {
    if (state.busy || blockingReason()) return;
    state.busy = true;
    state.startedAt = Date.now();
    state.error = null;
    inFlight = new AbortController();
    renderControls();
    renderStage();

    const body = payload();
    try {
      const result = await api.coverArt(body, { signal: inFlight.signal });
      const cover = result?.cover;
      if (!cover?.url) {
        throw new api.ApiError('The server reported success but returned no cover.', {
          status: 200, endpoint: '/api/cover-art', body: result,
        });
      }
      const record = {
        id: cover.id || cover.filename || String(Date.now()),
        filename: cover.filename || '',
        url: cover.url,
        size: cover.size || 0,
        prompt: cover.prompt || body.prompt,
        title: body.title,
        mode: body.mode,
        backend: result.backend || state.health?.coverArtProvider || '',
        at: Date.now(),
      };
      state.result = record;
      state.history = [record, ...state.history.filter((c) => c.id !== record.id)].slice(0, HISTORY_MAX);
      ctx.storage.set(HISTORY_KEY, state.history);
      ctx.bus.emit('covers:new', { cover: record, meta: { ...body } });
      ctx.toast(`${record.filename} · ${bytes(record.size)}`, { kind: 'success', title: 'Cover ready' });
    } catch (err) {
      if (err?.name === 'AbortError') {
        ctx.toast('Cover generation cancelled.', { kind: 'info' });
      } else {
        const text = api.errorText(err);
        state.error = { status: err?.status ?? 0, text };
        // A 501 is the backend telling us the capability is off. Keep its words.
        if (err?.status === 501) {
          state.serverReason = text;
          await ctx.refreshHealth();
        }
        ctx.toast(text, { kind: 'error', title: 'POST /api/cover-art failed' });
      }
    } finally {
      clearInterval(tick);
      tick = null;
      inFlight = null;
      state.busy = false;
      renderAll();
    }
  }

  /* ------------------------------------------------------------ bus + health */

  ctx.bus.on('track:new', (payloadIn) => {
    const meta = payloadIn?.meta || {};
    const title = String(meta.title || '').trim();
    const prompt = String(meta.prompt || '').trim();
    if (!title && !prompt) return;
    suggestion.hidden = false;
    suggestion.replaceChildren(
      el('span', { class: 'cov-suggest__icon', html: ctx.iconMarkup('wave') }),
      el('div', { class: 'cov-suggest__body' }, [
        el('p', { class: 'cov-suggest__title', text: `“${title || 'Untitled'}” just finished generating` }),
        el('p', { class: 'hint', text: 'Use its title and caption as the art direction.' }),
      ]),
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Use it',
        onclick: () => {
          if (title) { state.title = title; titleInput.value = title; }
          if (prompt) { state.musicPrompt = prompt.slice(0, 700); musicPromptInput.value = state.musicPrompt; }
          suggestion.hidden = true;
          onFormChange();
        },
      }),
      el('button', {
        class: 'iconbtn', type: 'button', 'aria-label': 'Dismiss',
        html: ctx.iconMarkup('close'),
        onclick: () => { suggestion.hidden = true; },
      }),
    );
  });

  ctx.onHealth((h) => {
    const wasEnabled = state.health?.coverArtEnabled;
    state.health = h;
    if (h.coverArtEnabled && wasEnabled === false) state.serverReason = '';

    providerBadge.className = `badge cov-provider ${h.coverArtEnabled ? 'badge--ok' : 'badge--warn'}`;
    providerBadge.querySelector('.cov-provider__text').textContent = h.coverArtEnabled
      ? h.coverArtProvider
      : `coverArt: ${h.coverArtProvider}`;
    providerBadge.title = h.coverArtEnabled
      ? `POST /api/cover-art → ${h.coverArtProvider}`
      : blockingReason();

    renderAll();
  });

  renderAll();

  return () => {
    clearInterval(tick);
    inFlight?.abort(new DOMException('Screen left', 'AbortError'));
    persist();
  };
}
