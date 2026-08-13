/**
 * Create — the front door. One line in, a finished song out.
 *
 * SPEC §3e: vocal generation needs lyrics and the music backend will not write
 * them, so this is two calls behind one button —
 *   1. `POST /api/lyrics`   (local Codex CLI) — shown, not hidden.
 *   2. `POST /api/generate` (or `/api/generate-dual` for two takes).
 *
 * Only SPEC §3a parameters are exposed. Guidance/cfg, flow-matching steps and
 * `lyrics_optimizer` are server-side only and deliberately absent.
 *
 * Owned by the create lane: this file + public/css/screens/create.css.
 */

export const meta = {
  title: 'Create',
  subtitle: 'One idea in, one song out',
  css: '/css/screens/create.css',
};

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

const STORE_KEY = 'create.simple';

/** Starter ideas. Clicking one fills the idea field — nothing decorative. */
const STARTERS = [
  'a smoky late-night soul ballad about old flames, warm female voice',
  'a defiant punk anthem about staying up far too late',
  'a cozy lo-fi hip hop beat for studying, no vocals',
  'stadium synthwave about driving home at 4am with the windows down',
  'a hushed acoustic lullaby for a sleepless city',
  'a triumphant orchestral cue for the last five minutes of a heist',
  'gritty desert blues rock about a car that never starts',
  'a bright afrobeats summer single about calling in sick',
  'a slow-burn trip hop track about a phone that never rings',
  'euphoric drum and bass about the first warm day of the year',
];

const DURATION_PRESETS = [30, 60, 120, 180, 300];
const SLIDER_MIN = 10;
const SLIDER_MAX = 360;

/* -------------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------------- */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function randomSeed() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % 2 ** 31;
}

/** 125 -> "2:05". Sub-minute durations stay in seconds. */
function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function bytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/** A display title when Codex did not name the song (instrumental runs). */
function titleFromIdea(idea) {
  const clean = String(idea).replace(/\s+/g, ' ').trim();
  if (!clean) return 'Untitled';
  const cut = clean.length > 46 ? `${clean.slice(0, 46).replace(/[\s,;:.-]+\S*$/, '')}…` : clean;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/**
 * The caption sent as `prompt`. Simple mode has one honest source of musical
 * intent — the user's line — plus the style tags Codex chose while reading it.
 * Nothing is invented: no fabricated bpm, key or gear list. Studio is where the
 * full SPEC §3c three-part caption gets written by hand.
 */
function buildCaption({ idea, styleTags, instrumental }, max) {
  const parts = [];
  const line = String(idea || '').replace(/\s+/g, ' ').trim();
  if (line) parts.push(line);

  const tags = String(styleTags || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (tags) parts.push(`Basic Attributes: ${tags}.`);

  parts.push(instrumental
    ? 'Instrumental, no vocals. The lead melodic instrument carries the hook.'
    : 'Vocal Style: a lead vocal delivers the written lyrics with natural phrasing, mixed front and centre.');

  return parts.join('\n').slice(0, max);
}

function pickStarters(n) {
  const pool = STARTERS.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

/* -------------------------------------------------------------------------- *
 * Mount
 * -------------------------------------------------------------------------- */

export function mount(root, ctx) {
  const { api, iconMarkup } = ctx;
  const { LIMITS } = api;
  const saved = ctx.storage.get(STORE_KEY, {}) || {};

  const state = {
    /* form — every field maps to a SPEC §3a parameter */
    idea: typeof saved.idea === 'string' ? saved.idea : '',
    instrumental: Boolean(saved.instrumental),
    duration: clamp(Number(saved.duration) || LIMITS.DURATION_DEFAULT, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX),
    seedAuto: saved.seedAuto === undefined ? true : Boolean(saved.seedAuto),
    seed: Number.isInteger(saved.seed) ? saved.seed : randomSeed(),
    format: api.FORMATS.includes(saved.format) ? saved.format : 'flac',
    bitrate: api.BITRATES.includes(saved.bitrate) ? saved.bitrate : LIMITS.BITRATE_DEFAULT,
    dual: Boolean(saved.dual),
    moreVariation: saved.moreVariation === undefined ? true : Boolean(saved.moreVariation),

    /* run */
    starters: pickStarters(3),
    song: null,             // { title, styleTags, lyrics, provider, model }
    editingLyrics: false,
    running: false,
    phase: 'idle',          // idle | lyrics | render | done | error
    steps: { lyrics: 'pending', render: 'pending' },
    takes: [],              // GenerationResult[]
    takeErrors: [],         // [{slot, error}] from /api/generate-dual
    error: null,            // the failure that ended the last run
    errorStep: null,        // 'lyrics' | 'render'
    facts: null,            // what was actually sent, for the run summary
    startedAt: 0,
    finishedAt: 0,
  };

  let health = ctx.health;
  let controller = null;
  let ticker = null;

  /* ---------------------------------------------------------------- skeleton */

  const page = document.createElement('div');
  page.className = 'screen-create';
  page.innerHTML = `
    <section class="composer" aria-label="Song composer">
      <div class="composer__edge" data-edge></div>
      <div class="composer__scroll">
        <div class="composer__body">

          <div class="field">
            <label class="label" for="cr-idea">
              Your idea
              <span class="label__hint" data-idea-count></span>
            </label>
            <textarea id="cr-idea" class="textarea idea" spellcheck="true"
              maxlength="${LIMITS.PROMPT_MAX}"
              placeholder="Describe the song in one line — e.g. a smoky late-night soul ballad about old flames, warm female voice"></textarea>
            <div class="starters" data-starters>
              <button class="iconbtn starters__dice" type="button" data-shuffle
                title="Show three other ideas" aria-label="Show three other ideas">${iconMarkup('dice')}</button>
            </div>
          </div>

          <div class="modes" role="group" aria-label="Vocal mode">
            <button class="mode" type="button" data-mode="vocal" aria-pressed="false">
              ${iconMarkup('mic', 'icon mode__icon')}
              <span class="mode__text">
                <span class="mode__title">With vocals</span>
                <span class="mode__sub">Codex writes the lyrics first</span>
              </span>
            </button>
            <button class="mode" type="button" data-mode="instrumental" aria-pressed="false">
              ${iconMarkup('wave', 'icon mode__icon')}
              <span class="mode__text">
                <span class="mode__title">Instrumental</span>
                <span class="mode__sub">No lyrics, no lyrics call</span>
              </span>
            </button>
          </div>

          <div class="ctl">
            <div class="ctl__head">
              <span class="label">Length</span>
              <div class="lenbox">
                <input class="input lenbox__num mono" type="number" data-duration-num
                  min="${LIMITS.DURATION_MIN}" max="${LIMITS.DURATION_MAX}" step="1"
                  aria-label="Duration in seconds">
                <span class="lenbox__unit">s</span>
                <span class="lenbox__clock mono" data-duration-clock></span>
              </div>
            </div>
            <input class="range" type="range" data-duration-range
              min="${SLIDER_MIN}" max="${SLIDER_MAX}" step="5" aria-label="Duration slider">
            <div class="presets" data-presets>
              ${DURATION_PRESETS.map((s) => `<button class="chip" type="button" data-preset="${s}">${clock(s)}</button>`).join('')}
            </div>
          </div>

          <div class="ctl">
            <div class="ctl__head">
              <span class="label">Seed</span>
              <button class="chip chip--auto" type="button" data-seed-auto aria-pressed="false">Auto</button>
            </div>
            <div class="seedrow">
              <input class="input mono" type="text" inputmode="numeric" data-seed
                placeholder="random each run" aria-label="Seed"
                autocomplete="off" spellcheck="false">
              <button class="btn btn--icon" type="button" data-seed-roll
                title="Roll a new seed" aria-label="Roll a new seed">${iconMarkup('dice')}</button>
            </div>
            <p class="hint" data-seed-hint></p>
          </div>

          <div class="ctl">
            <div class="ctl__head"><span class="label">Format</span></div>
            <div class="segment" role="group" aria-label="Audio format" data-formats>
              ${api.FORMATS.map((f) => `<button class="segment__item" type="button" data-format="${f}">${f.toUpperCase()}</button>`).join('')}
            </div>
            <div class="bitrate" data-bitrate hidden>
              <label class="hint" for="cr-bitrate">Bitrate</label>
              <select class="select" id="cr-bitrate" data-bitrate-select>
                ${api.BITRATES.map((b) => `<option value="${b}">${b / 1000} kbps</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="ctl ctl--flat">
            <label class="switch dualrow">
              <input type="checkbox" data-dual>
              <span class="switch__track"></span>
              <span class="switch__label">
                Two takes
                <span class="dualrow__sub">Renders A and B together via <code class="code">/api/generate-dual</code></span>
              </span>
            </label>
            <label class="switch dualrow dualrow--nested" data-variation-row hidden>
              <input type="checkbox" data-variation>
              <span class="switch__track"></span>
              <span class="switch__label">
                More variation
                <span class="dualrow__sub">Pushes take B onto an alternate arrangement</span>
              </span>
            </label>
          </div>

        </div>
      </div>

      <footer class="composer__foot">
        <div data-notices></div>
        <button class="btn btn--primary btn--lg btn--block cta" type="button" data-go>
          <span class="cta__icon" data-cta-icon>${iconMarkup('create')}</span>
          <span class="cta__label">Create song</span>
        </button>
        <div class="foot__under">
          <button class="btn btn--sm btn--ghost cancel" type="button" data-cancel hidden>
            ${iconMarkup('close')}<span>Cancel</span>
          </button>
          <p class="hint foot__hint" data-foot-hint></p>
        </div>
      </footer>
    </section>

    <section class="stage" aria-label="Result" data-stage></section>
  `;

  /* ------------------------------------------------------------------ refs */

  const $ = (sel) => page.querySelector(sel);
  const el = {
    edge: $('[data-edge]'),
    idea: $('#cr-idea'),
    ideaCount: $('[data-idea-count]'),
    starters: $('[data-starters]'),
    shuffle: $('[data-shuffle]'),
    modes: page.querySelectorAll('[data-mode]'),
    durNum: $('[data-duration-num]'),
    durRange: $('[data-duration-range]'),
    durClock: $('[data-duration-clock]'),
    presets: $('[data-presets]'),
    seed: $('[data-seed]'),
    seedAuto: $('[data-seed-auto]'),
    seedRoll: $('[data-seed-roll]'),
    seedHint: $('[data-seed-hint]'),
    formats: $('[data-formats]'),
    bitrate: $('[data-bitrate]'),
    bitrateSelect: $('[data-bitrate-select]'),
    dual: $('[data-dual]'),
    variationRow: $('[data-variation-row]'),
    variation: $('[data-variation]'),
    notices: $('[data-notices]'),
    cta: $('[data-go]'),
    ctaLabel: $('.cta__label'),
    ctaIcon: $('[data-cta-icon]'),
    cancel: $('[data-cancel]'),
    footHint: $('[data-foot-hint]'),
    stage: $('[data-stage]'),
  };

  /* ------------------------------------------------------- topbar mode tabs */

  const tabs = document.createElement('div');
  tabs.className = 'segment create-tabs';
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Create mode');
  tabs.innerHTML = `
    <button class="segment__item is-active" type="button" aria-current="page">Simple</button>
    <button class="segment__item" type="button" data-to="studio">Studio</button>`;
  tabs.addEventListener('click', (e) => {
    const to = e.target.closest('[data-to]')?.dataset.to;
    if (to) ctx.navigate(to);
  });
  ctx.headerSlot.append(tabs);

  /* -------------------------------------------------------------- gating */

  /**
   * Why the Create button cannot run right now, in the backend's own words.
   * `null` means go. Health is only allowed to block on a *known* bad state.
   */
  function blocker() {
    if (state.running) return null;
    if (health) {
      if (health.status === 'offline') {
        return { title: 'Backend offline', text: health.message, kind: 'error', retry: true };
      }
      if (!health.comfyReachable) {
        return {
          title: 'Generator not ready',
          text: health.comfyError || `ComfyUI at ${health.comfyUrl || 'the configured host'} is not reachable.`,
          kind: 'error',
          retry: true,
        };
      }
      if (!state.instrumental && !health.lyricsEnabled && !state.song?.lyrics) {
        return {
          title: 'Lyrics provider is off',
          text: `/api/health reports lyrics: "${health.lyricsProvider}". Vocal generation needs lyrics and the music backend will not write them. Switch to Instrumental, or configure the local Codex runtime.`,
          kind: 'warn',
          instrumental: true,
        };
      }
    }
    if (!state.idea.trim()) {
      return { title: 'Describe the song first', text: 'One line is enough — genre, mood, and what it is about.', kind: 'info', quiet: true };
    }
    return null;
  }

  /** The §3a payload for the current form + the lyrics we hold. */
  function buildInput(seedForRun) {
    const input = {
      prompt: buildCaption({
        idea: state.idea,
        styleTags: state.song?.styleTags,
        instrumental: state.instrumental,
      }, LIMITS.PROMPT_MAX),
      is_instrumental: state.instrumental,
      duration: state.duration,
      audio_setting: state.format === 'mp3'
        ? { format: 'mp3', bitrate: state.bitrate }
        : { format: state.format },
    };
    if (!state.instrumental) input.lyrics = state.song?.lyrics || '';
    if (seedForRun !== null && seedForRun !== undefined) input.seed = seedForRun;
    if (state.dual && state.moreVariation) input.more_variation = true;
    return input;
  }

  /* ------------------------------------------------------------ form paint */

  function persist() {
    ctx.storage.set(STORE_KEY, {
      idea: state.idea,
      instrumental: state.instrumental,
      duration: state.duration,
      seedAuto: state.seedAuto,
      seed: state.seed,
      format: state.format,
      bitrate: state.bitrate,
      dual: state.dual,
      moreVariation: state.moreVariation,
    });
  }

  function paintStarters() {
    for (const node of el.starters.querySelectorAll('.starter')) node.remove();
    const frag = document.createDocumentFragment();
    for (const idea of state.starters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip starter';
      b.textContent = idea;
      b.title = 'Use this idea';
      b.addEventListener('click', () => {
        state.idea = idea;
        el.idea.value = idea;
        el.idea.focus();
        persist();
        paintForm();
        paintStage();
      });
      frag.append(b);
    }
    el.starters.insertBefore(frag, el.shuffle);
  }

  function paintForm() {
    el.idea.value = state.idea;
    el.ideaCount.textContent = `${state.idea.length} / ${LIMITS.PROMPT_MAX}`;
    el.starters.hidden = state.idea.trim().length > 0;

    for (const b of el.modes) {
      const on = (b.dataset.mode === 'instrumental') === state.instrumental;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-active', on);
    }

    const d = state.duration;
    if (document.activeElement !== el.durNum) el.durNum.value = String(d);
    el.durRange.value = String(clamp(d, SLIDER_MIN, SLIDER_MAX));
    el.durRange.style.setProperty('--range-fill', `${((clamp(d, SLIDER_MIN, SLIDER_MAX) - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * 100}%`);
    el.durClock.textContent = clock(d);
    for (const b of el.presets.querySelectorAll('[data-preset]')) {
      b.classList.toggle('is-active', Number(b.dataset.preset) === d);
    }

    el.seedAuto.setAttribute('aria-pressed', String(state.seedAuto));
    if (document.activeElement !== el.seed) el.seed.value = state.seedAuto ? '' : String(state.seed);
    el.seedRoll.disabled = false;

    if (state.dual && state.seedAuto) {
      el.seedHint.textContent = 'Each take gets its own server-side seed.';
      el.seedHint.className = 'hint';
    } else if (state.dual && !state.moreVariation) {
      el.seedHint.textContent = `Both takes share seed ${state.seed} — turn on More variation or they will render the same song twice.`;
      el.seedHint.className = 'hint hint--warn';
    } else if (state.seedAuto) {
      el.seedHint.textContent = 'A fresh seed is rolled for each run and reported with the result.';
      el.seedHint.className = 'hint';
    } else {
      el.seedHint.textContent = 'Pinned — the same seed and prompt render the same song.';
      el.seedHint.className = 'hint';
    }

    for (const b of el.formats.querySelectorAll('[data-format]')) {
      b.classList.toggle('is-active', b.dataset.format === state.format);
    }
    el.bitrate.hidden = state.format !== 'mp3';
    el.bitrateSelect.value = String(state.bitrate);

    el.dual.checked = state.dual;
    el.variationRow.hidden = !state.dual;
    el.variation.checked = state.moreVariation;

    paintFooter();
  }

  function paintFooter() {
    const block = blocker();
    el.notices.replaceChildren();

    if (block && !block.quiet) {
      const n = document.createElement('div');
      n.className = `notice notice--${block.kind === 'error' ? 'error' : block.kind === 'warn' ? 'warn' : 'info'}`;
      n.innerHTML = `<span class="notice__icon">${iconMarkup(block.kind === 'info' ? 'info' : 'alert')}</span><div class="notice__body"></div>`;
      const body = n.querySelector('.notice__body');
      const title = document.createElement('p');
      title.className = 'notice__title';
      title.textContent = block.title;
      const text = document.createElement('p');
      text.className = 'notice__text';
      text.textContent = block.text;
      body.append(title, text);

      if (block.retry) {
        const b = document.createElement('button');
        b.className = 'btn btn--sm';
        b.type = 'button';
        b.append(ctx.icon('refresh'), document.createTextNode('Re-check backend'));
        b.addEventListener('click', () => { b.disabled = true; ctx.refreshHealth().finally(() => { b.disabled = false; }); });
        body.append(b);
      }
      if (block.instrumental) {
        const b = document.createElement('button');
        b.className = 'btn btn--sm';
        b.type = 'button';
        b.textContent = 'Switch to Instrumental';
        b.addEventListener('click', () => setInstrumental(true));
        body.append(b);
      }
      el.notices.append(n);
    }

    el.cta.disabled = state.running || Boolean(block);
    el.cancel.hidden = !state.running;
    el.footHint.hidden = state.running;
    el.ctaIcon.innerHTML = state.running ? iconMarkup('spinner', 'icon spinner') : iconMarkup('create');

    if (state.running) {
      el.ctaLabel.textContent = state.phase === 'lyrics' ? 'Writing lyrics…' : 'Rendering audio…';
    } else {
      el.ctaLabel.textContent = state.instrumental ? 'Create instrumental' : 'Create song';
    }

    el.footHint.textContent = state.instrumental
      ? `One call — POST /api/generate${state.dual ? '-dual' : ''}.`
      : `Two calls — POST /api/lyrics, then POST /api/generate${state.dual ? '-dual' : ''}.`;
  }

  /* ---------------------------------------------------------- stage paint */

  function factRow(label, value) {
    const li = document.createElement('li');
    li.className = 'facts__item';
    const k = document.createElement('span');
    k.className = 'facts__k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'facts__v mono';
    v.textContent = value;
    li.append(k, v);
    return li;
  }

  function renderLyricLines(box, text, animate) {
    box.replaceChildren();
    const lines = String(text).split('\n');
    lines.forEach((line, i) => {
      const div = document.createElement('div');
      const isTag = /^\s*\[[a-z][a-z-]*\]\s*$/.test(line);
      div.className = `lyricline${isTag ? ' is-tag' : ''}${line.trim() ? '' : ' is-blank'}`;
      div.textContent = line.trim() ? line : ' ';
      if (animate) div.style.animationDelay = `${Math.min(i * 28, 1200)}ms`;
      else div.style.animation = 'none';
      box.append(div);
    });
  }

  /** Empty stage — teaches the two-step flow with facts from /api/health. */
  function stageIdle() {
    const wrap = document.createElement('div');
    wrap.className = 'stage-empty';
    wrap.innerHTML = `
      <span class="brandmark stage-empty__mark" style="--mark-size: 180px"><img src="/logo.png" alt=""></span>
      <h2 class="stage-empty__title">Nothing rendered yet</h2>
      <p class="stage-empty__text">One line of intent is enough. MaxMusic writes the lyrics, then renders the audio, and both steps show their work here.</p>
      <ol class="pipeline"></ol>`;

    const pipe = wrap.querySelector('.pipeline');
    const lyricsProvider = health?.lyricsProvider || 'checking…';
    const modelLabel = health?.modelKeys?.length
      ? (health.musicModels[health.modelKeys[0]] || health.modelKeys[0])
      : 'checking…';
    const host = health?.comfyUrl ? health.comfyUrl.replace(/^https?:\/\//, '') : (health?.backend || 'checking…');

    const renderCall = `POST /api/generate${state.dual ? '-dual' : ''}`;
    const rows = state.instrumental
      ? [['1', 'Render audio', `${renderCall} · ${host}`]]
      : [['1', 'Write lyrics', `POST /api/lyrics · ${lyricsProvider}`],
         ['2', 'Render audio', `${renderCall} · ${host}`]];

    for (const [n, title, meta] of rows) {
      const li = document.createElement('li');
      li.className = 'pipeline__item';
      const num = document.createElement('span');
      num.className = 'pipeline__n';
      num.textContent = n;
      const body = document.createElement('span');
      body.className = 'pipeline__body';
      const t = document.createElement('span');
      t.className = 'pipeline__title';
      t.textContent = title;
      const m = document.createElement('span');
      m.className = 'pipeline__meta mono';
      m.textContent = meta;
      body.append(t, m);
      li.append(num, body);
      pipe.append(li);
    }

    const foot = document.createElement('p');
    foot.className = 'stage-empty__foot mono';
    foot.textContent = `${modelLabel} · ${state.dual ? 'two takes in parallel' : 'one take'}`;
    wrap.append(foot);
    return wrap;
  }

  function stepNode(key, index, title) {
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.state = state.steps[key];
    li.innerHTML = `
      <span class="step__node"><span class="step__num">${index}</span></span>
      <div class="step__body">
        <div class="step__head">
          <span class="step__title"></span>
          <span class="step__meta mono"></span>
        </div>
      </div>`;
    li.querySelector('.step__title').textContent = title;
    if (state.steps[key] === 'done') {
      li.querySelector('.step__num').replaceWith(ctx.icon('check', 'icon step__tick'));
    } else if (state.steps[key] === 'error') {
      li.querySelector('.step__num').replaceWith(ctx.icon('alert', 'icon step__tick'));
    }
    return li;
  }

  function lyricsStep() {
    const step = stepNode('lyrics', 1, state.steps.lyrics === 'active' ? 'Writing lyrics' : 'Lyrics');
    const body = step.querySelector('.step__body');
    const meta = step.querySelector('.step__meta');

    if (state.steps.lyrics === 'active') {
      meta.textContent = health?.lyricsProvider || 'local codex';
      const wait = document.createElement('div');
      wait.className = 'waiting';
      wait.innerHTML = `<span class="skeleton" style="width:82%"></span><span class="skeleton" style="width:64%"></span><span class="skeleton" style="width:74%"></span><span class="skeleton" style="width:48%"></span>`;
      body.append(wait);
      return step;
    }

    if (state.steps.lyrics === 'error') {
      meta.textContent = '';
      body.append(errorBlock(state.error, [
        { label: 'Retry lyrics', run: () => start({ lyricsOnly: true }) },
        { label: 'Switch to Instrumental', run: () => setInstrumental(true) },
      ]));
      return step;
    }

    if (!state.song) return null;

    meta.textContent = [state.song.provider, state.song.model].filter(Boolean).join(' · ');

    const head = document.createElement('div');
    head.className = 'songhead';
    const t = document.createElement('p');
    t.className = 'songhead__title';
    t.textContent = state.song.title || titleFromIdea(state.idea);
    head.append(t);
    if (state.song.styleTags) {
      const tags = document.createElement('div');
      tags.className = 'tags';
      for (const tag of state.song.styleTags.split(/[,;]/).map((s) => s.trim()).filter(Boolean).slice(0, 8)) {
        const c = document.createElement('span');
        c.className = 'tag';
        c.textContent = tag;
        tags.append(c);
      }
      head.append(tags);
    }
    body.append(head);

    if (state.editingLyrics) {
      const ta = document.createElement('textarea');
      ta.className = 'textarea textarea--mono lyricsedit';
      ta.value = state.song.lyrics;
      ta.setAttribute('maxlength', String(LIMITS.LYRICS_MAX));
      ta.addEventListener('input', () => { state.song.lyrics = ta.value; });
      body.append(ta);
    } else {
      const box = document.createElement('div');
      box.className = 'lyricsbox';
      renderLyricLines(box, state.song.lyrics, state.steps.render !== 'done' && state.phase !== 'idle');
      body.append(box);
    }

    const actions = document.createElement('div');
    actions.className = 'step__actions';
    actions.append(
      miniBtn(state.editingLyrics ? 'Done editing' : 'Edit', 'wand', () => {
        state.editingLyrics = !state.editingLyrics;
        paintStage();
      }),
      miniBtn('Rewrite', 'refresh', () => start({ lyricsOnly: true }), state.running),
      miniBtn('Copy', 'copy', async () => {
        try {
          await navigator.clipboard.writeText(state.song.lyrics);
          ctx.toast('Lyrics copied.', { kind: 'success' });
        } catch (err) {
          ctx.toast(api.errorText(err), { kind: 'error', title: 'Copy failed' });
        }
      }),
    );
    const count = document.createElement('span');
    count.className = 'step__count mono';
    count.textContent = `${state.song.lyrics.length} / ${LIMITS.LYRICS_MAX}`;
    actions.append(count);
    body.append(actions);
    return step;
  }

  /** The run panel describes the run that happened, not the form's current state. */
  function ranInstrumental() {
    return state.facts ? state.facts.instrumental : state.instrumental;
  }

  function renderStep() {
    const index = ranInstrumental() ? 1 : 2;
    const active = state.steps.render === 'active';
    const step = stepNode('render', index, active ? 'Rendering audio' : 'Audio');
    const body = step.querySelector('.step__body');
    const meta = step.querySelector('.step__meta');
    const f = state.facts;

    if (active) {
      meta.textContent = elapsedText();
      meta.dataset.elapsed = '1';

      const eq = document.createElement('div');
      eq.className = 'eq';
      eq.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 36; i += 1) {
        const bar = document.createElement('span');
        bar.style.setProperty('--i', String(i));
        // Scattered phase + tempo so it reads as a level meter, not a staircase.
        bar.style.animationDelay = `${-Math.round(Math.random() * 1400)}ms`;
        bar.style.animationDuration = `${820 + Math.round(Math.random() * 620)}ms`;
        bar.style.setProperty('--peak', (0.42 + Math.random() * 0.58).toFixed(2));
        eq.append(bar);
      }
      body.append(eq);

      const line = document.createElement('p');
      line.className = 'render__line';
      line.textContent = f?.dual
        ? 'Two renders are running in parallel on ComfyUI.'
        : 'ComfyUI is running the MiniMax Music 3 workflow.';
      body.append(line);
    }

    if (state.steps.render === 'error') {
      body.append(errorBlock(state.error, [
        { label: 'Try again', run: () => start({ skipLyrics: Boolean(state.song) || state.instrumental }) },
      ]));
    }

    if (f) {
      const facts = document.createElement('ul');
      facts.className = 'facts';
      facts.append(
        factRow('length', `${f.duration}s · ${clock(f.duration)}`),
        factRow('seed', f.seed === null ? 'server-assigned per take' : String(f.seed)),
        factRow('format', f.format === 'mp3' ? `mp3 · ${f.bitrate / 1000} kbps` : f.format),
        factRow('takes', f.dual ? (f.moreVariation ? 'A + B · more variation' : 'A + B') : 'one'),
        factRow('mode', f.instrumental ? 'instrumental' : 'vocal'),
      );
      if (f.model) {
        const row = factRow('model', f.model);
        row.classList.add('facts__item--wide');
        facts.append(row);
      }
      body.append(facts);

      const cap = document.createElement('details');
      cap.className = 'caption';
      cap.innerHTML = '<summary class="caption__sum">Caption sent to the model</summary>';
      const pre = document.createElement('pre');
      pre.className = 'caption__pre mono';
      pre.textContent = f.prompt;
      cap.append(pre);
      body.append(cap);
    }

    return step;
  }

  function miniBtn(label, iconName, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--sm btn--ghost';
    b.disabled = Boolean(disabled);
    if (iconName) b.append(ctx.icon(iconName));
    b.append(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  function errorBlock(err, actions = []) {
    const n = document.createElement('div');
    n.className = 'notice notice--error';
    n.innerHTML = `<span class="notice__icon">${iconMarkup('alert')}</span><div class="notice__body"></div>`;
    const body = n.querySelector('.notice__body');

    const title = document.createElement('p');
    title.className = 'notice__title';
    title.textContent =
      err?.name === 'ValidationError' ? 'This request cannot be sent'
        : !err?.status ? 'Could not reach the server'
          : err.status === 501 ? 'Not supported by this backend · HTTP 501'
            : `The backend refused · HTTP ${err.status}`;
    const text = document.createElement('p');
    text.className = 'notice__text';
    text.textContent = api.errorText(err);
    body.append(title, text);

    if (err?.status === 501) {
      const p = document.createElement('p');
      p.className = 'notice__text notice__text--muted';
      p.textContent = 'This capability is not provided by the current backend. Settings shows what /api/health reports.';
      body.append(p);
    }

    const row = document.createElement('div');
    row.className = 'row row--wrap notice__actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn btn--sm';
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', a.run);
      row.append(b);
    }
    if (row.children.length) body.append(row);
    return n;
  }

  function takeCard(result, slot) {
    const card = document.createElement('article');
    card.className = 'take';

    const art = document.createElement('button');
    art.type = 'button';
    art.className = 'take__art';
    art.title = ctx.player ? 'Play' : `Player unavailable — ${ctx.playerUnavailableReason}`;
    art.setAttribute('aria-label', `Play ${slot ? `take ${slot}` : 'track'}`);
    art.append(ctx.icon('play', 'icon take__play'));
    if (slot) {
      const badge = document.createElement('span');
      badge.className = 'take__slot';
      badge.textContent = slot;
      art.append(badge);
    }

    const body = document.createElement('div');
    body.className = 'take__body';

    const title = document.createElement('p');
    title.className = 'take__title';
    title.textContent = state.song?.title || titleFromIdea(state.idea);

    const secs = Number(result?.extra_info?.music_duration) ? Number(result.extra_info.music_duration) / 1000 : state.facts?.duration;
    const meta = document.createElement('p');
    meta.className = 'take__meta mono';
    meta.textContent = [
      clock(secs),
      (state.facts?.format || 'flac').toUpperCase(),
      bytes(result?.track?.size),
      state.facts && state.facts.seed !== null ? `seed ${state.facts.seed}` : null,
    ].filter(Boolean).join('  ·  ');

    const actions = document.createElement('div');
    actions.className = 'take__actions';

    const play = document.createElement('button');
    play.className = 'btn btn--sm';
    play.type = 'button';
    play.append(ctx.icon('play'), document.createTextNode('Play'));
    if (!ctx.player) play.title = `Player unavailable — ${ctx.playerUnavailableReason}`;

    const dl = document.createElement('a');
    dl.className = 'btn btn--sm';
    dl.href = api.mediaUrl(result.track);
    dl.setAttribute('download', result.track?.filename || 'maxmusic');
    dl.append(ctx.icon('download'), document.createTextNode('Download'));

    actions.append(play, dl);

    if (state.facts && state.facts.seed !== null) {
      actions.append(miniBtn('Use this seed', 'dice', () => {
        state.seedAuto = false;
        state.seed = state.facts.seed;
        persist();
        paintForm();
        ctx.toast(`Seed pinned to ${state.facts.seed}.`, { kind: 'success' });
      }));
    }

    const playIt = () => {
      ctx.bus.emit('player:play', {
        track: result.track,
        title: title.textContent,
        meta: trackMeta(result),
      });
    };
    art.addEventListener('click', playIt);
    play.addEventListener('click', playIt);

    body.append(title, meta, actions);
    card.append(art, body);
    return card;
  }

  function trackMeta(result) {
    const meta = {
      title: state.song?.title || titleFromIdea(state.idea),
      prompt: state.facts?.prompt || '',
      lyrics: ranInstrumental() ? '' : (state.song?.lyrics || ''),
      duration: state.facts?.duration ?? state.duration,
      format: state.facts?.format ?? state.format,
      isInstrumental: ranInstrumental(),
      extra_info: result?.extra_info || null,
      createdAt: Date.now(),
    };
    // Only claim a seed when we chose it. Dual + auto lets the backend roll one
    // per take and it does not report them back.
    if (state.facts && state.facts.seed !== null) meta.seed = state.facts.seed;
    return meta;
  }

  function elapsedText() {
    const end = state.finishedAt || Date.now();
    return clock((end - state.startedAt) / 1000);
  }

  function paintStage() {
    el.stage.replaceChildren();

    if (state.phase === 'idle' && !state.song && !state.takes.length && !state.error) {
      el.stage.append(stageIdle());
      return;
    }

    const run = document.createElement('article');
    run.className = 'run';
    run.dataset.phase = state.phase;

    const head = document.createElement('header');
    head.className = 'run__head';

    const badge = document.createElement('span');
    const label = {
      lyrics: ['Writing', 'badge--brand'],
      render: [state.facts?.dual ? 'Rendering ×2' : 'Rendering', 'badge--brand'],
      done: [state.takes.length > 1 ? 'Two takes' : 'Ready', 'badge--ok'],
      error: ['Stopped', 'badge--danger'],
      idle: ['Draft', ''],
    }[state.phase] || ['Draft', ''];
    badge.className = `badge run__badge ${label[1]}`.trim();
    badge.textContent = label[0];
    if (state.running) badge.prepend(Object.assign(document.createElement('span'), { className: 'run__live' }));

    const status = document.createElement('span');
    status.className = 'run__status truncate';
    status.textContent = state.song?.title || titleFromIdea(state.idea);

    const timeEl = document.createElement('span');
    timeEl.className = 'run__time mono';
    timeEl.textContent = state.startedAt ? elapsedText() : '';
    timeEl.dataset.elapsed = '1';

    head.append(badge, status, timeEl);
    run.append(head);
    if (state.running) {
      const bl = document.createElement('div');
      bl.className = 'brandline run__line';
      run.append(bl);
    }

    const steps = document.createElement('ol');
    steps.className = 'steps';
    if (!ranInstrumental()) {
      const ls = lyricsStep();
      if (ls) steps.append(ls);
    }
    if (state.steps.render !== 'pending' || state.takes.length) steps.append(renderStep());
    run.append(steps);

    // Once a track exists it is the hero; the run panel below it is provenance.
    if (state.takes.length) {
      const grid = document.createElement('div');
      grid.className = `takes${state.takes.length > 1 ? ' takes--dual' : ''}`;
      state.takes.forEach((t, i) => {
        if (t?.track) grid.append(takeCard(t, state.takes.length > 1 ? 'AB'[i] : ''));
      });
      el.stage.append(grid);
    }

    for (const e of state.takeErrors) {
      const n = document.createElement('div');
      n.className = 'notice notice--warn';
      n.innerHTML = `<span class="notice__icon">${iconMarkup('alert')}</span><div class="notice__body"></div>`;
      const t = document.createElement('p');
      t.className = 'notice__title';
      t.textContent = `Take ${e.slot} failed`;
      const p = document.createElement('p');
      p.className = 'notice__text';
      p.textContent = [e.error, e.details].filter(Boolean).join(' — ');
      n.querySelector('.notice__body').append(t, p);
      el.stage.append(n);
    }

    const canRerender = !state.running
      && (state.instrumental ? state.phase !== 'idle' : state.steps.lyrics === 'done' && state.song);
    if (canRerender) {
      const again = document.createElement('div');
      again.className = 'row row--wrap stage__again';
      const b = document.createElement('button');
      b.className = 'btn';
      b.type = 'button';
      b.append(ctx.icon('refresh'), document.createTextNode(
        state.instrumental ? 'Render again'
          : state.takes.length ? 'Render again with these lyrics'
            : 'Render with these lyrics',
      ));
      b.addEventListener('click', () => start({ skipLyrics: true }));
      again.append(b);

      if (state.takes.length) {
        const lib = document.createElement('button');
        lib.className = 'btn btn--ghost';
        lib.type = 'button';
        lib.append(ctx.icon('library'), document.createTextNode('Open Library'));
        lib.addEventListener('click', () => ctx.navigate('library'));
        again.append(lib);
      }
      // With a track on screen the action belongs under it; without one it is a
      // follow-up to the run record, so it goes after.
      if (state.takes.length) el.stage.append(again, run);
      else el.stage.append(run, again);
    } else {
      el.stage.append(run);
    }
  }

  /** Form choices only affect the stage while it is showing the empty state. */
  function paintIdleStage() {
    if (!state.running && state.phase === 'idle' && !state.song && !state.takes.length && !state.error) paintStage();
  }

  /** Cheap 1 Hz repaint of just the clocks while a run is live. */
  function tick() {
    const text = elapsedText();
    for (const node of el.stage.querySelectorAll('[data-elapsed]')) node.textContent = text;
  }

  /* --------------------------------------------------------------- the run */

  function setInstrumental(on) {
    state.instrumental = Boolean(on);
    persist();
    paintForm();
    if (!state.running) paintStage();
  }

  /**
   * SPEC §3e — one button, two calls.
   * @param {{skipLyrics?: boolean, lyricsOnly?: boolean}} [opts]
   */
  async function start(opts = {}) {
    if (state.running) return;
    const { skipLyrics = false, lyricsOnly = false } = opts;

    const idea = state.idea.trim();
    if (!idea) {
      el.idea.focus();
      ctx.toast('Describe the song first — one line is enough.', { kind: 'warn' });
      return;
    }

    controller = new AbortController();
    const { signal } = controller;

    state.running = true;
    state.error = null;
    state.errorStep = null;
    state.takeErrors = [];
    state.editingLyrics = false;
    state.startedAt = Date.now();
    state.finishedAt = 0;
    // A new run — including a lyrics rewrite — invalidates the previous render.
    // Showing an old take beside new lyrics would be a lie; the track is safe in
    // the library and the player either way.
    state.takes = [];
    state.facts = null;

    clearInterval(ticker);
    ticker = setInterval(tick, 1000);

    const needLyrics = !state.instrumental && !(skipLyrics && state.song?.lyrics);
    state.steps.lyrics = state.instrumental ? 'skipped' : (needLyrics ? 'active' : 'done');
    state.steps.render = 'pending';
    state.phase = needLyrics ? 'lyrics' : 'render';
    if (needLyrics) state.song = null;

    el.edge.classList.add('is-live');
    paintFooter();
    paintStage();

    try {
      /* ---- step 1 — local Codex writes the lyrics -------------------- */
      if (needLyrics) {
        const res = await api.lyrics({ mode: 'write_full_song', prompt: idea, title: '' }, { signal });
        const written = String(res?.lyrics || '').trim();
        if (!written) {
          throw new api.ApiError(
            'The lyrics service returned no lyrics. Vocal generation cannot start without them.',
            { status: 0, endpoint: '/api/lyrics' },
          );
        }
        state.song = {
          title: String(res.song_title || '').trim() || titleFromIdea(idea),
          styleTags: String(res.style_tags || '').trim(),
          lyrics: written,
          provider: res.provider || health?.lyricsProvider || '',
          model: res.model || '',
        };
        state.steps.lyrics = 'done';
        paintStage();
      }

      if (lyricsOnly) {
        state.phase = state.takes.length ? 'done' : 'idle';
        return;
      }

      /* ---- step 2 — render ------------------------------------------ */
      const seedForRun = state.dual && state.seedAuto
        ? null                                   // let the backend roll one per take
        : (state.seedAuto ? randomSeed() : state.seed);

      const input = buildInput(seedForRun);
      const check = api.validateGeneration(input);
      if (!check.valid) throw new api.ValidationError(check.errors);
      for (const w of check.warnings) ctx.toast(w, { kind: 'warn' });

      state.facts = {
        duration: check.payload.duration ?? state.duration,
        seed: seedForRun,
        format: state.format,
        bitrate: state.bitrate,
        dual: state.dual,
        moreVariation: state.dual && state.moreVariation,
        instrumental: state.instrumental,
        prompt: input.prompt,
        model: health?.modelKeys?.length ? (health.musicModels[health.modelKeys[0]] || health.modelKeys[0]) : '',
      };
      state.steps.render = 'active';
      state.phase = 'render';
      paintFooter();
      paintStage();

      if (state.dual) {
        const res = await api.generateDual(input, { signal });
        const takes = [res?.takes?.A, res?.takes?.B].filter((t) => t && t.track);
        state.takeErrors = Array.isArray(res?.errors) ? res.errors : [];
        if (!takes.length) {
          throw new api.ApiError('Both takes failed.', {
            status: 500,
            details: state.takeErrors.map((e) => `${e.slot}: ${e.error}`).join('\n') || null,
            endpoint: '/api/generate-dual',
          });
        }
        state.takes = takes;
      } else {
        const res = await api.generate(input, { signal });
        if (!res?.track) {
          throw new api.ApiError('The backend returned no track.', { status: 500, endpoint: '/api/generate' });
        }
        state.takes = [res];
      }

      state.steps.render = 'done';
      state.phase = 'done';

      for (const t of state.takes) {
        ctx.bus.emit('track:new', { track: t.track, meta: trackMeta(t) });
      }
      ctx.toast(
        state.takes.length > 1 ? 'Two takes rendered.' : 'Track rendered.',
        { kind: 'success', title: state.song?.title || titleFromIdea(idea) },
      );
    } catch (err) {
      if (err?.name === 'AbortError') {
        state.phase = state.takes.length ? 'done' : 'idle';
        if (state.steps.lyrics === 'active') state.steps.lyrics = 'pending';
        if (state.steps.render === 'active') state.steps.render = 'pending';
        state.facts = null;
        ctx.toast('Stopped waiting. A ComfyUI job that already started will still finish on the server.', { kind: 'info', title: 'Cancelled' });
      } else {
        state.error = err;
        state.errorStep = state.steps.lyrics === 'active' ? 'lyrics' : 'render';
        if (state.steps.lyrics === 'active') state.steps.lyrics = 'error';
        else state.steps.render = 'error';
        state.phase = 'error';
        ctx.toast(api.errorText(err), {
          kind: 'error',
          title: state.errorStep === 'lyrics' ? 'Lyrics failed' : 'Generation failed',
        });
      }
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      controller = null;
      clearInterval(ticker);
      ticker = null;
      el.edge.classList.remove('is-live');
      paintFooter();
      paintStage();
      if (state.takes.length) {
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.stage.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      }
    }
  }

  /* ------------------------------------------------------------- wiring */

  el.idea.addEventListener('input', () => {
    state.idea = el.idea.value;
    el.ideaCount.textContent = `${state.idea.length} / ${LIMITS.PROMPT_MAX}`;
    el.starters.hidden = state.idea.trim().length > 0;
    persist();
    paintFooter();
  });

  page.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !state.running && !el.cta.disabled) {
      e.preventDefault();
      start();
    }
  });

  el.shuffle.addEventListener('click', () => {
    state.starters = pickStarters(3);
    paintStarters();
  });

  for (const b of el.modes) {
    b.addEventListener('click', () => setInstrumental(b.dataset.mode === 'instrumental'));
  }

  el.durRange.addEventListener('input', () => {
    state.duration = Number(el.durRange.value);
    persist();
    paintForm();
  });
  el.durNum.addEventListener('input', () => {
    const v = Number(el.durNum.value);
    if (!Number.isFinite(v)) return;
    state.duration = clamp(v, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
    persist();
    paintForm();
  });
  el.durNum.addEventListener('blur', () => { el.durNum.value = String(state.duration); });
  el.presets.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (!p) return;
    state.duration = Number(p.dataset.preset);
    persist();
    paintForm();
  });

  el.seed.addEventListener('input', () => {
    const digits = el.seed.value.replace(/[^0-9]/g, '').slice(0, 10);
    if (digits !== el.seed.value) el.seed.value = digits;
    if (!digits) {
      state.seedAuto = true;
    } else {
      state.seedAuto = false;
      state.seed = clamp(Number(digits), LIMITS.SEED_MIN, LIMITS.SEED_MAX);
    }
    persist();
    paintForm();
  });
  el.seed.addEventListener('blur', () => { el.seed.value = state.seedAuto ? '' : String(state.seed); });
  el.seedAuto.addEventListener('click', () => {
    state.seedAuto = !state.seedAuto;
    if (!state.seedAuto) state.seed = randomSeed();
    persist();
    paintForm();
  });
  el.seedRoll.addEventListener('click', () => {
    state.seedAuto = false;
    state.seed = randomSeed();
    persist();
    paintForm();
  });

  el.formats.addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]');
    if (!f) return;
    state.format = f.dataset.format;
    persist();
    paintForm();
  });
  el.bitrateSelect.addEventListener('change', () => {
    state.bitrate = Number(el.bitrateSelect.value) || LIMITS.BITRATE_DEFAULT;
    persist();
    paintForm();
  });

  el.dual.addEventListener('change', () => {
    state.dual = el.dual.checked;
    persist();
    paintForm();
    paintIdleStage();
  });
  el.variation.addEventListener('change', () => {
    state.moreVariation = el.variation.checked;
    persist();
    paintForm();
  });

  el.cta.addEventListener('click', () => start());
  el.cancel.addEventListener('click', () => controller?.abort());

  ctx.onHealth((snapshot) => {
    health = snapshot;
    paintFooter();
    paintIdleStage();
  });

  /* ---------------------------------------------------------------- boot */

  root.append(page);
  paintStarters();
  paintForm();
  paintStage();
  if (!state.idea) el.idea.focus();

  return () => {
    controller?.abort();
    clearInterval(ticker);
    tabs.remove();
  };
}
