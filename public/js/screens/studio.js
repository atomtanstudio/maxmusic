/**
 * Studio — the power screen.
 *
 * Owns the three-part structured caption (SPEC §3c), the lyrics editor and the
 * full per-request parameter surface (SPEC §3a). The three caption fields are
 * joined into the single `prompt` string on submit; nothing else is sent.
 *
 * Deliberately absent: guidance/cfg, flow-matching steps, `lyrics_optimizer`.
 * Those are server env only (SPEC §3b) and a control for them is a defect.
 *
 * Owned by the studio lane: this file and public/css/screens/studio.css.
 *
 * @module screens/studio
 */

export const meta = {
  title: 'Studio',
  subtitle: 'Lyrics + structured caption, full control',
  css: '/css/screens/studio.css',
};

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const STORAGE_KEY = 'studio.draft';

/** Words per 10 seconds of singing — SPEC §3d. */
const WORDS_PER_10S = [12, 16];

/** Midpoint of the band, in words per second, for the singing-time estimate. */
const WORDS_PER_SEC = 1.4;

/**
 * The three caption fields, each with the labelled sub-structure SPEC §3c
 * requires. `test` decides whether a label is already present in the text, so
 * the chips can tick themselves off as the writer works.
 */
const CAPTION_FIELDS = [
  {
    key: 'global',
    label: 'Global metadata',
    lede: 'One paragraph, these four labels in this order.',
    grammar: 'Basic Attributes: bpm is <n>. key is <letter>, and scale is <major|minor>. <Genre / Subgenre>.',
    parts: [
      { label: 'Basic Attributes', hint: 'bpm · key · scale · genre' },
      { label: 'Global Emotional Progression', hint: 'the arc, section by section' },
      { label: 'Application Scenarios & Imagery', hint: 'where this plays, what it looks like' },
      { label: 'Sonics & Production Profile', hint: 'space, saturation, low end, top end' },
    ],
  },
  {
    key: 'vocal',
    label: 'Vocal details',
    lede: 'Who is singing, how, and what sits behind them.',
    grammar: 'Vocal Gender & Timbre: Singer A (<Male|Female>), <timbre/register>.',
    parts: [
      { label: 'Vocal Gender & Timbre', hint: 'Singer A (Female), warm alto…' },
      { label: 'Vocal Style', hint: 'phrasing and delivery per section' },
      { label: 'Harmony/Backing Vocals', hint: 'stacks, thirds, octaves, where' },
      { label: 'Vocal FX', hint: 'delay, plate, throws, de-essing' },
    ],
    /** Instrumental swaps the whole sub-structure — SPEC §3c.2. */
    instrumentalParts: [
      { label: 'Instrumental, no vocals.', hint: 'state it plainly', literal: true, test: /instrumental,\s*no\s*vocals/i },
      { label: 'Lead Melodic Voice', hint: 'the instrument that carries the tune' },
    ],
    instrumentalGrammar: 'Instrumental, no vocals. Lead Melodic Voice: <instrument, register, articulation>.',
  },
  {
    key: 'arrangement',
    label: 'Arrangement',
    lede: 'Lifecycles, not a gear list — state what enters, exits and intensifies per section.',
    grammar: 'Instrument Lifecycle Description (Primary/Secondary Layering): Primary: … Secondary: …',
    parts: [
      { label: 'Instrument Lifecycle Description (Primary/Secondary Layering)', short: 'Instrument Lifecycle', hint: 'Primary: … Secondary: …' },
      { label: 'Groove & Foundation Progression', hint: 'drums and bass, section by section' },
      { label: 'Embellishments, Textures & Spatial FX', hint: 'risers, noise beds, panning, tape stops' },
    ],
  },
];

/** A complete, well-formed draft. Loaded on demand from the topbar. */
const EXAMPLE = {
  title: 'Neon Harbour',
  global:
    'Basic Attributes: bpm is 112. key is F, and scale is minor. Synth-Pop / Nu-Disco.\n'
    + 'Global Emotional Progression: Opens guarded and nocturnal under wide reverb. The verse leans forward with cautious hope, the pre-chorus holds its breath, and the chorus breaks open into moving light. The bridge strips back to doubt before the last chorus returns unguarded.\n'
    + 'Application Scenarios & Imagery: A rain-slick container port at 2am, sodium lamps in black water, wet concrete under sweeping headlights.\n'
    + 'Sonics & Production Profile: Analogue-warm and wide. Saturated tape bus, soft-knee compression on the drums, long plate on the vocal behind a short slap, sub-bass mono below 90 Hz, airy top end.',
  vocal:
    'Vocal Gender & Timbre: Singer A (Female), warm alto with a breathy top and a rasp at phrase ends.\n'
    + 'Vocal Style: Conversational and close in the verses, sustained and open-throated in the chorus, with upward scoops into each hook line.\n'
    + 'Harmony/Backing Vocals: Verses single-tracked and dry. Chorus doubled with a third above and a soft octave below. Bridge answered by a distant pad of oohs.\n'
    + 'Vocal FX: Short slap into a long plate, a quarter-note throw on the last chorus word, gentle de-essing.',
  arrangement:
    'Instrument Lifecycle Description (Primary/Secondary Layering): Primary: analogue poly pad, muted funk guitar, round electric bass, live-feel kit in a tight room. Secondary: FM bell arpeggio from the pre-chorus, tambourine from the second verse, low brass under the final chorus.\n'
    + 'Groove & Foundation Progression: Intro is pulse and pad alone. The verse adds bass and a sidesticked backbeat. The pre-chorus drops the kick for two bars and lets the hats carry the tension. The chorus lands four-on-the-floor with an open hat on the upbeat. The bridge removes drums, then one crash re-enters the last chorus.\n'
    + 'Embellishments, Textures & Spatial FX: Reverse-cymbal into each chorus, vinyl noise under intro and outro, a filtered riser through the pre-chorus, guitar doubles panned wide, tape stop on the final bar.',
  lyrics:
    '[intro]\n\n'
    + '[verse]\nStreetlights bleed across the harbour wall\nI count the cranes like teeth against the dark\nYou said you\'d wait until the ferry called\nAnd I believed the quiet in your heart\n\n'
    + '[pre-chorus]\nSo hold the line, the tide is coming in\nHold the line, don\'t let the morning win\n\n'
    + '[chorus]\nWe are neon on the water\nBurning brighter than we ought to\nEvery siren says go under\nBut I am still awake\nWe are neon on the water\nFalling faster than we thought to\nLet the whole horizon shudder\nI am still awake\n\n'
    + '[verse]\nThe rain has made a mirror of the road\nAnd every headlight doubles into two\nI carry what the harbour never told\nA name I only ever spent on you\n\n'
    + '[chorus]\nWe are neon on the water\nBurning brighter than we ought to\nEvery siren says go under\nBut I am still awake\n\n'
    + '[bridge]\nCut the engine, let it drift\nCount the seconds, feel them lift\n\n'
    + '[outro]\nStill awake\nStill awake\n',
  duration: 120,
};

/* ========================================================================== *
 * Module-level in-flight job
 *
 * A local render takes minutes. Leaving the screen must not kill it, so the
 * job lives on the module and the mounted screen attaches a hook to it. The
 * job itself owns the side effects that must happen regardless of what is on
 * screen (toast + `track:new`); the hook only paints DOM.
 * ========================================================================== */

/** @type {?{controller: AbortController, promise: Promise<*>, startedAt: number,
 *           dual: boolean, hook: ?Function, status: string, meta: Object}} */
let job = null;

/* ========================================================================== *
 * Pure helpers
 * ========================================================================== */

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Tokens that contain a letter or a digit. Hyphenates count once. */
function countWords(text) {
  const t = String(text).trim();
  if (!t) return 0;
  return t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** 125 -> "2:05". Sub-second durations keep their decimals. */
function clock(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 1) return `${Number(s.toFixed(2))}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(v / 1024))} KB`;
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Sung-word target for a duration — SPEC §3d. */
function wordTarget(duration) {
  const d = Math.max(0, Number(duration) || 0);
  return [Math.round((d / 10) * WORDS_PER_10S[0]), Math.round((d / 10) * WORDS_PER_10S[1])];
}

/** Structure MM3 expects at this length — SPEC §3d. */
function recommendedStructure(duration) {
  const d = Number(duration) || 0;
  if (d <= 30) return ['[verse]', '[chorus]'];
  if (d < 120) return ['[verse]', '[pre-chorus]', '[chorus]', '[verse]', '[chorus]'];
  return ['[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[verse]', '[chorus]', '[bridge]', '[chorus]', '[outro]'];
}

/**
 * Replace a textarea's content through the undo stack when the browser allows
 * it, so ⌘Z still works after an auto-fix or a Codex draft.
 */
function replaceAll(ta, next) {
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('insertText', false, next); } catch { ok = false; }
  if (!ok) ta.value = next;
  ta.setSelectionRange(next.length, next.length);
}

/** Insert at the caret, same undo-preserving trick. */
function insertAtCaret(ta, text) {
  ta.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) {
    const { selectionStart: a, selectionEnd: b } = ta;
    ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
    ta.setSelectionRange(a + text.length, a + text.length);
  }
}

/** Put `tag` on a line of its own at the caret — SPEC §3d. */
function insertOnOwnLine(ta, tag) {
  const before = ta.value.slice(0, ta.selectionStart);
  const lead = before.length && !before.endsWith('\n') ? '\n' : '';
  insertAtCaret(ta, `${lead}${tag}\n`);
}

/* ========================================================================== *
 * Lyrics analysis — SPEC §3d
 * ========================================================================== */

/** Set from `ctx.api.SECTION_TAGS` at mount; the nine legal names, no brackets. */
let LEGAL_NAMES = [];

/**
 * Classify every line. Offsets are kept so a lint row can select its line.
 *
 * kind: 'blank' | 'tag' | 'lyric'
 * tag flags: legal, extra (words after the tag), caseIssue, fixTo (legal name)
 * lyric flags: bareTag (a section name with no brackets), inlineTag
 */
function classifyLines(text) {
  const out = [];
  let offset = 0;
  for (const raw of String(text).split('\n')) {
    const start = offset;
    offset += raw.length + 1;
    const rec = { raw, start, end: start + raw.length, kind: 'lyric', words: 0 };
    const trimmed = raw.trim();

    if (!trimmed) { rec.kind = 'blank'; out.push(rec); continue; }

    const m = /^(\s*)(\[([^\]]*)\])(.*)$/.exec(raw);
    if (m) {
      const literal = m[2];
      const inner = m[3];
      const name = inner.trim().toLowerCase();
      const rest = m[4];
      const stripped = name.replace(/[\s_-]*\d+\s*$/, '').trim();
      rec.kind = 'tag';
      rec.lead = m[1];
      rec.literal = literal;
      rec.rest = rest;
      rec.name = name;
      rec.legal = LEGAL_NAMES.includes(name);
      rec.caseIssue = rec.legal && literal !== `[${name}]`;
      rec.extra = rest.trim().length > 0;
      rec.fixTo = rec.legal ? name : (LEGAL_NAMES.includes(stripped) ? stripped : null);
      out.push(rec);
      continue;
    }

    const bare = /^([a-z][a-z-]*)\s*[:.]?$/i.exec(trimmed);
    if (bare && LEGAL_NAMES.includes(bare[1].toLowerCase())) {
      rec.bareTag = bare[1].toLowerCase();
      rec.words = countWords(trimmed);
      out.push(rec);
      continue;
    }

    rec.inlineTag = /\[[^\]]*\]/.test(trimmed);
    rec.words = countWords(trimmed);
    out.push(rec);
  }
  return out;
}

/**
 * Full analysis: line records, section outline, sung-word count and the lint
 * list. Everything the fit indicator and the validation panel need.
 */
function analyse(text, { duration, instrumental }) {
  const lines = classifyLines(text);
  const issues = [];
  const sections = [];
  let sungWords = 0;
  let current = null;

  for (const rec of lines) {
    if (rec.kind === 'tag') {
      if (!rec.legal) {
        issues.push({
          severity: 'error',
          line: rec,
          fixable: Boolean(rec.fixTo),
          message: rec.fixTo
            ? `"${rec.literal.trim()}" is not one of the nine tags — MM3 reads it as a lyric line. Use [${rec.fixTo}].`
            : `"${rec.literal.trim()}" is not one of the nine tags. MM3 will sing it. Legal tags: ${LEGAL_NAMES.map((n) => `[${n}]`).join(' ')}.`,
        });
      } else if (rec.caseIssue) {
        issues.push({
          severity: 'warn',
          line: rec,
          fixable: true,
          message: `Write the tag exactly as [${rec.name}] — lower case, no padding.`,
        });
      }
      if (rec.extra) {
        issues.push({
          severity: 'error',
          line: rec,
          fixable: true,
          message: `Words on a tag line are dropped — "${rec.rest.trim()}" will never be sung. Move it to the next line.`,
        });
      }
      if (rec.legal || rec.fixTo) {
        current = { name: rec.fixTo || rec.name, line: rec, words: 0 };
        sections.push(current);
      }
      continue;
    }

    if (rec.kind === 'blank') continue;

    if (rec.bareTag) {
      issues.push({
        severity: 'warn',
        line: rec,
        fixable: true,
        message: `"${rec.raw.trim()}" looks like a section header. Section tags need brackets: [${rec.bareTag}].`,
      });
    } else if (rec.inlineTag) {
      issues.push({
        severity: 'warn',
        line: rec,
        fixable: false,
        message: 'A bracketed tag mid-line is sung as text. Tags belong alone on their own line.',
      });
    }

    sungWords += rec.words;
    if (current) current.words += rec.words;
    else if (rec.words) {
      if (!sections.length || sections[0].name !== null) sections.unshift({ name: null, line: rec, words: 0 });
      sections[0].words += rec.words;
    }
  }

  const [lo, hi] = wordTarget(duration);
  const hasText = text.trim().length > 0;

  if (hasText && !sections.some((s) => s.name)) {
    issues.push({
      severity: 'warn',
      line: null,
      fixable: false,
      message: 'No section tags. MM3 is trained on tagged sections — start with [intro] or [verse].',
    });
  }

  if (instrumental && sungWords > 0) {
    issues.push({
      severity: 'warn',
      line: null,
      fixable: false,
      message: `Instrumental is on, so these ${sungWords} words are ignored. Instrumentals use [instrumental] sections with no words.`,
    });
  } else if (hasText && !instrumental && sungWords > 0) {
    if (sungWords < lo) {
      issues.push({
        severity: 'warn',
        line: null,
        fixable: false,
        message: `${sungWords} sung words is thin for ${clock(duration)} — aim for ${lo}–${hi}. Expect long instrumental stretches.`,
      });
    } else if (sungWords > hi) {
      issues.push({
        severity: 'warn',
        line: null,
        fixable: false,
        message: `${sungWords} sung words is dense for ${clock(duration)} — aim for ${lo}–${hi}, or raise the duration to ${clock(Math.ceil(sungWords / WORDS_PER_10S[1] * 10))}.`,
      });
    }
  }

  if (!instrumental && hasText) {
    const want = recommendedStructure(duration);
    const present = new Set(sections.map((s) => s.name).filter(Boolean));
    const missing = [...new Set(want.map((t) => t.slice(1, -1)))].filter((n) => !present.has(n));
    if (missing.length) {
      issues.push({
        severity: 'info',
        line: null,
        fixable: false,
        message: `At ${clock(duration)} MM3 expects ${want.join(' ')} — missing ${missing.map((n) => `[${n}]`).join(' ')}.`,
      });
    }
  }

  return {
    lines,
    sections,
    sungWords,
    issues,
    fixable: issues.filter((i) => i.fixable).length,
    errors: issues.filter((i) => i.severity === 'error').length,
    target: [lo, hi],
    sungSeconds: sungWords / WORDS_PER_SEC,
  };
}

/** Apply every mechanically-safe fix the lint panel offers. */
function autofix(text) {
  const out = [];
  for (const rec of classifyLines(text)) {
    if (rec.kind === 'tag' && rec.fixTo) {
      out.push(`[${rec.fixTo}]`);
      if (rec.rest.trim()) out.push(rec.rest.trim());
      continue;
    }
    if (rec.bareTag) { out.push(`[${rec.bareTag}]`); continue; }
    out.push(rec.raw);
  }
  return out.join('\n');
}

/** Colour the editor's backdrop layer. Mirrors `raw` exactly so lines wrap identically. */
function highlight(text, analysis) {
  if (!text) return '';
  const parts = [];
  for (const rec of analysis.lines) {
    if (rec.kind === 'tag') {
      const cls = !rec.legal
        ? (rec.fixTo ? 'ly-tag ly-tag--warn' : 'ly-tag ly-tag--bad')
        : (rec.caseIssue ? 'ly-tag ly-tag--warn' : 'ly-tag');
      parts.push(escapeHtml(rec.lead));
      parts.push(`<i class="${cls}">${escapeHtml(rec.literal)}</i>`);
      parts.push(rec.extra ? `<i class="ly-drop">${escapeHtml(rec.rest)}</i>` : escapeHtml(rec.rest));
    } else if (rec.bareTag || rec.inlineTag) {
      parts.push(`<i class="ly-soft">${escapeHtml(rec.raw)}</i>`);
    } else {
      parts.push(escapeHtml(rec.raw));
    }
    parts.push('\n');
  }
  parts.push('​');
  return parts.join('');
}

/* ========================================================================== *
 * Markup
 * ========================================================================== */

function template(ctx) {
  const i = ctx.iconMarkup;
  const captionBlocks = CAPTION_FIELDS.map((f) => `
    <section class="capfield" data-capfield="${f.key}">
      <header class="capfield__head">
        <h4 class="capfield__label">${escapeHtml(f.label)}</h4>
        <span class="capfield__meter mono" data-cap-meter="${f.key}">0/${f.parts.length} labels</span>
        <button class="btn btn--sm btn--ghost" type="button" data-scaffold="${f.key}">
          ${i('plus')}Add missing labels
        </button>
      </header>
      <p class="capfield__lede">${escapeHtml(f.lede)}</p>
      <div class="partbar" data-partbar="${f.key}"></div>
      <textarea class="textarea capfield__text" data-cap="${f.key}" rows="5"
        spellcheck="true" aria-label="${escapeHtml(f.label)}"></textarea>
      <p class="hint capfield__grammar" data-grammar="${f.key}"></p>
      ${f.key === 'global' ? '<div class="capfield__suggest" data-style-tags hidden></div>' : ''}
    </section>`).join('');

  return `
<div class="studio">

  <div class="studio__main" data-main>
    <div class="studio__wrap">

      <div class="studio__doc">
        <input class="studio__title" data-title type="text" maxlength="120"
               placeholder="Untitled song" aria-label="Song title" autocomplete="off" spellcheck="false">
        <div class="segment" data-mode role="group" aria-label="Vocal or instrumental">
          <button class="segment__item is-active" type="button" data-mode-btn="vocal" aria-pressed="true">Vocal</button>
          <button class="segment__item" type="button" data-mode-btn="instrumental" aria-pressed="false">Instrumental</button>
        </div>
      </div>

      <!-- ============================ LYRICS ============================ -->
      <section class="panel studio__panel" data-lyrics-panel>
        <header class="panel__head studio__head">
          <h3 class="panel__title">${i('lyrics')}Lyrics</h3>
          <span class="studio__count mono" data-lyrics-count>0 / 3500</span>
          <div class="spacer"></div>
          <button class="btn btn--sm" type="button" data-draft>${i('wand')}Draft with Codex</button>
          <button class="btn btn--sm btn--ghost" type="button" data-revise>${i('refresh')}Revise</button>
          <button class="btn btn--sm btn--ghost" type="button" data-skeleton>${i('plus')}Skeleton</button>
        </header>

        <div class="panel__body studio__body">
          <div class="notice notice--info studio__twostep" data-twostep hidden>
            <span class="notice__icon">${i('info')}</span>
            <div>
              <p class="notice__title">Vocal generation needs lyrics</p>
              The music backend will not write them. <b>Draft with Codex</b> posts
              <code class="code">/api/lyrics</code> first and drops the result here, then
              <code class="code">/api/generate</code> renders it.
            </div>
          </div>

          <div class="tagbar" data-tagbar role="group" aria-label="Insert a section tag"></div>

          <div class="lyricbox" data-lyricbox>
            <div class="lyricbox__inner">
              <pre class="lyricbox__hl" data-hl aria-hidden="true"></pre>
              <textarea class="lyricbox__ta" data-lyrics spellcheck="true"
                        aria-label="Lyrics" autocomplete="off" autocapitalize="off"></textarea>
            </div>
          </div>

          <div class="fit" data-fit>
            <div class="fit__head">
              <span class="fit__value gradient-text" data-fit-words>0</span>
              <span class="fit__unit">sung words</span>
              <span class="fit__target" data-fit-target></span>
              <div class="spacer"></div>
              <span class="badge" data-fit-badge>—</span>
            </div>
            <div class="fit__meter">
              <span class="fit__fill" data-fit-fill></span>
              <span class="fit__band" data-fit-band></span>
            </div>
            <p class="fit__foot" data-fit-foot></p>
          </div>

          <div class="sections" data-sections hidden></div>

          <div class="lint" data-lint></div>
        </div>
      </section>

      <!-- ======================= STRUCTURED CAPTION ===================== -->
      <section class="panel studio__panel">
        <header class="panel__head studio__head">
          <h3 class="panel__title">${i('panel')}Structured caption</h3>
          <span class="studio__count mono" data-prompt-count>0 / 2000</span>
          <div class="spacer"></div>
          <button class="btn btn--sm btn--ghost" type="button" data-copy-prompt>${i('copy')}Copy prompt</button>
        </header>
        <div class="panel__body studio__body">
          <p class="hint studio__lede">
            MM3 is trained on a three-part labelled caption. These three fields are joined
            into the single <code class="code">prompt</code> string on submit — roughly
            250–400 words in total, never quoting a lyric line.
          </p>
          ${captionBlocks}
          <details class="composed" data-composed>
            <summary class="composed__summary">
              ${i('chevron-right')}<span>Composed <code class="code">prompt</code></span>
              <span class="composed__meta mono" data-composed-meta></span>
            </summary>
            <pre class="composed__body mono" data-composed-body></pre>
          </details>
        </div>
      </section>
    </div>
  </div>

  <!-- ============================== RENDER =============================== -->
  <aside class="studio__side" data-side>
    <div class="studio__sidewrap">

      <div class="render">
        <header class="render__head">
          <h3 class="render__title">Render</h3>
          <span class="badge" data-backend>checking…</span>
        </header>

        <div class="field">
          <label class="label" for="st-model">Model
            <span class="label__hint" data-model-note></span>
          </label>
          <select class="select" id="st-model" data-model disabled>
            <option value="">Server default</option>
          </select>
        </div>

        <div class="field">
          <label class="label" for="st-duration">Duration
            <span class="label__hint mono" data-duration-read>2:00</span>
          </label>
          <div class="row">
            <input class="range" id="st-duration" type="range" data-duration-range
                   min="5" max="360" step="1" value="120" aria-label="Duration in seconds">
            <input class="input input--num mono" type="number" data-duration-num
                   min="0.04" max="360" step="1" value="120" aria-label="Duration in seconds">
          </div>
          <div class="row row--wrap presets" data-duration-presets></div>
        </div>

        <div class="field">
          <label class="label" for="st-seed">Seed
            <span class="label__hint">empty = random</span>
          </label>
          <div class="row">
            <input class="input mono" id="st-seed" type="number" data-seed placeholder="random"
                   min="0" step="1" autocomplete="off">
            <button class="btn btn--icon" type="button" data-seed-dice title="Roll a random seed">${i('dice')}</button>
            <button class="btn btn--icon btn--ghost" type="button" data-seed-clear title="Clear the seed">${i('close')}</button>
          </div>
          <p class="hint">Same seed + same inputs reproduces the take.</p>
        </div>

        <hr class="divider">

        <div class="grid2">
          <div class="field">
            <label class="label" for="st-format">Format</label>
            <select class="select" id="st-format" data-format></select>
          </div>
          <div class="field">
            <label class="label" for="st-rate">Sample rate</label>
            <select class="select" id="st-rate" data-rate></select>
          </div>
        </div>

        <div class="field">
          <label class="label" for="st-bitrate">Bitrate
            <span class="label__hint" data-bitrate-note>mp3 only</span>
          </label>
          <select class="select" id="st-bitrate" data-bitrate></select>
        </div>

        <label class="switch render__switch">
          <input type="checkbox" data-tiled>
          <span class="switch__track"></span>
          <span class="switch__label">Tiled decode
            <span class="render__sub">saves VRAM on long renders</span>
          </span>
        </label>

        <div class="field">
          <span class="label">Takes</span>
          <div class="segment segment--block" data-takes-seg role="group" aria-label="Number of takes">
            <button class="segment__item is-active" type="button" data-takes="one" aria-pressed="true">One take</button>
            <button class="segment__item" type="button" data-takes="two" aria-pressed="false">Two takes</button>
          </div>
          <p class="hint" data-takes-note></p>
        </div>
      </div>

      <div class="render__foot">
        <div class="render__issues" data-issues></div>
        <div class="render__busy" data-busy hidden>
          <div class="brandline"></div>
          <div class="render__busyrow">
            <svg class="icon spinner" aria-hidden="true"><use href="#i-spinner"/></svg>
            <span data-busy-label>Queued…</span>
            <span class="spacer"></span>
            <span class="mono" data-busy-time>0:00</span>
          </div>
          <button class="btn btn--sm btn--danger btn--block" type="button" data-cancel>Cancel render</button>
        </div>
        <button class="btn btn--primary btn--lg btn--block" type="button" data-generate>
          ${i('wave')}<span data-generate-label>Generate</span>
        </button>
        <p class="render__endpoint mono" data-endpoint>POST /api/generate-stream</p>
      </div>

      <div class="takes" data-takes-list></div>
    </div>
  </aside>
</div>`;
}

/* ========================================================================== *
 * mount
 * ========================================================================== */

/**
 * @param {HTMLElement} root
 * @param {*} ctx  See docs/CONTRACT.md §2.
 * @returns {() => void} teardown
 */
export async function mount(root, ctx) {
  const { api } = ctx;
  const { LIMITS, FORMATS, SAMPLE_RATES, BITRATES, SECTION_TAGS } = api;
  LEGAL_NAMES = SECTION_TAGS.map((t) => t.slice(1, -1));

  /* ---------------------------------------------------------------- state */

  const defaults = {
    title: '',
    instrumental: false,
    lyrics: '',
    global: '',
    vocal: '',
    arrangement: '',
    duration: LIMITS.DURATION_DEFAULT,
    seed: '',
    format: 'flac',
    bitrate: LIMITS.BITRATE_DEFAULT,
    sampleRate: LIMITS.SAMPLE_RATE_DEFAULT,
    tiled: false,
    takes: 'one',
    model: '',
  };

  const stored = ctx.storage.get(STORAGE_KEY, null);
  const state = { ...defaults, ...(stored && typeof stored === 'object' ? stored : {}) };
  // Never trust storage: clamp everything back into SPEC §3a.
  state.duration = clamp(Number(state.duration) || LIMITS.DURATION_DEFAULT, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
  if (!FORMATS.includes(state.format)) state.format = 'flac';
  if (!SAMPLE_RATES.includes(Number(state.sampleRate))) state.sampleRate = LIMITS.SAMPLE_RATE_DEFAULT;
  if (!BITRATES.includes(Number(state.bitrate))) state.bitrate = LIMITS.BITRATE_DEFAULT;
  if (state.takes !== 'two') state.takes = 'one';
  for (const k of ['title', 'lyrics', 'global', 'vocal', 'arrangement', 'seed', 'model']) {
    state[k] = typeof state[k] === 'string' ? state[k] : '';
  }

  let health = ctx.health;
  let alive = true;
  let lastAnalysis = null;
  /** Last style_tags Codex returned, offered as an insert under Global metadata. */
  let styleTags = '';

  /* ----------------------------------------------------------------- DOM */

  const wrap = document.createElement('div');
  wrap.className = 'screen-studio';
  wrap.innerHTML = template(ctx);
  root.append(wrap);

  const q = (sel) => wrap.querySelector(sel);
  const qa = (sel) => Array.from(wrap.querySelectorAll(sel));

  const el = {
    title: q('[data-title]'),
    modeBtns: qa('[data-mode-btn]'),
    lyricsPanel: q('[data-lyrics-panel]'),
    twostep: q('[data-twostep]'),
    tagbar: q('[data-tagbar]'),
    lyricbox: q('[data-lyricbox]'),
    hl: q('[data-hl]'),
    lyrics: q('[data-lyrics]'),
    lyricsCount: q('[data-lyrics-count]'),
    draft: q('[data-draft]'),
    revise: q('[data-revise]'),
    skeleton: q('[data-skeleton]'),
    fit: q('[data-fit]'),
    fitWords: q('[data-fit-words]'),
    fitTarget: q('[data-fit-target]'),
    fitBadge: q('[data-fit-badge]'),
    fitFill: q('[data-fit-fill]'),
    fitBand: q('[data-fit-band]'),
    fitFoot: q('[data-fit-foot]'),
    sections: q('[data-sections]'),
    lint: q('[data-lint]'),
    promptCount: q('[data-prompt-count]'),
    copyPrompt: q('[data-copy-prompt]'),
    composed: q('[data-composed]'),
    composedMeta: q('[data-composed-meta]'),
    composedBody: q('[data-composed-body]'),
    styleTags: q('[data-style-tags]'),
    backend: q('[data-backend]'),
    model: q('[data-model]'),
    modelNote: q('[data-model-note]'),
    durRange: q('[data-duration-range]'),
    durNum: q('[data-duration-num]'),
    durRead: q('[data-duration-read]'),
    durPresets: q('[data-duration-presets]'),
    seed: q('[data-seed]'),
    seedDice: q('[data-seed-dice]'),
    seedClear: q('[data-seed-clear]'),
    format: q('[data-format]'),
    rate: q('[data-rate]'),
    bitrate: q('[data-bitrate]'),
    bitrateNote: q('[data-bitrate-note]'),
    tiled: q('[data-tiled]'),
    takesSeg: qa('[data-takes]'),
    takesNote: q('[data-takes-note]'),
    issues: q('[data-issues]'),
    busy: q('[data-busy]'),
    busyLabel: q('[data-busy-label]'),
    busyTime: q('[data-busy-time]'),
    cancel: q('[data-cancel]'),
    generate: q('[data-generate]'),
    generateLabel: q('[data-generate-label]'),
    endpoint: q('[data-endpoint]'),
    takesList: q('[data-takes-list]'),
    caption: Object.fromEntries(CAPTION_FIELDS.map((f) => [f.key, {
      area: q(`[data-cap="${f.key}"]`),
      bar: q(`[data-partbar="${f.key}"]`),
      meter: q(`[data-cap-meter="${f.key}"]`),
      grammar: q(`[data-grammar="${f.key}"]`),
      scaffold: q(`[data-scaffold="${f.key}"]`),
    }])),
  };

  /* --------------------------------------------------------- persistence */

  const save = debounce(() => ctx.storage.set(STORAGE_KEY, state), 400);

  /* ------------------------------------------------------- static options */

  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f === 'flac' ? 'FLAC — lossless (backend default)' : f.toUpperCase();
    el.format.append(o);
  }
  for (const r of SAMPLE_RATES) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz${r === 32000 ? ' — model native' : ''}`;
    el.rate.append(o);
  }
  for (const b of BITRATES) {
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = `${b / 1000} kbps`;
    el.bitrate.append(o);
  }
  for (const secs of [30, 60, 120, 180, 300]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip--mono';
    b.dataset.preset = String(secs);
    b.textContent = clock(secs);
    el.durPresets.append(b);
  }
  for (const tag of SECTION_TAGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip--mono tagbar__chip';
    b.dataset.tag = tag;
    b.textContent = tag;
    b.title = `Insert ${tag} on its own line`;
    el.tagbar.append(b);
  }

  /* ------------------------------------------------------- caption chips */

  function partsFor(field) {
    return field.key === 'vocal' && state.instrumental ? field.instrumentalParts : field.parts;
  }

  function partPresent(text, part) {
    if (part.test) return part.test.test(text);
    return new RegExp(`${escapeRe(part.label)}\\s*:`, 'i').test(text);
  }

  function partInsert(part) {
    return part.literal ? `${part.label} ` : `${part.label}: `;
  }

  function buildPartBar(field) {
    const box = el.caption[field.key].bar;
    box.replaceChildren();
    for (const part of partsFor(field)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip partchip';
      b.dataset.part = part.label;
      b.title = part.hint ? `${part.label} — ${part.hint}` : part.label;
      b.innerHTML = `${ctx.iconMarkup('check', 'icon partchip__tick')}<span>${escapeHtml(part.short || part.label)}</span>`;
      box.append(b);
    }
    el.caption[field.key].grammar.textContent =
      (field.key === 'vocal' && state.instrumental ? field.instrumentalGrammar : field.grammar) || '';
  }

  function syncCaptionField(field) {
    const refs = el.caption[field.key];
    const text = state[field.key];
    const parts = partsFor(field);
    let present = 0;
    for (const part of parts) {
      const chip = refs.bar.querySelector(`[data-part="${CSS.escape(part.label)}"]`);
      const has = partPresent(text, part);
      if (has) present += 1;
      if (chip) {
        chip.classList.toggle('is-active', has);
        chip.setAttribute('aria-pressed', has ? 'true' : 'false');
      }
    }
    const words = countWords(text);
    refs.meter.textContent = `${present}/${parts.length} labels · ${words} words`;
    refs.meter.dataset.state = present === parts.length ? 'full' : (present ? 'partial' : 'empty');
    refs.scaffold.disabled = present === parts.length;
    refs.scaffold.title = present === parts.length
      ? 'Every label for this field is already present'
      : 'Append the labels this field is still missing';
  }

  /* ----------------------------------------------------------- composing */

  function composePrompt() {
    return CAPTION_FIELDS
      .map((f) => String(state[f.key] || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  function currentInput() {
    const prompt = composePrompt();
    const seed = state.seed === '' ? undefined : Number(state.seed);
    const audio = { format: state.format, sample_rate: Number(state.sampleRate) };
    if (state.format === 'mp3') audio.bitrate = Number(state.bitrate);
    return {
      prompt,
      lyrics: state.lyrics,
      is_instrumental: state.instrumental,
      duration: Number(state.duration),
      seed,
      tiled_decode: state.tiled,
      more_variation: state.takes === 'two',
      model: state.model || undefined,
      audio_setting: audio,
    };
  }

  /* -------------------------------------------------------------- render */

  function autosize() {
    el.lyrics.style.height = 'auto';
    el.lyrics.style.height = `${el.lyrics.scrollHeight}px`;
  }

  function syncLyrics() {
    const text = state.lyrics;
    const analysis = analyse(text, { duration: state.duration, instrumental: state.instrumental });
    lastAnalysis = analysis;

    // backdrop
    el.hl.innerHTML = text
      ? highlight(text, analysis)
      : '<i class="ly-ph">Section tags go alone on their own line. Tap a chip above, or hit Skeleton for the structure this duration wants.</i>';
    autosize();

    // counter
    const over = text.length > LIMITS.LYRICS_MAX;
    el.lyricsCount.textContent = `${text.length.toLocaleString()} / ${LIMITS.LYRICS_MAX.toLocaleString()}`;
    el.lyricsCount.dataset.state = over ? 'over' : (text.length > LIMITS.LYRICS_MAX * 0.9 ? 'near' : '');

    // fit meter
    const [lo, hi] = analysis.target;
    const scale = Math.max(hi * 1.5, analysis.sungWords * 1.08, 1);
    el.fitWords.textContent = String(analysis.sungWords);
    el.fitTarget.textContent = state.instrumental
      ? 'lyrics ignored while Instrumental is on'
      : `target ${lo}–${hi} for ${clock(state.duration)}`;
    el.fitFill.style.width = `${clamp((analysis.sungWords / scale) * 100, 0, 100)}%`;
    el.fitBand.style.left = `${clamp((lo / scale) * 100, 0, 100)}%`;
    el.fitBand.style.width = `${clamp(((hi - lo) / scale) * 100, 0, 100)}%`;

    let fitState = 'empty';
    let badge = '—';
    if (state.instrumental) { fitState = 'off'; badge = 'Instrumental'; }
    else if (!analysis.sungWords) { fitState = 'empty'; badge = 'No lyrics'; }
    else if (analysis.sungWords < lo) { fitState = 'under'; badge = 'Sparse'; }
    else if (analysis.sungWords > hi) { fitState = 'over'; badge = 'Dense'; }
    else { fitState = 'good'; badge = 'Good fit'; }
    el.fit.dataset.fit = fitState;
    el.fitBadge.textContent = badge;
    el.fitBadge.className = `badge ${{ good: 'badge--ok', over: 'badge--warn', under: 'badge--warn', off: 'badge--info', empty: '' }[fitState] || ''}`;

    const tagged = analysis.sections.filter((s) => s.name).length;
    el.fitFoot.textContent = state.instrumental
      ? `Instrumental mode posts is_instrumental — the lyrics field is dropped from the payload.`
      : `≈ ${clock(analysis.sungSeconds)} of singing at ${WORDS_PER_10S.join('–')} words / 10s · ${tagged} tagged ${tagged === 1 ? 'section' : 'sections'}`;

    // section outline
    el.sections.hidden = analysis.sections.length === 0;
    el.sections.replaceChildren();
    for (const s of analysis.sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sectionchip';
      b.dataset.start = String(s.line.start);
      b.dataset.end = String(s.line.end);
      b.innerHTML = `<b>${escapeHtml(s.name ? `[${s.name}]` : 'untagged')}</b><i>${s.words}w</i>`
        + (s.words ? `<u>${clock(s.words / WORDS_PER_SEC)}</u>` : '');
      b.title = 'Jump to this section';
      el.sections.append(b);
    }

    // lint
    el.lint.replaceChildren();
    if (!analysis.issues.length) {
      const ok = document.createElement('p');
      ok.className = 'lint__ok';
      ok.innerHTML = `${ctx.iconMarkup('check')}<span>${text.trim()
        ? 'Lyrics match every §3d rule for this duration.'
        : 'Nothing to check yet.'}</span>`;
      el.lint.append(ok);
    } else {
      if (analysis.fixable) {
        const fixRow = document.createElement('div');
        fixRow.className = 'lint__bar';
        fixRow.innerHTML = `<span>${analysis.issues.length} ${analysis.issues.length === 1 ? 'note' : 'notes'} · ${analysis.fixable} fixable automatically</span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--sm';
        btn.innerHTML = `${ctx.iconMarkup('wand')}Auto-fix ${analysis.fixable}`;
        btn.addEventListener('click', () => {
          replaceAll(el.lyrics, autofix(el.lyrics.value));
          state.lyrics = el.lyrics.value;
          save();
          syncLyrics();
          syncValidation();
          ctx.toast('Tags normalised and dropped words moved onto their own lines.', { kind: 'success', title: 'Lyrics fixed' });
        });
        fixRow.append(btn);
        el.lint.append(fixRow);
      }
      const list = document.createElement('ul');
      list.className = 'lint__list';
      for (const issue of analysis.issues) {
        const li = document.createElement('li');
        li.className = 'lint__row';
        li.dataset.sev = issue.severity;
        if (issue.line) {
          li.dataset.start = String(issue.line.start);
          li.dataset.end = String(issue.line.end);
        }
        const lineNo = issue.line ? analysis.lines.indexOf(issue.line) + 1 : null;
        li.innerHTML = `
          <span class="lint__sev">${ctx.iconMarkup(issue.severity === 'info' ? 'info' : 'alert')}</span>
          <span class="lint__line mono">${lineNo ? `L${lineNo}` : '—'}</span>
          <span class="lint__msg"></span>`;
        li.querySelector('.lint__msg').textContent = issue.message;
        list.append(li);
      }
      el.lint.append(list);
    }

    el.twostep.hidden = state.instrumental || Boolean(text.trim());
    el.lyricsPanel.dataset.ignored = state.instrumental ? 'true' : 'false';
    syncLyricButtons();
  }

  /**
   * The two Codex buttons, in one place — they are gated by three separate
   * facts and each one has to state its own reason.
   */
  function syncLyricButtons() {
    const providerOff = health ? !health.lyricsEnabled : false;
    const busy = Boolean(lyricsJob);
    const reason = providerOff
      ? `/api/health reports lyrics: ${health.lyricsProvider} — this backend cannot write lyrics.`
      : (state.instrumental
        ? 'Instrumental is on, so the lyrics field is dropped from the payload.'
        : `POST /api/lyrics via ${health?.lyricsProvider || 'the local lyrics service'}`);

    el.draft.disabled = providerOff || state.instrumental || busy;
    el.revise.disabled = el.draft.disabled || !state.lyrics.trim();
    el.draft.title = reason;
    el.revise.title = !el.draft.disabled && !state.lyrics.trim()
      ? 'Nothing to revise yet — write or draft some lyrics first.'
      : reason;
  }

  function syncCaption() {
    for (const f of CAPTION_FIELDS) syncCaptionField(f);
    const prompt = composePrompt();
    const chars = prompt.length;
    const words = countWords(prompt);
    el.promptCount.textContent = `${chars.toLocaleString()} / ${LIMITS.PROMPT_MAX.toLocaleString()}`;
    el.promptCount.dataset.state = chars > LIMITS.PROMPT_MAX ? 'over' : (chars > LIMITS.PROMPT_MAX * 0.9 ? 'near' : '');
    el.composedMeta.textContent = `${words} words · ${chars.toLocaleString()} chars`;
    el.composedMeta.dataset.state = words >= 250 && words <= 400 ? 'ok' : 'off';
    el.composedBody.textContent = prompt || '(empty — the request would carry no caption)';
    el.copyPrompt.disabled = !prompt;
  }

  function syncValidation() {
    const v = api.validateGeneration(currentInput());
    el.issues.replaceChildren();

    const blockedByBackend = health && health.status !== 'online'
      ? (health.comfyError || health.message)
      : '';

    for (const text of v.errors) {
      el.issues.append(issueNode('error', text));
    }
    if (blockedByBackend) el.issues.append(issueNode('error', blockedByBackend));
    for (const text of v.warnings) el.issues.append(issueNode('warn', text));

    const busy = Boolean(job);
    el.generate.disabled = !v.valid || Boolean(blockedByBackend) || busy;
    el.generateLabel.textContent = busy
      ? 'Rendering…'
      : (state.takes === 'two' ? 'Generate two takes' : 'Generate');
    el.endpoint.textContent = state.takes === 'two'
      ? 'POST /api/generate-dual  ·  more_variation: true'
      : 'POST /api/generate-stream';
    el.takesNote.textContent = state.takes === 'two'
      ? 'Posts /api/generate-dual with more_variation, so take B explores a different arrangement.'
      : 'Streams /api/generate-stream so status arrives while ComfyUI works.';
    return v;
  }

  function issueNode(kind, text) {
    const p = document.createElement('p');
    p.className = `render__issue render__issue--${kind}`;
    p.innerHTML = `${ctx.iconMarkup(kind === 'error' ? 'alert' : 'info')}<span></span>`;
    p.querySelector('span').textContent = text;
    return p;
  }

  function syncControls() {
    el.title.value = state.title;
    el.lyrics.value = state.lyrics;
    for (const f of CAPTION_FIELDS) el.caption[f.key].area.value = state[f.key];
    el.durRange.value = String(clamp(state.duration, 5, 360));
    el.durNum.value = String(state.duration);
    el.durRead.textContent = clock(state.duration);
    el.durRange.style.setProperty('--range-fill', `${((clamp(state.duration, 5, 360) - 5) / 355) * 100}%`);
    for (const chip of el.durPresets.children) {
      chip.classList.toggle('is-active', Number(chip.dataset.preset) === Number(state.duration));
    }
    el.seed.value = state.seed;
    el.format.value = state.format;
    el.rate.value = String(state.sampleRate);
    el.bitrate.value = String(state.bitrate);
    el.bitrate.disabled = state.format !== 'mp3';
    el.bitrateNote.textContent = state.format === 'mp3' ? 'mp3 only' : `ignored for ${state.format}`;
    el.tiled.checked = state.tiled;
    for (const b of el.takesSeg) {
      const on = b.dataset.takes === state.takes;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const b of el.modeBtns) {
      const on = (b.dataset.modeBtn === 'instrumental') === state.instrumental;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function syncAll() {
    syncControls();
    syncCaption();
    syncLyrics();
    syncValidation();
  }

  /* --------------------------------------------------------------- health */

  function applyHealth(h) {
    health = h;
    if (!h) return;

    el.backend.textContent = h.status === 'online' ? h.backend : h.status;
    el.backend.className = `badge ${{ online: 'badge--ok', degraded: 'badge--warn', offline: 'badge--danger' }[h.status] || ''}`;
    el.backend.title = h.message;

    const keys = h.modelKeys || [];
    const previous = state.model;
    el.model.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Server default';
    el.model.append(def);
    for (const key of keys) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = h.musicModels[key] || key;
      el.model.append(o);
    }
    el.model.disabled = keys.length === 0;
    el.model.value = keys.includes(previous) ? previous : '';
    state.model = el.model.value;
    el.modelNote.textContent = keys.length
      ? `${keys.length} available`
      : (h.status === 'offline' ? 'backend unreachable' : 'none reported by /api/health');

    syncLyricButtons();
    syncValidation();
  }

  /* ------------------------------------------------------------- lyrics IO */

  let lyricsJob = null;

  async function runLyrics(mode) {
    if (lyricsJob) return;
    const prompt = composePrompt();
    if (!prompt && !state.title.trim() && mode === 'write_full_song') {
      ctx.toast('Describe the song in Global metadata (or give it a title) so Codex has something to work from.', {
        kind: 'warn', title: 'Nothing to write from',
      });
      return;
    }

    const [lo, hi] = wordTarget(state.duration);
    const brief = [
      prompt,
      `Target duration ${clock(state.duration)} (${state.duration} seconds). Aim for ${lo}–${hi} sung words.`,
      `Use only these section tags, each alone on its own line: ${SECTION_TAGS.join(' ')}.`,
      `Suggested structure at this length: ${recommendedStructure(state.duration).join(' ')}.`,
      'Do not put tempo, instrument or production directions in the lyrics.',
    ].filter(Boolean).join('\n\n');

    const controller = new AbortController();
    lyricsJob = controller;
    const btn = mode === 'edit' ? el.revise : el.draft;
    const original = btn.innerHTML;
    btn.innerHTML = `${ctx.iconMarkup('spinner', 'icon spinner')}${mode === 'edit' ? 'Revising…' : 'Writing…'}`;
    syncLyricButtons();

    try {
      const res = await api.lyrics(
        { mode, prompt: brief, lyrics: mode === 'edit' ? state.lyrics : '', title: state.title },
        { signal: controller.signal },
      );
      if (!alive) return;
      const text = String(res?.lyrics || '').trim();
      if (!text) throw new api.ApiError('The lyrics service returned an empty result.', { endpoint: '/api/lyrics' });

      replaceAll(el.lyrics, text);
      state.lyrics = el.lyrics.value;
      if (!state.title.trim() && res.song_title) {
        state.title = String(res.song_title);
        el.title.value = state.title;
      }
      styleTags = String(res.style_tags || '').trim();
      renderStyleTags();
      save();
      syncLyrics();
      syncValidation();
      ctx.toast(
        `${countWords(text.replace(/^\[.*\]$/gm, ''))} sung words written by ${res.provider || 'the lyrics service'}${res.model ? ` · ${res.model}` : ''}.`,
        { kind: 'success', title: mode === 'edit' ? 'Lyrics revised' : 'Lyrics written' },
      );
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.toast(api.errorText(err), { kind: 'error', title: 'POST /api/lyrics failed' });
    } finally {
      lyricsJob = null;
      if (alive) {
        btn.innerHTML = original;
        syncLyrics();
      }
    }
  }

  function renderStyleTags() {
    if (!styleTags) { el.styleTags.hidden = true; return; }
    el.styleTags.hidden = false;
    el.styleTags.replaceChildren();
    const label = document.createElement('span');
    label.className = 'capfield__suggestlabel';
    label.textContent = 'Codex suggested style tags:';
    const value = document.createElement('code');
    value.className = 'code';
    value.textContent = styleTags;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--sm btn--ghost';
    btn.textContent = 'Insert';
    btn.addEventListener('click', () => {
      const area = el.caption.global.area;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      insertAtCaret(area, `${area.value.trim() ? '\n' : ''}${styleTags}`);
      state.global = area.value;
      save();
      syncCaption();
      syncValidation();
    });
    el.styleTags.append(label, value, btn);
  }

  /* ------------------------------------------------------------ rendering */

  function setBusy(on) {
    el.busy.hidden = !on;
    syncValidation();
  }

  let busyTimer = null;

  function tickBusy() {
    if (!job) return;
    el.busyTime.textContent = clock(Math.round((Date.now() - job.startedAt) / 1000));
  }

  function attachJob(j) {
    j.hook = (kind, payload) => {
      if (!alive) return;
      if (kind === 'event') {
        if (payload?.status) el.busyLabel.textContent = `${payload.status} on ${payload.backend || health?.backend || 'the backend'}…`;
        else if (payload?.partial) el.busyLabel.textContent = 'Partial audio received…';
        else if (payload?.done) el.busyLabel.textContent = 'Writing the file…';
      } else if (kind === 'done') {
        renderTakes(payload, j);
      } else if (kind === 'error') {
        el.busyLabel.textContent = 'Failed';
        renderFailure(payload, j);
      } else if (kind === 'settled') {
        // Runs after the module-level `job` has been released, so the Generate
        // button comes back on this pass and not a beat late.
        clearInterval(busyTimer);
        busyTimer = null;
        setBusy(false);
      }
    };
    el.busyLabel.textContent = j.dual ? 'Rendering two takes…' : 'Queued…';
    setBusy(true);
    tickBusy();
    clearInterval(busyTimer);
    busyTimer = setInterval(tickBusy, 1000);
  }

  function startRender() {
    if (job) return;
    const input = currentInput();
    const v = api.validateGeneration(input);
    if (!v.valid) {
      ctx.toast(v.errors.join('\n'), { kind: 'warn', title: 'Not ready to render' });
      return;
    }

    const dual = state.takes === 'two';
    const controller = new AbortController();
    const metaBase = {
      title: state.title.trim() || 'Untitled song',
      prompt: v.payload.prompt || '',
      lyrics: state.instrumental ? '' : state.lyrics,
      duration: v.payload.duration,
      seed: v.payload.seed,
      format: state.format,
      isInstrumental: state.instrumental,
      createdAt: Date.now(),
    };

    const j = { controller, startedAt: Date.now(), dual, hook: null, meta: metaBase };

    const announce = (result, take) => {
      if (!result?.track) return;
      ctx.bus.emit('track:new', {
        track: result.track,
        meta: { ...metaBase, take, extra_info: result.extra_info || null },
      });
    };

    let call;
    try {
      call = dual
        ? api.generateDual(input, { signal: controller.signal })
        : api.generateStream(input, {
          signal: controller.signal,
          onEvent: (e) => j.hook?.('event', e),
        });
    } catch (err) {
      ctx.toast(api.errorText(err), { kind: 'error', title: 'Request rejected' });
      return;
    }

    j.promise = call
      .then((res) => {
        if (dual) {
          announce(res?.takes?.A, 'A');
          announce(res?.takes?.B, 'B');
          const made = [res?.takes?.A, res?.takes?.B].filter((t) => t?.track).length;
          ctx.toast(
            `${made} of 2 takes rendered${res?.errors?.length ? ` · ${res.errors.map((e) => `${e.slot}: ${e.error}`).join(' · ')}` : ''}`,
            { kind: made ? 'success' : 'error', title: 'generate-dual finished' },
          );
        } else {
          announce(res, null);
          ctx.toast(`${metaBase.title} · ${clock(resultSeconds(res?.extra_info, metaBase.duration))}`, {
            kind: 'success', title: 'Track rendered',
          });
        }
        j.hook?.('done', res);
        return res;
      })
      .catch((err) => {
        if (err?.name === 'AbortError') ctx.toast('Render cancelled.', { kind: 'info' });
        else ctx.toast(api.errorText(err), { kind: 'error', title: dual ? 'POST /api/generate-dual failed' : 'Render failed' });
        j.hook?.('error', err);
      })
      .finally(() => {
        if (job === j) job = null;
        j.hook?.('settled');
      });

    job = j;
    el.takesList.replaceChildren();
    attachJob(j);
    syncValidation();
  }

  /**
   * A render that failed leaves its reason on screen — the toast expires, the
   * panel does not. The backend's own words, never a generic string.
   */
  function renderFailure(err, j) {
    if (err?.name === 'AbortError') return;
    const box = document.createElement('div');
    box.className = 'notice notice--error take__error';
    box.innerHTML = `<span class="notice__icon">${ctx.iconMarkup('alert')}</span><div>
      <p class="notice__title"></p><span class="take__errmsg"></span>
      <p class="take__errfoot mono"></p></div>`;
    box.querySelector('.notice__title').textContent = j.dual
      ? 'POST /api/generate-dual failed'
      : 'POST /api/generate-stream failed';
    box.querySelector('.take__errmsg').textContent = api.errorText(err);
    box.querySelector('.take__errfoot').textContent = [
      err?.status ? `HTTP ${err.status}` : null,
      `format ${j.meta.format}`,
      `${j.meta.duration}s`,
      err?.traceId ? `trace ${err.traceId}` : null,
    ].filter(Boolean).join(' · ');
    el.takesList.replaceChildren(box);
  }

  /** `extra_info.music_duration` comes back in milliseconds on this backend. */
  function resultSeconds(x, fallback) {
    const d = Number(x?.music_duration);
    if (!Number.isFinite(d) || d <= 0) return fallback;
    return d > LIMITS.DURATION_MAX ? d / 1000 : d;
  }

  function takeCard(result, label, j) {
    const card = document.createElement('article');
    card.className = 'take';
    const x = result?.extra_info || {};
    const bits = [
      j.meta.format,
      clock(resultSeconds(x, j.meta.duration)),
      bytes(result?.track?.size),
      x.music_sample_rate ? `${(x.music_sample_rate / 1000).toFixed(1)} kHz` : null,
      j.meta.seed === undefined || j.meta.seed === null ? null : `seed ${j.meta.seed}`,
    ].filter(Boolean);

    card.innerHTML = `
      <span class="brandmark take__art" style="--mark-size:56px"><img src="/logo.png" alt=""></span>
      <div class="take__body">
        <h4 class="take__title"></h4>
        <p class="take__meta mono"></p>
      </div>
      <div class="take__actions">
        <button class="btn btn--sm" type="button" data-play>${ctx.iconMarkup('play')}Play</button>
        <a class="btn btn--sm btn--ghost" data-dl download>${ctx.iconMarkup('download')}Save</a>
      </div>`;

    const title = label ? `${j.meta.title} · Take ${label}` : j.meta.title;
    card.querySelector('.take__title').textContent = title;
    card.querySelector('.take__meta').textContent = bits.join(' · ');

    const dl = card.querySelector('[data-dl]');
    dl.href = api.mediaUrl(result?.track);
    dl.download = result?.track?.filename || '';
    card.querySelector('[data-play]').addEventListener('click', () => {
      ctx.bus.emit('player:play', {
        track: result.track,
        title,
        meta: { ...j.meta, extra_info: result.extra_info || null },
      });
    });
    return card;
  }

  function renderTakes(res, j) {
    el.takesList.replaceChildren();
    if (!res) return;
    if (j.dual) {
      if (res?.takes?.A?.track) el.takesList.append(takeCard(res.takes.A, 'A', j));
      if (res?.takes?.B?.track) el.takesList.append(takeCard(res.takes.B, 'B', j));
      for (const e of res?.errors || []) {
        const p = document.createElement('div');
        p.className = 'notice notice--error';
        p.innerHTML = `<span class="notice__icon">${ctx.iconMarkup('alert')}</span><div><p class="notice__title">Take ${e.slot} failed</p><span></span></div>`;
        p.querySelector('span:last-child').textContent = [e.error, e.details].filter(Boolean).join(' — ');
        el.takesList.append(p);
      }
    } else if (res.track) {
      el.takesList.append(takeCard(res, null, j));
    }
    if (el.takesList.children.length) el.takesList.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ------------------------------------------------------------- wiring */

  const listeners = [];
  const on = (node, type, fn, opts) => {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    listeners.push(() => node.removeEventListener(type, fn, opts));
  };

  on(el.title, 'input', () => { state.title = el.title.value; save(); });

  for (const b of el.modeBtns) {
    on(b, 'click', () => {
      state.instrumental = b.dataset.modeBtn === 'instrumental';
      save();
      buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
      syncAll();
    });
  }

  on(el.lyrics, 'input', () => {
    state.lyrics = el.lyrics.value;
    save();
    syncLyrics();
    syncValidation();
  });

  on(el.tagbar, 'click', (e) => {
    const chip = e.target.closest('[data-tag]');
    if (!chip) return;
    insertOnOwnLine(el.lyrics, chip.dataset.tag);
    state.lyrics = el.lyrics.value;
    save();
    syncLyrics();
    syncValidation();
  });

  on(el.skeleton, 'click', () => {
    const skeleton = recommendedStructure(state.duration).join('\n\n');
    insertOnOwnLine(el.lyrics, skeleton);
    state.lyrics = el.lyrics.value;
    save();
    syncLyrics();
    syncValidation();
  });

  on(el.draft, 'click', () => {
    if (el.draft.disabled) return;
    runLyrics('write_full_song');
  });
  on(el.revise, 'click', () => {
    if (el.revise.disabled) return;
    runLyrics('edit');
  });

  const jumpTo = (node) => {
    const start = Number(node.dataset.start);
    const end = Number(node.dataset.end);
    if (!Number.isFinite(start)) return;
    el.lyrics.focus();
    el.lyrics.setSelectionRange(start, end);
    const ratio = start / Math.max(1, el.lyrics.value.length);
    el.lyricbox.scrollTop = Math.max(0, el.lyrics.scrollHeight * ratio - el.lyricbox.clientHeight / 2);
  };
  on(el.sections, 'click', (e) => {
    const chip = e.target.closest('.sectionchip');
    if (chip) jumpTo(chip);
  });
  on(el.lint, 'click', (e) => {
    const row = e.target.closest('.lint__row[data-start]');
    if (row) jumpTo(row);
  });

  for (const f of CAPTION_FIELDS) {
    const refs = el.caption[f.key];
    on(refs.area, 'input', () => {
      state[f.key] = refs.area.value;
      save();
      syncCaption();
      syncValidation();
    });
    on(refs.bar, 'click', (e) => {
      const chip = e.target.closest('[data-part]');
      if (!chip) return;
      const part = partsFor(f).find((p) => p.label === chip.dataset.part);
      if (!part) return;
      const area = refs.area;
      if (partPresent(area.value, part)) {
        // Already written — take the writer to it instead of duplicating it.
        const re = part.test || new RegExp(`${escapeRe(part.label)}\\s*:`, 'i');
        const m = re.exec(area.value);
        if (m) {
          area.focus();
          area.setSelectionRange(m.index, m.index + m[0].length);
        }
        return;
      }
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      insertAtCaret(area, `${area.value.trim() ? '\n' : ''}${partInsert(part)}`);
      state[f.key] = area.value;
      save();
      syncCaption();
      syncValidation();
    });
    on(refs.scaffold, 'click', () => {
      const area = refs.area;
      const missing = partsFor(f).filter((p) => !partPresent(area.value, p));
      if (!missing.length) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      insertAtCaret(area, `${area.value.trim() ? '\n' : ''}${missing.map(partInsert).join('\n')}`);
      state[f.key] = area.value;
      save();
      syncCaption();
      syncValidation();
    });
  }

  on(el.copyPrompt, 'click', async () => {
    const text = composePrompt();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(`${text.length.toLocaleString()} characters copied.`, { kind: 'success', title: 'Composed prompt copied' });
    } catch (err) {
      ctx.toast(`Clipboard refused: ${err?.message || err}. The composed prompt is expanded below instead.`, { kind: 'warn' });
      el.composed.open = true;
    }
  });

  const setDuration = (value) => {
    state.duration = clamp(Number(value) || 0, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
    save();
    syncControls();
    syncLyrics();
    syncValidation();
  };
  on(el.durRange, 'input', () => setDuration(el.durRange.value));
  on(el.durNum, 'input', () => {
    const raw = Number(el.durNum.value);
    if (!Number.isFinite(raw)) return;
    state.duration = clamp(raw, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
    save();
    el.durRange.value = String(clamp(state.duration, 5, 360));
    el.durRead.textContent = clock(state.duration);
    el.durRange.style.setProperty('--range-fill', `${((clamp(state.duration, 5, 360) - 5) / 355) * 100}%`);
    syncLyrics();
    syncValidation();
  });
  on(el.durNum, 'change', () => setDuration(el.durNum.value));
  on(el.durPresets, 'click', (e) => {
    const chip = e.target.closest('[data-preset]');
    if (chip) setDuration(chip.dataset.preset);
  });

  on(el.seed, 'input', () => {
    state.seed = el.seed.value.trim();
    save();
    syncValidation();
  });
  on(el.seedDice, 'click', () => {
    state.seed = String(Math.floor(Math.random() * (LIMITS.SEED_MAX + 1)));
    el.seed.value = state.seed;
    save();
    syncValidation();
  });
  on(el.seedClear, 'click', () => {
    state.seed = '';
    el.seed.value = '';
    save();
    syncValidation();
  });

  on(el.model, 'change', () => {
    state.model = el.model.value;
    save();
    syncValidation();
  });

  on(el.format, 'change', () => {
    state.format = el.format.value;
    save();
    syncControls();
    syncValidation();
  });
  on(el.rate, 'change', () => { state.sampleRate = Number(el.rate.value); save(); syncValidation(); });
  on(el.bitrate, 'change', () => { state.bitrate = Number(el.bitrate.value); save(); syncValidation(); });
  on(el.tiled, 'change', () => { state.tiled = el.tiled.checked; save(); syncValidation(); });

  for (const b of el.takesSeg) {
    on(b, 'click', () => {
      state.takes = b.dataset.takes;
      save();
      syncControls();
      syncValidation();
    });
  }

  on(el.generate, 'click', startRender);
  on(el.cancel, 'click', () => {
    job?.controller.abort();
  });

  /* ------------------------------------------------------- topbar actions */

  const exampleBtn = document.createElement('button');
  exampleBtn.type = 'button';
  exampleBtn.className = 'btn btn--sm btn--ghost';
  exampleBtn.innerHTML = `${ctx.iconMarkup('wand')}Load example`;
  exampleBtn.title = 'Fill every field with a complete, well-formed draft';
  exampleBtn.addEventListener('click', () => {
    Object.assign(state, {
      title: EXAMPLE.title,
      global: EXAMPLE.global,
      vocal: EXAMPLE.vocal,
      arrangement: EXAMPLE.arrangement,
      lyrics: EXAMPLE.lyrics,
      duration: EXAMPLE.duration,
      instrumental: false,
    });
    save();
    buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
    syncAll();
    el.lyrics.scrollIntoView({ block: 'nearest' });
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn--sm btn--ghost';
  clearBtn.innerHTML = `${ctx.iconMarkup('trash')}Clear`;
  clearBtn.title = 'Empty every field and forget the saved draft';
  clearBtn.addEventListener('click', () => {
    const snapshot = { ...state };
    Object.assign(state, defaults, { model: state.model });
    ctx.storage.remove(STORAGE_KEY);
    buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
    styleTags = '';
    renderStyleTags();
    syncAll();
    ctx.toast('Draft cleared.', {
      kind: 'info',
      action: {
        label: 'Undo',
        onClick: () => {
          Object.assign(state, snapshot);
          save();
          buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
          syncAll();
        },
      },
    });
  });

  ctx.headerSlot.append(exampleBtn, clearBtn);

  /* ------------------------------------------------------------- startup */

  for (const f of CAPTION_FIELDS) buildPartBar(f);
  syncAll();
  ctx.onHealth(applyHealth); // fires immediately when a snapshot already exists

  // Re-attach to a render that survived a screen change.
  if (job) {
    attachJob(job);
    ctx.toast('Re-attached to the render already in flight.', { kind: 'info' });
  }

  /* ------------------------------------------------------------ teardown */

  return () => {
    alive = false;
    save.cancel();
    ctx.storage.set(STORAGE_KEY, state);
    clearInterval(busyTimer);
    for (const off of listeners) off();
    lyricsJob?.abort();
    if (job) {
      // Deliberate: a local render takes minutes. It keeps running, still emits
      // `track:new` and still toasts; only the DOM hook is dropped.
      job.hook = null;
      ctx.toast('The render keeps going in the background — it will land in your library.', { kind: 'info' });
    }
  };
}
