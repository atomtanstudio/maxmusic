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
  subtitle: 'Lyrics + description, full control',
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
 *
 * `summary` is the one-line "what goes in here" strip beside the field name.
 */
const CAPTION_FIELDS = [
  {
    key: 'global',
    label: 'Global metadata',
    summary: 'genre · tempo · key & scale · mood arc · scenario · production',
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
    summary: 'gender · timbre · style per section · harmonies · effects',
    instrumentalSummary: 'no vocals · the instrument that carries the tune',
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
  },
  {
    key: 'arrangement',
    label: 'Arrangement',
    summary: 'primary & secondary layers · groove · textures and space',
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

/** "2:30" · "150" · "150s" → seconds. Returns `fallback` for anything else. */
function parseClock(raw, fallback) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return fallback;
  const mmss = /^(\d{1,2}):([0-5]?\d(?:\.\d+)?)$/.exec(s);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const n = Number(s.replace(/(sec|secs|s)$/, ''));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A model name a customer can read.
 *
 * The backend labels its models with quantization strings ("… official FP16 +
 * INT8 ConvRot encoder"). Those are build internals — house rule 0 — so keep
 * the family name up to the first separator and take the tier from the key.
 */
function modelLabel(key, raw) {
  const family = String(raw || '').split(/\s[-–—]\s|\(/)[0].trim();
  const flat = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tier = String(key)
    .split(/[_\-\s]+/)
    // Drop the tokens that only repeat the family name; keep short ones like
    // "max", which is a substring of "minimax" but is a real tier word.
    .filter((w) => w && !(w.length >= 4 && flat.includes(w.toLowerCase())))
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
  if (family && tier) return `${family} · ${tier}`;
  return family || tier || String(key);
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
            ? `"${rec.literal.trim()}" is not one of the nine section tags, so it gets sung as a lyric. Use [${rec.fixTo}].`
            : `"${rec.literal.trim()}" is not one of the nine section tags, so it gets sung as a lyric. Use one of: ${LEGAL_NAMES.map((n) => `[${n}]`).join(' ')}.`,
        });
      } else if (rec.caseIssue) {
        issues.push({
          severity: 'warn',
          line: rec,
          fixable: true,
          message: `Write this tag as [${rec.name}] — lower case, nothing else on the line.`,
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
        message: 'A tag in the middle of a line gets sung as words. Tags belong alone on their own line.',
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
      message: 'No section tags yet. Tracks come out stronger when the sections are marked — start with [intro] or [verse].',
    });
  }

  if (instrumental && sungWords > 0) {
    issues.push({
      severity: 'warn',
      line: null,
      fixable: false,
      message: `Instrumental is on, so these ${sungWords} words will not be sung. Instrumentals use [instrumental] sections with no words.`,
    });
  } else if (hasText && !instrumental && sungWords > 0) {
    if (sungWords < lo) {
      issues.push({
        severity: 'warn',
        line: null,
        fixable: false,
        message: `${sungWords} sung words is thin for ${clock(duration)} — aim for ${lo}–${hi}, or expect long stretches with no singing.`,
      });
    } else if (sungWords > hi) {
      issues.push({
        severity: 'warn',
        line: null,
        fixable: false,
        message: `${sungWords} sung words is dense for ${clock(duration)} — aim for ${lo}–${hi}, or stretch the track to ${clock(Math.ceil(sungWords / WORDS_PER_10S[1] * 10))}.`,
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
        message: `A ${clock(duration)} track usually runs ${want.join(' ')} — yours is missing ${missing.map((n) => `[${n}]`).join(' ')}.`,
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
        <span class="capfield__summary" data-cap-summary="${f.key}"></span>
        <span class="capfield__meter mono" data-cap-meter="${f.key}"></span>
      </header>
      <div class="partbar" data-partbar="${f.key}">
        <button class="btn btn--sm btn--ghost partbar__add" type="button" data-scaffold="${f.key}">
          ${i('plus')}Fill in the rest
        </button>
      </div>
      <textarea class="textarea capfield__text" data-cap="${f.key}" rows="5"
        spellcheck="true" aria-label="${escapeHtml(f.label)}"></textarea>
      ${f.key === 'global' ? '<div class="capfield__suggest" data-style-tags hidden></div>' : ''}
    </section>`).join('');

  return `
<div class="studio">

  <div class="studio__main" data-main>
    <div class="studio__wrap">

      <div class="studio__doc">
        <input class="studio__title" data-title type="text" maxlength="120"
               placeholder="Untitled song" aria-label="Song title" autocomplete="off" spellcheck="false">
        <input class="studio__artist" data-artist type="text" maxlength="60"
               aria-label="Artist" autocomplete="off" spellcheck="false">
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
          <button class="btn btn--sm" type="button" data-draft>${i('wand')}Write for me</button>
          <button class="btn btn--sm btn--ghost" type="button" data-revise>${i('refresh')}Rewrite</button>
          <button class="btn btn--sm btn--ghost" type="button" data-skeleton>${i('plus')}Add structure</button>
        </header>

        <div class="panel__body studio__body">
          <div class="notice notice--info studio__twostep" data-twostep hidden>
            <span class="notice__icon">${i('info')}</span>
            <div class="notice__body">
              <p class="notice__head">
                <span class="notice__title">A sung track needs words</span>
              </p>
              <p>Write them here, or let <b>Write for me</b> draft a full set from your
              description first. Switch to Instrumental if you want no vocals at all.</p>
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
              <span class="fit__value" data-fit-words>0</span>
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
          <h3 class="panel__title">${i('panel')}Description</h3>
          <span class="studio__count mono" data-prompt-count>0 / 2000</span>
          <div class="spacer"></div>
          <button class="btn btn--sm btn--ghost" type="button" data-copy-prompt>${i('copy')}Copy</button>
        </header>
        <div class="panel__body studio__body">
          <p class="hint studio__lede">
            Three labelled fields describe the sound. Together they tell the model what
            to play — around 250–400 words in total works best, and lyric lines never
            belong in here.
          </p>
          ${captionBlocks}
          <details class="composed" data-composed>
            <summary class="composed__summary">
              ${i('chevron-right')}<span>Preview the full description</span>
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
    <div class="dock studio__dock">
      <div class="dock__scroll">
        <div class="rack">

          <div class="field rack__group">
            <label class="label" for="st-model">Model</label>
            <select class="select" id="st-model" data-model disabled>
              <option value="">Studio default</option>
            </select>
          </div>

          <div class="field rack__group">
            <label class="label" for="st-duration">Length
              <input class="input rack__num mono" id="st-duration" type="text" data-duration
                     inputmode="numeric" autocomplete="off" spellcheck="false"
                     aria-label="Track length, minutes and seconds">
            </label>
            <div class="chiprow" data-duration-presets role="group" aria-label="Track length"></div>
          </div>

          <div class="field rack__group">
            <span class="label">Takes</span>
            <div class="segment segment--block" data-takes-seg role="group" aria-label="Number of takes">
              <button class="segment__item is-active" type="button" data-takes="one" aria-pressed="true">One</button>
              <button class="segment__item" type="button" data-takes="two" aria-pressed="false">Two</button>
            </div>
            <p class="hint" data-takes-note></p>
          </div>

          <div class="field rack__group">
            <label class="label" for="st-seed">Seed</label>
            <div class="rack__row">
              <input class="input mono" id="st-seed" type="number" data-seed placeholder="Random"
                     min="0" step="1" autocomplete="off">
              <button class="actionchip" type="button" data-seed-dice
                      aria-label="Pick a random seed" title="Pick a random seed">${i('dice')}</button>
            </div>
            <p class="hint">Keep a seed to make the same track again. Empty means a new one every time.</p>
          </div>

          <details class="fold rack__group" data-audio>
            <summary class="fold__summary">
              ${i('chevron-right')}<span>Audio file</span>
              <span class="fold__meta mono" data-audio-meta></span>
            </summary>
            <div class="fold__body">
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

              <div class="field" data-bitrate-field>
                <label class="label" for="st-bitrate">Bitrate
                  <span class="label__hint">MP3 only</span>
                </label>
                <select class="select" id="st-bitrate" data-bitrate></select>
              </div>

              <label class="switch rack__switch">
                <input type="checkbox" data-tiled>
                <span class="switch__track"></span>
                <span class="switch__label">Careful rendering
                  <span class="rack__sub">Steadier on long tracks, a little slower.</span>
                </span>
              </label>
            </div>
          </details>

          <section class="output" data-output>
            <h3 class="rack__title">Output</h3>
            <div class="takes" data-takes-list></div>
            <div class="output__empty" data-output-empty>
              <span class="brandmark output__mark" style="--mark-size:40px"><img src="/logo.png" alt=""></span>
              <p class="output__title">Your take lands here</p>
              <p class="output__text">Finished tracks play straight away and are kept in your library.</p>
            </div>
          </section>
        </div>
      </div>

      <div class="dock__foot dock__foot--fade">
        <div class="foot">
          <div class="foot__issues" data-issues></div>
          <div class="foot__busy" data-busy hidden>
            <div class="brandline"></div>
            <div class="foot__busyrow">
              <svg class="icon spinner" aria-hidden="true"><use href="#i-spinner"/></svg>
              <span data-busy-label>Queued</span>
              <span class="spacer"></span>
              <span class="mono" data-busy-time>0:00</span>
            </div>
            <button class="btn btn--sm btn--danger btn--block" type="button" data-cancel>Stop rendering</button>
          </div>
          <button class="btn btn--primary btn--lg btn--block" type="button" data-generate>
            ${i('wave')}<span data-generate-label>Generate</span>
          </button>
        </div>
      </div>
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
    // Empty means "use the default from Settings". Only a value typed here
    // overrides it, so changing the default still moves every uncredited song.
    artist: '',
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

  // First run opens on a complete, well-formed draft rather than an empty
  // document — the same choice the reference product makes. Everything in it
  // is editable and "Clear draft" empties it for good.
  const stored = ctx.storage.get(STORAGE_KEY, null);
  const state = stored && typeof stored === 'object'
    ? { ...defaults, ...stored }
    : { ...defaults, ...EXAMPLE };
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
    artist: q('[data-artist]'),
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
    model: q('[data-model]'),
    duration: q('[data-duration]'),
    durPresets: q('[data-duration-presets]'),
    seed: q('[data-seed]'),
    seedDice: q('[data-seed-dice]'),
    audioMeta: q('[data-audio-meta]'),
    format: q('[data-format]'),
    rate: q('[data-rate]'),
    bitrate: q('[data-bitrate]'),
    bitrateField: q('[data-bitrate-field]'),
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
    output: q('[data-output]'),
    outputEmpty: q('[data-output-empty]'),
    takesList: q('[data-takes-list]'),
    caption: Object.fromEntries(CAPTION_FIELDS.map((f) => [f.key, {
      area: q(`[data-cap="${f.key}"]`),
      bar: q(`[data-partbar="${f.key}"]`),
      meter: q(`[data-cap-meter="${f.key}"]`),
      summary: q(`[data-cap-summary="${f.key}"]`),
      scaffold: q(`[data-scaffold="${f.key}"]`),
    }])),
  };

  /* --------------------------------------------------------- persistence */

  const save = debounce(() => ctx.storage.set(STORAGE_KEY, state), 400);

  /* ------------------------------------------------------- static options */

  const FORMAT_LABEL = { flac: 'FLAC · lossless', mp3: 'MP3', wav: 'WAV · lossless' };
  for (const f of FORMATS) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = FORMAT_LABEL[f] || f.toUpperCase();
    el.format.append(o);
  }
  for (const r of SAMPLE_RATES) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz`;
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
    const refs = el.caption[field.key];
    const box = refs.bar;
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
    box.append(refs.scaffold); // the "fill in the rest" button closes the row
    refs.summary.textContent =
      (field.key === 'vocal' && state.instrumental ? field.instrumentalSummary : field.summary) || '';
  }

  /**
   * Grow a textarea to its content.
   *
   * The caption fields are documents, not one-liners. Left at a fixed height
   * they cut a sentence in half at the bottom edge, which round 1 judged as a
   * clipping bug rather than as a scroll region — and they nested a scrollbar
   * inside a scrolling column, which is worse.
   */
  function autosizeArea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    // scrollHeight is the content box; height sets the border box. Add the
    // difference back or the field lands two pixels short and clips its last
    // line — the exact defect this is here to remove.
    const chrome = ta.offsetHeight - ta.clientHeight;
    ta.style.height = `${ta.scrollHeight + chrome}px`;
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
    refs.meter.textContent = words ? `${words} words` : '';
    refs.scaffold.hidden = present === parts.length;
    refs.scaffold.title = 'Add the parts this field is still missing';
    autosizeArea(refs.area);
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
    autosizeArea(el.lyrics);
  }

  function syncLyrics() {
    const text = state.lyrics;
    const analysis = analyse(text, { duration: state.duration, instrumental: state.instrumental });
    lastAnalysis = analysis;

    // backdrop
    el.hl.innerHTML = text
      ? highlight(text, analysis)
      : `<i class="ly-ph">Start writing, tap a section tag above, or hit Add structure for the shape a ${clock(state.duration)} track wants. Tags sit alone on their own line.</i>`;
    autosize();

    // counter
    const over = text.length > LIMITS.LYRICS_MAX;
    el.lyricsCount.textContent = `${text.length.toLocaleString()} / ${LIMITS.LYRICS_MAX.toLocaleString()}`;
    el.lyricsCount.dataset.state = over ? 'over' : (text.length > LIMITS.LYRICS_MAX * 0.9 ? 'near' : '');

    // fit meter
    const [lo, hi] = analysis.target;
    const scale = Math.max(hi * 1.5, analysis.sungWords * 1.08, 1);
    el.fitWords.textContent = String(analysis.sungWords);
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
    // The verdict is said ONCE, by the badge. The meter's band already shows
    // the target range, so the range is spelled out only when the words are
    // outside it and it becomes something to aim at. This block used to state
    // one boolean four ways — range line, badge, meter and a ticked sentence
    // below — and it was the most-cited fault in two rounds of judging.
    el.fitTarget.textContent = state.instrumental
      ? 'not sung while Instrumental is on'
      : (fitState === 'under' || fitState === 'over')
        ? `aim for ${lo}–${hi} at ${clock(state.duration)}`
        : '';

    el.fit.dataset.fit = fitState;
    el.fitBadge.textContent = badge;
    el.fitBadge.className = `badge ${{ good: 'badge--ok', over: 'badge--warn', under: 'badge--warn' }[fitState] || ''}`;

    const tagged = analysis.sections.filter((s) => s.name).length;
    el.fitFoot.textContent = state.instrumental
      ? 'Instrumental is on, so nothing here gets sung.'
      : `≈ ${clock(analysis.sungSeconds)} of singing · ${tagged} tagged ${tagged === 1 ? 'section' : 'sections'}`;

    // section outline
    el.sections.hidden = analysis.sections.length === 0;
    el.sections.replaceChildren();
    for (const s of analysis.sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sectionchip';
      b.dataset.start = String(s.line.start);
      b.dataset.end = String(s.line.end);
      // A chip reporting "0w" announces the absence of content and should not
      // draw at all — a section with no words gets its name and nothing else.
      b.innerHTML = `<b>${escapeHtml(s.name ? `[${s.name}]` : 'untagged')}</b>`
        + (s.words ? `<i>${s.words}w</i><u>${clock(s.words / WORDS_PER_SEC)}</u>` : '');
      b.title = 'Jump to this section';
      el.sections.append(b);
    }

    // lint
    el.lint.replaceChildren();
    if (!analysis.issues.length) {
      const ok = document.createElement('p');
      ok.className = 'lint__ok';
      // This row reports whether there is anything to FIX. Whether the words
      // fit the duration is the meter's job directly above, and repeating its
      // verdict here was the fourth statement of one fact.
      ok.innerHTML = `${ctx.iconMarkup('check')}<span>${text.trim()
        ? 'Nothing to fix.'
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
        btn.innerHTML = `${ctx.iconMarkup('wand')}Fix ${analysis.fixable}`;
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
      ? 'Lyric writing is switched off for this studio.'
      : (state.instrumental
        ? 'Instrumental tracks are rendered without lyrics.'
        : 'Draft a full set of lyrics from your description.');

    el.draft.disabled = providerOff || state.instrumental || busy;
    el.revise.disabled = el.draft.disabled || !state.lyrics.trim();
    el.draft.title = reason;
    el.revise.title = !el.draft.disabled && !state.lyrics.trim()
      ? 'Write or draft some lyrics first.'
      : (providerOff || state.instrumental ? reason : 'Rewrite what is here, keeping the same brief.');
  }

  function syncCaption() {
    for (const f of CAPTION_FIELDS) syncCaptionField(f);
    const prompt = composePrompt();
    const chars = prompt.length;
    const words = countWords(prompt);
    el.promptCount.textContent = `${chars.toLocaleString()} / ${LIMITS.PROMPT_MAX.toLocaleString()}`;
    el.promptCount.dataset.state = chars > LIMITS.PROMPT_MAX ? 'over' : (chars > LIMITS.PROMPT_MAX * 0.9 ? 'near' : '');
    el.composedMeta.textContent = words ? `${words} words` : '';
    el.composedMeta.dataset.state = words >= 250 && words <= 400 ? 'ok' : 'off';
    el.composedBody.textContent = prompt || 'Nothing describes the sound yet.';
    el.copyPrompt.disabled = !prompt;
  }

  /**
   * The studio itself is not ready to render.
   *
   * This is an environment state, not a fault in the draft, so it gets its own
   * card rather than another red line: a labelled severity chip *inside* the
   * surface, on the title row. The words come from `health.message`, which is
   * written for customers. The verbatim technical reason (`health.detail`,
   * `comfyError`) is deliberately absent — diagnostics belong on Settings and
   * in transient failures, never in a working frame.
   */
  function notReadyNode() {
    const box = document.createElement('div');
    box.className = 'notice notice--warn foot__notice';
    box.innerHTML = `
      <span class="notice__icon">${ctx.iconMarkup('alert')}</span>
      <div class="notice__body">
        <p class="notice__head">
          <span class="notice__title">Not ready to render</span>
        </p>
        <p data-notready></p>
      </div>`;
    box.querySelector('[data-notready]').textContent = `${
      health?.message || 'Your studio is still starting up.'
    } Generate switches back on by itself the moment it is.`;
    return box;
  }

  function syncValidation() {
    const v = api.validateGeneration(currentInput());
    el.issues.replaceChildren();

    const notReady = Boolean(health && health.status !== 'online');

    for (const text of v.errors) el.issues.append(issueNode('error', text));
    for (const text of v.warnings) el.issues.append(issueNode('warn', text));
    // Sits closest to the button it is disabling.
    if (notReady) el.issues.append(notReadyNode());

    const busy = Boolean(job);
    el.generate.disabled = !v.valid || notReady || busy;
    el.generateLabel.textContent = busy
      ? 'Rendering'
      : (state.takes === 'two' ? 'Generate two takes' : 'Generate');
    // Both halves describe TAKES. The single-take line used to talk about
    // render progress, which belongs to the output panel — it read as a stray
    // note parked under the nearest available control.
    el.takesNote.textContent = state.takes === 'two'
      ? 'Two takes from the same brief — the second explores a different arrangement.'
      : 'One take from your brief.';
    return v;
  }

  function issueNode(kind, text) {
    const p = document.createElement('p');
    p.className = `render__issue render__issue--${kind}`;
    p.innerHTML = `${ctx.iconMarkup(kind === 'error' ? 'alert' : 'info')}<span></span>`;
    p.querySelector('span').textContent = text;
    return p;
  }

  /**
   * The default artist from Settings, or empty. Read fresh each time rather
   * than cached, so changing it in Settings takes effect here immediately.
   * @returns {string}
   */
  function defaultArtist() {
    const prefs = ctx.storage.get('defaults', null);
    return String((prefs && prefs.artist) || '').trim();
  }

  /** Who this particular song is credited to: its own value, else the default. */
  function creditedArtist() {
    return state.artist.trim() || defaultArtist();
  }

  function syncControls() {
    el.title.value = state.title;
    // The default shows through as the placeholder, so it is visible without
    // being typed into every song — and typing here overrides it for this one.
    const fallback = defaultArtist();
    el.artist.placeholder = fallback ? `${fallback} — tap to change for this song` : 'Add an artist';
    if (document.activeElement !== el.artist) el.artist.value = state.artist;
    el.lyrics.value = state.lyrics;
    for (const f of CAPTION_FIELDS) el.caption[f.key].area.value = state[f.key];

    // ONE authoritative length value: this field. The chips are shortcuts into it.
    if (document.activeElement !== el.duration) el.duration.value = clock(state.duration);
    for (const chip of el.durPresets.children) {
      const on = Number(chip.dataset.preset) === Number(state.duration);
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    el.seed.value = state.seed;
    el.format.value = state.format;
    el.rate.value = String(state.sampleRate);
    el.bitrate.value = String(state.bitrate);

    // Bitrate is a lossy-format setting. When it cannot do anything it reads
    // as disabled — label included — instead of being annotated as ignored.
    const lossy = state.format === 'mp3';
    el.bitrate.disabled = !lossy;
    el.bitrateField.dataset.off = lossy ? 'false' : 'true';

    el.audioMeta.textContent = [
      (el.format.selectedOptions[0]?.textContent || state.format).split(' · ')[0],
      lossy ? `${Number(state.bitrate) / 1000} kbps` : null,
      `${(Number(state.sampleRate) / 1000).toFixed(Number(state.sampleRate) % 1000 ? 1 : 0)} kHz`,
    ].filter(Boolean).join(' · ');

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

    const keys = h.modelKeys || [];
    const previous = state.model;
    el.model.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Studio default';
    el.model.append(def);
    for (const key of keys) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = modelLabel(key, h.musicModels?.[key]);
      el.model.append(o);
    }
    el.model.disabled = keys.length === 0;
    el.model.value = keys.includes(previous) ? previous : '';
    state.model = el.model.value;

    syncLyricButtons();
    syncValidation();
  }

  /* ------------------------------------------------------------- lyrics IO */

  let lyricsJob = null;

  async function runLyrics(mode) {
    if (lyricsJob) return;
    const prompt = composePrompt();
    if (!prompt && !state.title.trim() && mode === 'write_full_song') {
      ctx.toast('Describe the song under Global metadata, or give it a title, so there is something to write from.', {
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
      if (!text) throw new Error('The lyrics came back empty. Try again, or add more detail to the description.');

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
        `${countWords(text.replace(/^\[.*\]$/gm, ''))} sung words, ready to edit.`,
        { kind: 'success', title: mode === 'edit' ? 'Lyrics rewritten' : 'Lyrics written' },
      );
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.toast(api.errorText(err), { kind: 'error', title: 'Could not write the lyrics' });
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
    label.textContent = 'Suggested style tags';
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
        if (payload?.partial) el.busyLabel.textContent = 'First audio coming through';
        else if (payload?.done) el.busyLabel.textContent = 'Finishing the file';
        else if (payload?.status === 'queued') el.busyLabel.textContent = 'Queued';
        else if (payload?.status) el.busyLabel.textContent = 'Rendering your track';
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
    el.busyLabel.textContent = j.dual ? 'Rendering two takes' : 'Queued';
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
      artist: creditedArtist(),
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
            `${made} of 2 takes finished${res?.errors?.length ? `\n${res.errors.map((e) => `Take ${e.slot}: ${e.error}`).join('\n')}` : ''}`,
            { kind: made ? 'success' : 'error', title: made ? 'Takes ready' : 'Render failed' },
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
        if (err?.name === 'AbortError') ctx.toast('Render stopped.', { kind: 'info' });
        else ctx.toast(api.errorText(err), { kind: 'error', title: 'Render failed' });
        j.hook?.('error', err);
      })
      .finally(() => {
        if (job === j) job = null;
        j.hook?.('settled');
      });

    job = j;
    el.takesList.replaceChildren();
    syncOutput();
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
    box.innerHTML = `<span class="notice__icon">${ctx.iconMarkup('alert')}</span>
      <div class="notice__body">
        <p class="notice__head">
          <span class="notice__title">Render failed</span>
        </p>
        <span class="take__errmsg"></span>
        <p class="take__errfoot mono"></p>
      </div>`;
    box.querySelector('.take__errmsg').textContent = api.errorText(err);
    // Diagnostics are legitimate here: this only exists when something broke.
    box.querySelector('.take__errfoot').textContent = [
      err?.status ? `HTTP ${err.status}` : null,
      err?.traceId ? `trace ${err.traceId}` : null,
    ].filter(Boolean).join(' · ');
    el.takesList.replaceChildren(box);
    syncOutput();
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
    const title = label ? `${j.meta.title} · Take ${label}` : j.meta.title;
    const bits = [
      clock(resultSeconds(x, j.meta.duration)),
      String(j.meta.format || '').toUpperCase(),
      j.meta.seed === undefined || j.meta.seed === null ? null : `seed ${j.meta.seed}`,
    ].filter(Boolean);

    card.innerHTML = `
      <span class="brandmark take__art" style="--mark-size:44px"><img src="/logo.png" alt=""></span>
      <div class="take__body">
        <h4 class="take__title"></h4>
        <p class="take__meta">${bits.map((b) => `<span>${escapeHtml(b)}</span>`).join('')}</p>
      </div>
      <div class="actionbar actionbar--end">
        <button class="actionchip actionchip--lg" type="button" data-play aria-label="Play this take">
          ${ctx.iconMarkup('play')}
        </button>
      </div>`;

    card.querySelector('.take__title').textContent = title;

    const url = api.mediaUrl(result?.track);
    card.querySelector('.actionbar').append(ctx.menu({
      label: 'More for this take',
      items: () => [
        { label: 'Download', icon: 'download', note: String(j.meta.format || '').toUpperCase(), href: url },
        { label: 'Open in library', icon: 'library', onSelect: () => ctx.navigate('library') },
        { separator: true },
        {
          label: 'Remove from this list',
          icon: 'trash',
          danger: true,
          onSelect: () => { card.remove(); syncOutput(); },
        },
      ],
    }));

    card.querySelector('[data-play]').addEventListener('click', () => {
      ctx.bus.emit('player:play', {
        track: result.track,
        title,
        meta: { ...j.meta, extra_info: result.extra_info || null },
      });
    });
    return card;
  }

  /** The rail always has a floor: either takes, or the card that says so. */
  function syncOutput() {
    el.outputEmpty.hidden = el.takesList.children.length > 0;
  }

  function renderTakes(res, j) {
    el.takesList.replaceChildren();
    if (!res) { syncOutput(); return; }
    if (j.dual) {
      if (res?.takes?.A?.track) el.takesList.append(takeCard(res.takes.A, 'A', j));
      if (res?.takes?.B?.track) el.takesList.append(takeCard(res.takes.B, 'B', j));
      for (const e of res?.errors || []) {
        const p = document.createElement('div');
        p.className = 'notice notice--error take__error';
        p.innerHTML = `<span class="notice__icon">${ctx.iconMarkup('alert')}</span>
          <div class="notice__body">
            <p class="notice__head">
              <span class="notice__title">Take ${escapeHtml(e.slot)} failed</span>
            </p>
            <span class="take__errmsg"></span>
          </div>`;
        p.querySelector('.take__errmsg').textContent = [e.error, e.details].filter(Boolean).join(' — ');
        el.takesList.append(p);
      }
    } else if (res.track) {
      el.takesList.append(takeCard(res, null, j));
    }
    syncOutput();
    if (el.takesList.children.length) el.output.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ------------------------------------------------------------- wiring */

  const listeners = [];
  const on = (node, type, fn, opts) => {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    listeners.push(() => node.removeEventListener(type, fn, opts));
  };

  on(el.title, 'input', () => { state.title = el.title.value; save(); });
  on(el.artist, 'input', () => { state.artist = el.artist.value; save(); });

  // Re-wrapping at a new width changes how tall every grown textarea needs to
  // be, so remeasure once the resize settles.
  const remeasure = debounce(() => {
    if (!alive) return;
    autosize();
    for (const f of CAPTION_FIELDS) autosizeArea(el.caption[f.key].area);
  }, 120);
  on(window, 'resize', remeasure);
  listeners.push(() => remeasure.cancel());

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

  async function copyPrompt() {
    const text = composePrompt();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(`${countWords(text)} words copied.`, { kind: 'success', title: 'Description copied' });
    } catch (err) {
      ctx.toast(`Your browser blocked the clipboard: ${err?.message || err}. The full description is open below instead.`, { kind: 'warn' });
      el.composed.open = true;
      el.composed.scrollIntoView({ block: 'nearest' });
    }
  }
  on(el.copyPrompt, 'click', copyPrompt);

  const setDuration = (value) => {
    state.duration = clamp(Number(value) || 0, LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
    save();
    syncControls();
    syncLyrics();
    syncValidation();
  };
  const commitDuration = () => {
    const next = clamp(parseClock(el.duration.value, state.duration), LIMITS.DURATION_MIN, LIMITS.DURATION_MAX);
    el.duration.blur();
    setDuration(next);
  };
  on(el.duration, 'change', commitDuration);
  on(el.duration, 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitDuration(); }
    if (e.key === 'Escape') { el.duration.value = clock(state.duration); el.duration.blur(); }
  });
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

  const loadExample = () => {
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
  };

  const clearDraft = () => {
    const snapshot = { ...state };
    Object.assign(state, defaults, { model: state.model });
    ctx.storage.set(STORAGE_KEY, state);
    buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
    styleTags = '';
    renderStyleTags();
    syncAll();
    ctx.toast('Draft cleared.', {
      kind: 'info',
      actions: [{
        label: 'Undo',
        onClick: () => {
          Object.assign(state, snapshot);
          save();
          buildPartBar(CAPTION_FIELDS.find((f) => f.key === 'vocal'));
          syncAll();
        },
      }],
    });
  };

  const newSongBtn = document.createElement('button');
  newSongBtn.type = 'button';
  newSongBtn.className = 'btn btn--sm btn--ghost';
  newSongBtn.innerHTML = `${ctx.iconMarkup('wand')}Example song`;
  newSongBtn.title = 'Fill every field with a complete, well-formed draft';
  newSongBtn.addEventListener('click', loadExample);

  const overflow = ctx.menu({
    label: 'Draft actions',
    items: () => [
      { label: 'Copy description', icon: 'copy', disabled: !composePrompt(), onSelect: copyPrompt },
      { label: 'Load example song', icon: 'wand', onSelect: loadExample },
      { separator: true },
      { label: 'Clear draft', icon: 'trash', danger: true, onSelect: clearDraft },
    ],
  });

  ctx.headerSlot.append(newSongBtn, overflow);

  /* ------------------------------------------------------------- startup */

  for (const f of CAPTION_FIELDS) buildPartBar(f);
  syncAll();
  syncOutput();
  ctx.onHealth(applyHealth); // fires immediately when a snapshot already exists

  // Re-attach to a render that survived a screen change.
  if (job) {
    attachJob(job);
    ctx.toast('Still rendering — picked up where it left off.', { kind: 'info' });
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
      ctx.toast('Your track keeps rendering in the background — it will land in your library.', { kind: 'info' });
    }
  };
}
