/**
 * Lyrics — the writing workspace.
 *
 * Owned by the lyrics lane (SPEC §6). The music model will not write lyrics for
 * itself (SPEC §3e), so this screen is the first half of "one idea → one song":
 * write the words here, then hand them to Create or Studio.
 *
 * Three house rules are load-bearing here:
 *
 *  0. No engineering internals in resting UI. Nothing a customer sees while the
 *     app is working prints a host, a port, an endpoint, a provider name, a
 *     model string, a byte size or a spec reference — including the writing
 *     rules themselves, which are stated as songwriting advice ("roughly 12–16
 *     sung words every 10 seconds"), never as rule numbers. Diagnostics live in
 *     Settings and in transient error toasts carrying the backend's own words.
 *  7. No gradient. There is none in this screen's stylesheet and none set from
 *     here; emphasis is a solid accent and states move lightness.
 *  8. No left-edge accent stripe. Every card that has something to say about
 *     severity says it with a labelled `.sev` chip on its title row — the
 *     offline notice and each writing check below.
 *
 * Layout — both vertical boundaries are shell `.dock`s (CONTRACT §6b), so a
 * pinned footer can never slice the content above it:
 *
 *   editor card                     right rail
 *   ├ title + character count       ├ dock__scroll
 *   ├ section tag palette           │   ├ assistant (write / refine)
 *   └ dock                          │   ├ structure
 *     ├ dock__scroll → document     │   └ checks
 *     └ dock__foot   → stats, exit  └ dock__foot → the one primary action
 *
 * Cross-lane handoff (documented here for the create/studio lanes):
 *   `ctx.storage.set('handoff', { to, source, at, title, lyrics, styleTags,
 *                                 targetDuration, isInstrumental:false })`
 *   plus a `lyrics:handoff` bus event carrying the same object, then
 *   `ctx.navigate(to)`. Consuming it is optional; nothing here depends on it.
 *
 * @module screens/lyrics
 */

export const meta = {
  title: 'Lyrics',
  subtitle: 'Write the words, then send them to a song',
  css: '/css/screens/lyrics.css',
};

/* ========================================================================== *
 * Small DOM helper
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

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/* ========================================================================== *
 * Document model — the writing rules, expressed as a parser
 * ========================================================================== */

const TAG_LINE = /^([ \t]*)(\[[^\]\n]*\])[ \t]*(.*)$/;
const WORD = /[\p{L}\p{N}'’\-]+/gu;

/** Roughly 12–16 sung words per 10 s → 1.2–1.6 words a second. */
const WORDS_PER_SEC = { fast: 1.6, slow: 1.2 };

const LYRICS_MAX = 3500;

const countWords = (line) => (line.match(WORD) || []).length;

/**
 * Split the document into sections at every tag line.
 * @returns {{tag: ?string, valid: boolean, line: number, lines: string[], words: number}[]}
 */
function parseSections(text, allowed) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  const push = () => { if (current) sections.push(current); };
  const open = (tag, index) => {
    push();
    current = {
      tag,
      valid: tag === null ? true : allowed.includes(tag),
      line: index,
      lines: [],
      words: 0,
    };
  };

  lines.forEach((raw, index) => {
    const match = TAG_LINE.exec(raw);
    if (match) {
      open(match[2].toLowerCase(), index);
      if (match[3].trim()) current.words += countWords(match[3]); // dropped, but visible
      return;
    }
    if (!current) {
      if (!raw.trim()) return;
      open(null, index);
    }
    current.lines.push(raw);
    current.words += countWords(raw);
  });
  push();
  return sections;
}

/**
 * Sung words. Words sharing a line with a tag are never sung, so they do not
 * count towards the length estimate — they are flagged instead.
 */
function sungWords(text) {
  return text.split('\n').reduce((total, raw) => (TAG_LINE.test(raw) ? total : total + countWords(raw)), 0);
}

/**
 * The shape a song of this length usually takes: what the Checks panel wants to
 * see, the sentence that describes it, and the sections themselves — used for
 * the starter buttons and for the plan the Structure panel previews.
 */
function structureTarget(seconds) {
  if (seconds <= 30) {
    return {
      name: 'Verse + chorus',
      need: ['[verse]', '[chorus]'],
      shape: 'one verse and one chorus',
      tags: ['[verse]', '[chorus]'],
    };
  }
  if (seconds < 120) {
    return {
      name: 'Verse · pre-chorus · chorus',
      need: ['[verse]', '[pre-chorus]', '[chorus]'],
      shape: 'verse / pre-chorus / chorus / verse / chorus',
      tags: ['[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[verse]', '[chorus]'],
    };
  }
  return {
    name: 'Full song with a bridge',
    need: ['[verse]', '[chorus]', '[bridge]', '[outro]'],
    shape: 'a full structure with a bridge and an outro',
    tags: ['[intro]', '[verse]', '[pre-chorus]', '[chorus]', '[verse]', '[pre-chorus]',
      '[chorus]', '[bridge]', '[chorus]', '[outro]'],
  };
}

/** Words that describe the production, which belongs in the song's style. */
const DIRECTION_WORDS = [
  'bpm', 'tempo', 'crescendo', 'reverb', 'delay pedal', 'arpeggio', 'sub-bass',
  '808', 'synth', 'synths', 'guitar solo', 'drum machine', 'fade out', 'fade in',
  'half-time', 'four on the floor', 'sidechain', 'filter sweep',
];

/**
 * Every writing rule, as a list the Checks panel can render. Customer language
 * throughout — no rule numbers, no model names.
 *
 * @returns {{id, level: 'error'|'warn', title, detail, line: ?number, fix: ?object}[]}
 */
function checkRules(text, allowed, targetSeconds) {
  const issues = [];
  const lines = text.split('\n');
  if (!text.trim()) return issues;

  const seen = new Set();

  lines.forEach((raw, index) => {
    const match = TAG_LINE.exec(raw);
    if (!match) return;
    const tag = match[2].toLowerCase();
    const trailing = match[3].trim();
    seen.add(tag);

    if (!allowed.includes(tag)) {
      const guess = nearestTag(tag, allowed);
      issues.push({
        id: `tag:${index}`,
        level: 'error',
        title: `${match[2]} is not a section`,
        detail: guess
          ? `Section tags come from the row above the editor. Closest match: ${guess}.`
          : 'Section tags come from the row above the editor — anything else is sung as a lyric.',
        line: index,
        fix: guess ? { label: `Use ${guess}`, kind: 'retag', line: index, tag: guess } : null,
      });
    } else if (match[2] !== tag) {
      issues.push({
        id: `case:${index}`,
        level: 'warn',
        title: `${match[2]} should be lowercase`,
        detail: 'Tags are read exactly as written — [verse], [chorus], and so on.',
        line: index,
        fix: { label: 'Lowercase it', kind: 'retag', line: index, tag },
      });
    }

    if (trailing) {
      issues.push({
        id: `trailing:${index}`,
        level: 'error',
        title: `Words share a line with ${match[2]}`,
        detail: `“${trailing}” will not be sung — a section tag needs a line to itself.`,
        line: index,
        fix: { label: 'Move to next line', kind: 'split', line: index },
      });
    }
  });

  const firstContent = lines.findIndex((l) => l.trim());
  if (firstContent >= 0 && !TAG_LINE.test(lines[firstContent])) {
    issues.push({
      id: 'untagged',
      level: 'warn',
      title: 'The song starts before any section',
      detail: 'Open with [intro] or [verse] so the first lines belong somewhere.',
      line: firstContent,
      fix: { label: 'Add [verse] above', kind: 'prepend', line: firstContent, tag: '[verse]' },
    });
  }

  for (const section of parseSections(text, allowed)) {
    if ((section.tag === '[instrumental]' || section.tag === '[solo]') && section.words > 0) {
      issues.push({
        id: `instrumental:${section.line}`,
        level: 'error',
        title: `${section.tag} has ${plural(section.words, 'word')} in it`,
        detail: 'Instrumental and solo passages carry no words — move them into a sung section.',
        line: section.line,
        fix: null,
      });
    }
  }

  if (text.length > LYRICS_MAX) {
    issues.push({
      id: 'length',
      level: 'error',
      title: `${text.length.toLocaleString()} characters — only the first 3,500 are sung`,
      detail: 'Trim the draft so nothing is lost part way through.',
      line: null,
      fix: { label: 'Trim to 3,500', kind: 'trim' },
    });
  }

  const words = sungWords(text);
  if (!words && seen.size) {
    issues.push({
      id: 'nowords',
      level: 'warn',
      title: 'The sections are laid out, but nothing is written yet',
      detail: 'Write lines under each section, or say what the song is about and have them written for you.',
      line: null,
      fix: null,
    });
  }
  if (words) {
    const fast = words / WORDS_PER_SEC.fast;
    const slow = words / WORDS_PER_SEC.slow;
    if (slow < targetSeconds * 0.6) {
      issues.push({
        id: 'short',
        level: 'warn',
        title: `About ${clock(fast)}–${clock(slow)} of singing for a ${clock(targetSeconds)} song`,
        detail: 'That leaves long stretches with nothing sung. Add a section, or aim for a shorter song.',
        line: null,
        fix: null,
      });
    } else if (fast > targetSeconds * 1.25) {
      issues.push({
        id: 'long',
        level: 'warn',
        title: `About ${clock(fast)}–${clock(slow)} of singing for a ${clock(targetSeconds)} song`,
        detail: 'More words than the song has room for. Cut a few lines, or aim longer.',
        line: null,
        fix: null,
      });
    }
  }

  const target = structureTarget(targetSeconds);
  const missing = target.need.filter((tag) => !seen.has(tag));
  if (seen.size && missing.length) {
    issues.push({
      id: 'structure',
      level: 'warn',
      title: `A ${clock(targetSeconds)} song has room for ${missing.join(', ')}`,
      detail: `At this length the usual shape is ${target.shape}.`,
      line: null,
      fix: null,
    });
  }

  const lower = text.toLowerCase();
  const found = DIRECTION_WORDS.filter((word) => lower.includes(word));
  if (found.length) {
    issues.push({
      id: 'direction',
      level: 'warn',
      title: `“${found.slice(0, 3).join('”, “')}” reads as a production note`,
      detail: 'Tempo, instruments and dynamics belong in the song’s style, not in the sung lines.',
      line: null,
      fix: null,
    });
  }

  return issues;
}

/** Cheap fuzzy match so `[Verse 2]` can offer `[verse]`. */
function nearestTag(tag, allowed) {
  const bare = tag.replace(/[^a-z]/g, '');
  const direct = allowed.find((t) => t.replace(/[^a-z]/g, '') === bare);
  if (direct) return direct;
  const alias = {
    prechorus: '[pre-chorus]', postchorus: '[post-chorus]', refrain: '[chorus]',
    hook: '[chorus]', intro: '[intro]', ending: '[outro]', break: '[instrumental]',
  };
  if (alias[bare]) return alias[bare];
  return allowed.find((t) => bare && t.replace(/[^a-z]/g, '').startsWith(bare.slice(0, 4))) || null;
}

/* ========================================================================== *
 * Editor highlighting — tags in the accent, unsung words struck through
 * ========================================================================== */

function highlight(text, allowed) {
  return `${text.split('\n').map((raw) => {
    const match = TAG_LINE.exec(raw);
    if (!match) return escapeHtml(raw) || '&nbsp;';
    const [, indent, tag] = match;
    /* Everything after the tag, INCLUDING the spaces the parser skips over.
       This layer sits on the textarea character for character, so swallowing
       one space here would slide the caret a space away from its glyphs. */
    const after = raw.slice(indent.length + tag.length);
    const ok = allowed.includes(tag.toLowerCase());
    const tagSpan = `<span class="${ok ? 'hl-tag' : 'hl-tag hl-tag--bad'}">${escapeHtml(tag)}</span>`;
    const afterSpan = after.trim() ? `<span class="hl-dropped">${escapeHtml(after)}</span>` : escapeHtml(after);
    return `${escapeHtml(indent)}${tagSpan}${afterSpan}`;
  }).join('\n')}\n`;
}

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const DRAFT_KEY = 'lyrics.draft';
const HANDOFF_KEY = 'handoff';

const TARGETS = [30, 60, 120, 180, 300];

/** First-move suggestions, offered only while the idea box is empty. */
const IDEA_SEEDS = [
  {
    label: 'Late-night drive',
    idea: 'Driving home at 2am after a fight I started. Regret, headlights, one honest line in the chorus.',
  },
  {
    label: 'Small-town summer',
    idea: 'The last summer before everyone leaves town. Warm, restless, a little defiant.',
  },
  {
    label: 'A letter never sent',
    idea: 'Everything I wanted to say to someone I have not spoken to in ten years.',
  },
];

const REWRITE_PRESETS = [
  { chip: 'Tighter', text: 'Tighter — fewer words, same meaning' },
  { chip: 'Concrete images', text: 'Swap the abstractions for concrete images' },
  { chip: 'Bigger chorus', text: 'Make the chorus bigger and easier to sing' },
  { chip: 'Darker', text: 'Darker, more restrained' },
  { chip: 'Add a bridge', text: 'Add a bridge that turns the story' },
];

/** Real, deterministic starting shapes — each inserts sections and sets the length. */
const STARTERS = [30, 60, 180].map((target) => ({ target, ...structureTarget(target) }));

/* ========================================================================== *
 * Mount
 * ========================================================================== */

export async function mount(root, ctx) {
  const { api } = ctx;
  const TAGS = api.SECTION_TAGS;

  const saved = ctx.storage.get(DRAFT_KEY, null) || {};
  const state = {
    title: String(ctx.route.query.title || saved.title || ''),
    text: String(saved.text || ''),
    idea: String(ctx.route.query.idea || saved.idea || ''),
    target: TARGETS.includes(Number(saved.target)) ? Number(saved.target) : 120,
    styleTags: String(saved.styleTags || ''),
    mode: saved.mode === 'refine' ? 'refine' : 'write',
    busy: null,        // 'write' | 'rewrite'
    undo: null,        // one level of undo for the last generated draft
    health: null,
  };

  const page = el('div', { class: 'screen-lyrics' });

  /* ------------------------------------------------------------- topbar -- */

  const newDraftBtn = el('button', {
    class: 'btn btn--sm btn--ghost', type: 'button',
    onclick: () => newDraft(),
  }, [ctx.icon('plus'), 'New draft']);
  ctx.headerSlot.append(newDraftBtn);

  /* ======================================================= EDITOR COLUMN == */

  const titleInput = el('input', {
    class: 'lyr-title', type: 'text', placeholder: 'Untitled song',
    maxlength: '120', 'aria-label': 'Song title', value: state.title,
    oninput: () => { state.title = titleInput.value; persist(); },
  });

  const charCount = el('span', { class: 'lyr-count mono' });

  const tagbar = el('div', { class: 'lyr-tagbar', role: 'group', 'aria-label': 'Insert a section' },
    TAGS.map((tag) => el('button', {
      class: 'chip chip--mono lyr-tagchip', type: 'button', text: tag,
      title: `Insert ${tag} on its own line`,
      onclick: () => insertTag(tag),
    })));

  const highlightLayer = el('pre', { class: 'lyr-doc__hl', 'aria-hidden': 'true' });
  const DOC_PLACEHOLDER = '[verse]\nThe first line goes here\n\n[chorus]\nOne tag to a line — anything typed beside a tag is never sung';
  const doc = el('textarea', {
    class: 'lyr-doc__ta',
    spellcheck: 'true',
    'aria-label': 'Lyrics',
  });
  doc.value = state.text;

  /* The blank sheet is a designed state, not a void: it names what to do and
     offers three real starting shapes. It sits over the (empty) document and
     steps out of the way the moment the writer takes the surface. */
  const blank = el('div', { class: 'lyr-blank' }, [
    /* No illustration tile: the heading sits exactly where the first sung line
       will land, so the invitation is the page itself. The two blocks are
       pinned to the top and the bottom of the sheet, which gives the empty
       state a floor instead of one small card afloat in the middle. */
    el('div', { class: 'lyr-blank__lead' }, [
      el('p', { class: 'lyr-blank__title', text: 'A blank sheet' }),
      el('p', { class: 'lyr-blank__text', text: 'Say what the song is about on the right and it gets written for you — or lay out the sections and fill them in yourself.' }),
    ]),
    el('div', { class: 'lyr-starters' }, [
      el('span', { class: 'lyr-starters__label', text: 'Start from a structure' }),
      /* Each card shows the sections it will actually lay down, so the choice
         is legible before it is made — and so the sparse state is a designed
         surface rather than three thin buttons on a dark field. */
      el('div', { class: 'lyr-starters__row' }, STARTERS.map((starter) => el('button', {
        class: 'lyr-starter', type: 'button',
        'aria-label': `${starter.name} — ${plural(starter.tags.length, 'section')} for a ${clock(starter.target)} song`,
        onclick: () => applyStarter(starter),
      }, [
        el('span', { class: 'lyr-starter__head' }, [
          el('span', { class: 'lyr-starter__name', text: starter.name }),
          el('span', { class: 'lyr-starter__meta mono', text: clock(starter.target) }),
        ]),
        el('span', { class: 'lyr-starter__tags', 'aria-hidden': 'true' }, [
          ...starter.tags.slice(0, 3).map((tag) => el('span', { class: 'lyr-starter__tag mono', text: tag })),
          starter.tags.length > 3
            ? el('span', { class: 'lyr-starter__tag lyr-starter__tag--more mono', text: `+${starter.tags.length - 3}` })
            : null,
        ]),
      ]))),
    ]),
  ]);

  const docWrap = el('div', { class: 'lyr-doc' }, [highlightLayer, doc, blank]);

  const docScroll = el('div', { class: 'dock__scroll lyr-docscroll' }, [docWrap]);

  const statWords = el('span', { class: 'lyr-stat' });
  const statLength = el('span', { class: 'lyr-stat' });
  const statSections = el('span', { class: 'lyr-stat' });
  const statCheck = el('button', {
    class: 'badge lyr-statcheck', type: 'button', hidden: true,
    title: 'Show the checks',
    onclick: () => {
      checkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      checkPanel.classList.remove('is-flash');
      void checkPanel.offsetWidth;
      checkPanel.classList.add('is-flash');
    },
  });

  const copyChip = el('button', {
    class: 'actionchip', type: 'button', 'aria-label': 'Copy lyrics', title: 'Copy lyrics',
    onclick: () => copy(doc.value, 'Lyrics copied.'),
  }, [ctx.icon('copy')]);

  const docMenu = ctx.menu({
    label: 'More actions',
    items: () => {
      const has = doc.value.trim().length > 0;
      return [
        { label: 'Send to Studio', icon: 'studio', disabled: !has, onSelect: () => handoff('studio', 'Studio') },
        { label: 'Copy lyrics', icon: 'copy', disabled: !has, onSelect: () => copy(doc.value, 'Lyrics copied.') },
        { separator: true },
        { label: 'Clear draft', icon: 'trash', danger: true, disabled: !has && !state.title.trim() && !state.idea.trim(), onSelect: () => newDraft() },
      ];
    },
  });

  const sendBtn = el('button', {
    class: 'btn btn--strong', type: 'button',
    onclick: () => handoff('create', 'Create'),
  }, [ctx.icon('create'), 'Send to Create']);

  /* The chips and the hand-off button travel together, so when the column
     narrows they wrap as one right-aligned group instead of the button
     stranding itself on a line of its own. */
  const editorFoot = el('div', { class: 'dock__foot dock__foot--fade lyr-foot' }, [
    el('div', { class: 'lyr-stats' }, [statWords, statLength, statSections, statCheck]),
    el('span', { class: 'spacer' }),
    el('div', { class: 'lyr-foot__actions' }, [
      el('div', { class: 'actionbar' }, [copyChip, docMenu]),
      sendBtn,
    ]),
  ]);

  const editor = el('section', { class: 'lyr-editor' }, [
    el('header', { class: 'lyr-editor__head' }, [titleInput, charCount]),
    tagbar,
    el('div', { class: 'dock lyr-dock lyr-editor__dock' }, [docScroll, editorFoot]),
  ]);

  /* ========================================================= RIGHT RAIL == */

  /* 1 — assistant --------------------------------------------------------- */

  const modeButtons = [
    el('button', { class: 'segment__item is-active', type: 'button', text: 'Write', 'aria-pressed': 'true', onclick: () => setMode('write') }),
    el('button', { class: 'segment__item', type: 'button', text: 'Refine', 'aria-pressed': 'false', onclick: () => setMode('refine') }),
  ];
  const segment = el('div', { class: 'segment lyr-modes', role: 'group', 'aria-label': 'Assistant mode' }, modeButtons);

  /* Severity is a labelled chip on the title row (CONTRACT §0b/§6d) — never a
     coloured bar down the left edge. */
  const offlineNotice = el('div', { class: 'notice notice--warn lyr-offline', hidden: true }, [
    el('span', { class: 'notice__icon', html: ctx.iconMarkup('alert') }),
    el('div', { class: 'notice__body' }, [
      // The title already says "offline"; the icon and border say how serious.
      el('p', { class: 'notice__head' }, [
        el('span', { class: 'notice__title', text: 'Writing help is offline' }),
      ]),
      el('p', { text: 'You can still write and check the words by hand.' }),
      el('button', {
        class: 'btn btn--sm lyr-offline__btn', type: 'button', text: 'Open Settings',
        onclick: () => ctx.navigate('settings'),
      }),
    ]),
  ]);

  const ideaInput = el('textarea', {
    class: 'textarea lyr-idea',
    rows: '3',
    placeholder: 'Two lines about the song — who it is for, what happened, how it should feel.',
    'aria-label': 'What the song is about',
  });
  ideaInput.value = state.idea;
  ideaInput.addEventListener('input', () => { state.idea = ideaInput.value; persist(); syncAction(); });
  ideaInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  const ideaSeeds = el('div', { class: 'lyr-seeds' }, IDEA_SEEDS.map((seed) => el('button', {
    class: 'chip lyr-seed', type: 'button', text: seed.label, title: seed.idea,
    onclick: () => {
      ideaInput.value = seed.idea;
      state.idea = seed.idea;
      persist();
      syncAction();
      ideaInput.focus();
    },
  })));

  const targetChips = TARGETS.map((sec) => el('button', {
    class: 'chip lyr-target', type: 'button', text: clock(sec),
    'aria-pressed': sec === state.target ? 'true' : 'false',
    onclick: () => setTarget(sec),
  }));
  const targetRow = el('div', { class: 'lyr-targets', role: 'group', 'aria-label': 'Song length' }, targetChips);

  const writeHint = el('p', { class: 'hint' });
  const writeRun = el('div', { class: 'lyr-run', hidden: true });

  const writePane = el('div', { class: 'lyr-pane' }, [
    offlineNotice,
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'What is the song about?' }),
      ideaInput,
      ideaSeeds,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'label', text: 'How long is the song?' }),
      targetRow,
    ]),
    writeHint,
    writeRun,
  ]);

  const scopeHint = el('span', { class: 'label__hint', text: 'whole song' });
  const instructionInput = el('input', {
    class: 'input', type: 'text',
    placeholder: 'Make the chorus land harder',
    'aria-label': 'What should change',
    oninput: () => syncAction(),
  });
  instructionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  });

  const presetRow = el('div', { class: 'lyr-presets' }, REWRITE_PRESETS.map((preset) => el('button', {
    class: 'chip', type: 'button', text: preset.chip, title: preset.text,
    onclick: () => { instructionInput.value = preset.text; syncAction(); instructionInput.focus(); },
  })));

  const undoBtn = el('button', {
    class: 'btn btn--sm btn--ghost lyr-undo', type: 'button', hidden: true,
    onclick: () => revert(),
  }, [ctx.icon('refresh'), 'Undo']);

  const rewriteRun = el('div', { class: 'lyr-run', hidden: true });

  const refinePane = el('div', { class: 'lyr-pane', hidden: true }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'label' }, ['What should change?', scopeHint]),
      instructionInput,
    ]),
    presetRow,
    el('p', { class: 'hint', text: 'Select lines in the editor to rewrite only those.' }),
    rewriteRun,
  ]);

  const assistantPanel = el('section', { class: 'panel lyr-panel lyr-assistant' }, [
    el('div', { class: 'panel__head lyr-modehead' }, [segment, el('span', { class: 'spacer' }), undoBtn]),
    el('div', { class: 'panel__body' }, [writePane, refinePane]),
  ]);

  /* 2 — structure --------------------------------------------------------- */

  const outline = el('div', { class: 'lyr-outline' });
  const estimateOut = el('span', { class: 'lyr-estimate mono' });
  const structurePanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Structure' }),
      el('span', { class: 'spacer' }),
      estimateOut,
    ]),
    el('div', { class: 'panel__body' }, [outline]),
  ]);

  /* 3 — checks ------------------------------------------------------------ */

  const checkBody = el('div', { class: 'lyr-checks' });
  const checkBadge = el('span', { class: 'badge' });
  const checkPanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Checks' }),
      el('span', { class: 'spacer' }),
      checkBadge,
    ]),
    el('div', { class: 'panel__body' }, [checkBody]),
  ]);

  /* the rail's one pinned action ------------------------------------------ */

  const actionIcon = el('span', { class: 'lyr-action__icon' });
  const actionLabel = el('span', { class: 'lyr-action__label' });
  const actionBtn = el('button', {
    class: 'btn btn--primary btn--lg btn--block lyr-action', type: 'button',
    onclick: () => run(),
  }, [actionIcon, actionLabel]);

  const cancelBtn = el('button', {
    class: 'btn btn--lg btn--outline lyr-cancel', type: 'button', text: 'Cancel', hidden: true,
    onclick: () => inFlight?.abort(new DOMException('Cancelled', 'AbortError')),
  });

  // Checks sits above Structure: it is short and actionable, while the outline
  // is the long list that should be the one to scroll.
  const railScroll = el('div', { class: 'dock__scroll lyr-rail__scroll' }, [assistantPanel, checkPanel, structurePanel]);
  const railFoot = el('div', { class: 'dock__foot dock__foot--fade lyr-rail__foot' }, [actionBtn, cancelBtn]);
  const rail = el('aside', { class: 'lyr-rail dock lyr-dock' }, [railScroll, railFoot]);

  page.append(editor, rail);
  root.append(page);

  /* ========================================================================
   * Behaviour
   * ===================================================================== */

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ctx.storage.set(DRAFT_KEY, snapshot()), 400);
  }

  function snapshot() {
    return {
      title: state.title, text: doc.value, idea: ideaInput.value,
      target: state.target, styleTags: state.styleTags, mode: state.mode,
      updatedAt: Date.now(),
    };
  }

  async function copy(text, message) {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(message, { kind: 'success' });
    } catch (err) {
      ctx.toast(`Clipboard refused the copy: ${err?.message || err}`, { kind: 'warn' });
    }
  }

  /* ------------------------------------------------------------- editing */

  /** Write through execCommand so the browser's own undo stack keeps working. */
  function insertAtCursor(textToInsert) {
    doc.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, textToInsert); } catch { ok = false; }
    if (!ok) {
      doc.setRangeText(textToInsert, doc.selectionStart, doc.selectionEnd, 'end');
    }
    onDocInput();
  }

  function setDocValue(next) {
    doc.value = next;
    onDocInput();
  }

  function insertTag(tag) {
    const before = doc.value.slice(0, doc.selectionStart);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    insertAtCursor(`${lead}${tag}\n`);
  }

  function applyStarter(starter) {
    setTarget(starter.target);
    setDocValue(`${starter.tags.join('\n\n')}\n`);
    doc.focus();
    doc.setSelectionRange(starter.tags[0].length + 1, starter.tags[0].length + 1);
    syncScrollPosition(0);
  }

  function setTarget(seconds) {
    state.target = seconds;
    for (const chip of targetChips) {
      chip.setAttribute('aria-pressed', chip.textContent === clock(seconds) ? 'true' : 'false');
    }
    persist();
    renderRail();
  }

  function setMode(mode, { focus = true } = {}) {
    state.mode = mode;
    modeButtons.forEach((btn, index) => {
      const on = index === (mode === 'write' ? 0 : 1);
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    writePane.hidden = mode !== 'write';
    refinePane.hidden = mode !== 'refine';
    persist();
    syncAction();
    autosize();
    if (focus) (mode === 'write' ? ideaInput : instructionInput).focus({ preventScroll: true });
  }

  function newDraft() {
    const previous = snapshot();
    const hadSomething = previous.text.trim() || previous.title.trim() || previous.idea.trim();

    state.title = ''; state.idea = ''; state.styleTags = ''; state.undo = null;
    titleInput.value = ''; ideaInput.value = ''; doc.value = '';
    undoBtn.hidden = true;
    renderAll();
    persist();
    ideaInput.focus();

    if (!hadSomething) return;
    ctx.toast('Title, idea and lyrics cleared.', {
      kind: 'info', title: 'New draft', timeout: 12000, key: 'lyrics-new-draft',
      action: {
        label: 'Undo',
        onClick: () => {
          state.title = previous.title;
          state.idea = previous.idea;
          state.styleTags = previous.styleTags;
          titleInput.value = previous.title;
          ideaInput.value = previous.idea;
          doc.value = previous.text;
          renderAll();
          persist();
        },
      },
    });
  }

  function lineOffsets(index) {
    const lines = doc.value.split('\n');
    let start = 0;
    for (let i = 0; i < index && i < lines.length; i += 1) start += lines[i].length + 1;
    return { start, end: start + (lines[index] ?? '').length };
  }

  function syncScrollPosition(top) {
    docScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function focusLine(index) {
    const { start, end } = lineOffsets(index);
    doc.focus();
    doc.setSelectionRange(start, end);
    const styles = getComputedStyle(doc);
    const lineHeight = parseFloat(styles.lineHeight) || 22;
    const padTop = parseFloat(styles.paddingTop) || 0;
    const y = doc.offsetTop + padTop + index * lineHeight;
    syncScrollPosition(y - docScroll.clientHeight / 2);
    updateSelection();
  }

  function applyFix(fix) {
    const lines = doc.value.split('\n');
    if (fix.kind === 'retag') {
      const match = TAG_LINE.exec(lines[fix.line]);
      if (!match) return;
      lines[fix.line] = `${match[1]}${fix.tag}${match[3] ? ` ${match[3]}` : ''}`;
      setDocValue(lines.join('\n'));
    } else if (fix.kind === 'split') {
      const match = TAG_LINE.exec(lines[fix.line]);
      if (!match) return;
      lines.splice(fix.line, 1, `${match[1]}${match[2]}`, match[3]);
      setDocValue(lines.join('\n'));
    } else if (fix.kind === 'prepend') {
      lines.splice(fix.line, 0, fix.tag);
      setDocValue(lines.join('\n'));
    } else if (fix.kind === 'trim') {
      const cut = doc.value.slice(0, LYRICS_MAX);
      const lastBreak = cut.lastIndexOf('\n');
      setDocValue(lastBreak > LYRICS_MAX - 500 ? cut.slice(0, lastBreak) : cut);
    }
    persist();
  }

  function handoff(to, label) {
    const lyrics = doc.value.trim();
    if (!lyrics) return;
    const payload = {
      to,
      source: 'lyrics',
      at: Date.now(),
      title: state.title.trim(),
      lyrics,
      styleTags: state.styleTags,
      targetDuration: state.target,
      isInstrumental: false,
    };
    ctx.storage.set(HANDOFF_KEY, payload);
    ctx.bus.emit('lyrics:handoff', payload);

    const sections = parseSections(lyrics, TAGS).filter((s) => s.tag).length;
    const words = sungWords(lyrics);
    ctx.toast(
      `${payload.title || 'Untitled song'} — ${plural(sections, 'section')}, about ${clock(words / WORDS_PER_SEC.slow)} of singing.`,
      { kind: 'success', title: `Sent to ${label}`, key: 'lyrics-handoff' },
    );
    ctx.navigate(to);
  }

  /* ----------------------------------------------------------- rendering */

  /**
   * The document has no scroller of its own — the dock scrolls, and the
   * textarea grows to fit. That is what keeps a section heading from ever being
   * guillotined by the footer.
   */
  /** Keep the pinned bar on the same right edge as the cards above it. */
  function alignRail() {
    const gutter = Math.max(0, railScroll.offsetWidth - railScroll.clientWidth);
    railFoot.style.paddingRight = `${gutter}px`;
  }

  function autosize() {
    alignRail();
    const styles = getComputedStyle(docScroll);
    const avail = docScroll.clientHeight
      - (parseFloat(styles.paddingTop) || 0)
      - (parseFloat(styles.paddingBottom) || 0);
    doc.style.height = 'auto';
    doc.style.height = `${Math.max(doc.scrollHeight, Math.max(240, avail))}px`;
  }

  function renderEditor() {
    highlightLayer.innerHTML = highlight(doc.value, TAGS);

    const chars = doc.value.length;
    charCount.textContent = `${chars.toLocaleString()} / 3,500`;
    charCount.classList.toggle('is-over', chars > LYRICS_MAX);

    const words = sungWords(doc.value);
    const sections = parseSections(doc.value, TAGS).filter((s) => s.tag);
    statWords.textContent = plural(words, 'sung word');
    statLength.textContent = words ? `about ${clock(words / WORDS_PER_SEC.slow)}` : '0:00';
    statSections.textContent = plural(sections.length, 'section');

    const empty = !doc.value.trim();
    // The blank sheet gives way to the format hint the moment the writer is in
    // the document, so the two never talk over each other.
    const writing = document.activeElement === doc;
    blank.hidden = !empty || writing;
    doc.placeholder = empty && writing ? DOC_PLACEHOLDER : '';
    copyChip.disabled = empty;
    sendBtn.disabled = empty;
    autosize();
  }

  function renderOutline() {
    const sections = parseSections(doc.value, TAGS);
    outline.replaceChildren();

    const words = sungWords(doc.value);
    estimateOut.textContent = `${clock(words / WORDS_PER_SEC.slow)} of ${clock(state.target)}`;

    // Nothing written yet: preview the shape a song of this length usually
    // takes, so the panel plans the song instead of reporting an empty one.
    if (!sections.length) {
      const plan = structureTarget(state.target);
      outline.append(el('p', {
        class: 'hint lyr-outline__lead',
        text: `A ${clock(state.target)} song usually runs like this:`,
      }));
      for (const tag of plan.tags) {
        outline.append(el('div', { class: 'lyr-outline__row is-ghost' }, [
          el('span', { class: 'lyr-outline__tag mono', text: tag }),
          el('span', { class: 'lyr-outline__bar' }),
          el('span', { class: 'lyr-outline__meta mono', text: '—' }),
        ]));
      }
      return;
    }

    for (const section of sections) {
      const seconds = section.words / WORDS_PER_SEC.slow;
      outline.append(el('button', {
        class: `lyr-outline__row${section.valid ? '' : ' is-bad'}`,
        type: 'button',
        onclick: () => focusLine(section.line),
      }, [
        el('span', { class: 'lyr-outline__tag mono', text: section.tag || 'untagged' }),
        el('span', { class: 'lyr-outline__bar' }, [
          el('span', {
            class: 'lyr-outline__fill',
            style: `width:${Math.min(100, Math.round((seconds / Math.max(state.target, 1)) * 100))}%`,
          }),
        ]),
        el('span', { class: 'lyr-outline__meta mono', text: section.words ? `${section.words}w` : '—' }),
      ]));
    }

    outline.append(el('p', {
      class: 'hint lyr-outline__hint',
      text: `A ${clock(state.target)} song usually runs ${structureTarget(state.target).shape}.`,
    }));
  }

  function renderChecks() {
    const issues = checkRules(doc.value, TAGS, state.target);
    checkBody.replaceChildren();

    const errors = issues.filter((i) => i.level === 'error').length;
    const warnings = issues.length - errors;
    const tone = errors ? 'badge--danger' : warnings ? 'badge--warn' : 'badge--ok';
    const summary = errors ? `${errors} to fix` : warnings ? `${warnings} to look at` : 'Ready';

    checkBadge.className = `badge ${tone}`;
    checkBadge.textContent = summary;
    checkBadge.hidden = false;
    statCheck.hidden = false;
    statCheck.className = `badge lyr-statcheck ${tone}`;
    statCheck.textContent = summary;

    if (!doc.value.trim()) {
      checkBadge.className = 'badge';
      checkBadge.textContent = '';
      checkBadge.hidden = true;
      statCheck.hidden = true;
      checkBody.append(el('p', {
        class: 'hint',
        text: 'Sections tagged one to a line, roughly 12–16 sung words every 10 seconds. Checked as you type.',
      }));
      return;
    }

    if (!issues.length) {
      checkBody.append(el('div', { class: 'lyr-clean' }, [
        el('span', { class: 'lyr-clean__icon', html: ctx.iconMarkup('check') }),
        el('div', {}, [
          el('p', { class: 'lyr-clean__title', text: 'Ready to sing' }),
          el('p', { class: 'hint', text: `Sections, structure and length all fit the ${clock(state.target)} target.` }),
        ]),
      ]));
      return;
    }

    for (const issue of issues) {
      const actions = [];
      if (issue.line !== null && issue.line !== undefined) {
        actions.push(el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button',
          text: `Line ${issue.line + 1}`,
          onclick: () => focusLine(issue.line),
        }));
      }
      if (issue.fix) {
        actions.push(el('button', {
          class: 'btn btn--sm', type: 'button', text: issue.fix.label,
          onclick: () => applyFix(issue.fix),
        }));
      }
      const error = issue.level === 'error';
      checkBody.append(el('div', { class: `lyr-check lyr-check--${issue.level}` }, [
        el('div', { class: 'lyr-check__head' }, [
          el('p', { class: 'lyr-check__title', text: issue.title }),
          el('span', {
            class: `sev ${error ? 'sev--error' : 'sev--warn'}`,
            text: error ? 'Fix' : 'Look at',
          }),
        ]),
        el('p', { class: 'lyr-check__detail', text: issue.detail }),
        actions.length ? el('div', { class: 'lyr-check__actions' }, actions) : null,
      ]));
    }
  }

  function renderRail() {
    renderOutline();
    renderChecks();
    syncAction();
  }

  function renderAll() {
    state.text = doc.value;
    renderEditor();
    renderRail();
  }

  function onDocInput() {
    renderAll();
    persist();
  }

  function updateSelection() {
    const start = doc.selectionStart;
    const end = doc.selectionEnd;
    if (start === end) {
      scopeHint.textContent = 'whole song';
    } else {
      const lines = doc.value.slice(start, end).split('\n').length;
      scopeHint.textContent = `${plural(lines, 'line')} selected`;
    }
    if (state.mode === 'refine') syncAction();
  }

  doc.addEventListener('input', onDocInput);
  doc.addEventListener('select', updateSelection);
  doc.addEventListener('keyup', updateSelection);
  doc.addEventListener('mouseup', updateSelection);
  doc.addEventListener('focus', renderEditor);
  doc.addEventListener('blur', () => { renderEditor(); updateSelection(); });

  const onResize = () => autosize();
  window.addEventListener('resize', onResize);

  /* -------------------------------------------------------- availability */

  const writingAvailable = () => Boolean(state.health && state.health.lyricsEnabled);

  function selectionLength() {
    return Math.max(0, doc.selectionEnd - doc.selectionStart);
  }

  function syncAction() {
    const available = writingAvailable();
    const busy = Boolean(state.busy);
    const hasText = doc.value.trim().length > 0;

    offlineNotice.hidden = available || !state.health;
    ideaInput.disabled = !available && Boolean(state.health);
    instructionInput.disabled = !available && Boolean(state.health);
    for (const chip of presetRow.children) chip.disabled = !available && Boolean(state.health);

    let label;
    let reason = '';
    if (state.mode === 'write') {
      const hasIdea = ideaInput.value.trim().length > 0;
      ideaSeeds.hidden = hasIdea;
      for (const chip of ideaSeeds.children) chip.disabled = !available && Boolean(state.health);
      label = busy ? 'Writing…' : 'Write the lyrics';
      if (!available) reason = 'Writing help is offline right now.';
      else if (!hasIdea) reason = 'Say what the song is about first.';
      actionBtn.disabled = busy || !available || !hasIdea;

      writeHint.className = 'hint';
      writeHint.textContent = hasText
        ? 'Replaces the current draft. One undo brings it back.'
        : 'You get a title, a few style words, and the whole song with its sections marked.';
    } else {
      const hasInstruction = instructionInput.value.trim().length > 0;
      const selected = selectionLength() > 0;
      const lines = selected ? doc.value.slice(doc.selectionStart, doc.selectionEnd).split('\n').length : 0;
      label = busy
        ? 'Rewriting…'
        : selected ? `Rewrite ${plural(lines, 'line')}` : 'Rewrite the song';
      if (!available) reason = 'Writing help is offline right now.';
      else if (!hasText) reason = 'Write or paste some lyrics first.';
      else if (!hasInstruction) reason = 'Say what should change.';
      actionBtn.disabled = busy || !available || !hasText || !hasInstruction;
    }

    actionLabel.textContent = label;
    actionIcon.replaceChildren(busy
      ? ctx.icon('spinner', 'icon spinner')
      : ctx.icon(state.mode === 'write' ? 'wand' : 'refresh'));
    if (reason) actionBtn.title = reason; else actionBtn.removeAttribute('title');
    cancelBtn.hidden = !busy;
  }

  /* ------------------------------------------------------------ requests */

  let inFlight = null;
  let tick = null;

  function startRun(node, label) {
    const started = Date.now();
    node.hidden = false;
    node.replaceChildren(
      el('span', { class: 'brandline lyr-run__line' }),
      el('div', { class: 'lyr-run__row' }, [
        el('span', { class: 'lyr-run__label', text: label }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'lyr-run__time mono', text: '0:00' }),
      ]),
    );
    const time = node.querySelector('.lyr-run__time');
    clearInterval(tick);
    tick = setInterval(() => { time.textContent = clock((Date.now() - started) / 1000); }, 1000);
  }

  function endRun(node) {
    clearInterval(tick);
    tick = null;
    node.hidden = true;
    node.replaceChildren();
  }

  function remember(previous) {
    state.undo = previous;
    undoBtn.hidden = false;
  }

  function revert() {
    if (state.undo === null) return;
    setDocValue(state.undo);
    state.undo = null;
    undoBtn.hidden = true;
    ctx.toast('Back to the previous draft.', { kind: 'info', key: 'lyrics-undo' });
  }

  const run = () => (state.mode === 'write' ? write() : rewrite());

  async function write() {
    if (state.busy || !writingAvailable() || !ideaInput.value.trim()) return;
    state.busy = 'write';
    syncAction();
    startRun(writeRun, 'Writing the song…');
    autosize();
    inFlight = new AbortController();

    const prompt = [
      ideaInput.value.trim(),
      `Target length: about ${state.target} seconds — ${structureTarget(state.target).shape}.`,
    ].join('\n');

    try {
      const result = await api.lyrics(
        { mode: 'write_full_song', prompt, title: state.title.trim(), lyrics: '' },
        { signal: inFlight.signal },
      );
      remember(doc.value);
      setDocValue(String(result.lyrics || ''));
      if (result.song_title && !state.title.trim()) {
        state.title = result.song_title;
        titleInput.value = result.song_title;
      }
      state.styleTags = String(result.style_tags || '');
      persist();

      const words = sungWords(doc.value);
      ctx.toast(
        `${state.title || 'Untitled song'} — about ${clock(words / WORDS_PER_SEC.slow)} of singing.`,
        { kind: 'success', title: 'Lyrics written', key: 'lyrics-written', action: { label: 'Undo', onClick: revert } },
      );
    } catch (err) {
      if (err?.name !== 'AbortError') {
        ctx.toast(api.errorText(err), { kind: 'error', title: 'Could not write the lyrics', key: 'lyrics-error' });
      }
    } finally {
      inFlight = null;
      state.busy = null;
      endRun(writeRun);
      syncAction();
      autosize();
    }
  }

  async function rewrite() {
    if (state.busy || !writingAvailable()) return;
    const instruction = instructionInput.value.trim();
    if (!instruction || !doc.value.trim()) return;

    const start = doc.selectionStart;
    const end = doc.selectionEnd;
    const partial = end > start;
    const source = partial ? doc.value.slice(start, end) : doc.value;

    state.busy = 'rewrite';
    syncAction();
    startRun(rewriteRun, partial ? 'Rewriting the selection…' : 'Rewriting the song…');
    inFlight = new AbortController();

    try {
      const result = await api.lyrics(
        {
          mode: 'edit',
          prompt: partial
            ? `${instruction}\nRewrite only this section and return it alone, with the same section tags.`
            : instruction,
          lyrics: source,
          title: state.title.trim(),
        },
        { signal: inFlight.signal },
      );
      const next = String(result.lyrics || '').trim();
      if (!next) throw new api.ApiError('No lyrics came back. Try again, or reword the instruction.');

      remember(doc.value);
      if (partial) {
        doc.focus();
        doc.setSelectionRange(start, end);
        insertAtCursor(next);
      } else {
        setDocValue(next);
      }
      if (result.style_tags) state.styleTags = String(result.style_tags);
      persist();
      ctx.toast(partial ? 'Selection rewritten.' : 'Song rewritten.', {
        kind: 'success', key: 'lyrics-rewritten', action: { label: 'Undo', onClick: revert },
      });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        ctx.toast(api.errorText(err), { kind: 'error', title: 'Could not rewrite the lyrics', key: 'lyrics-error' });
      }
    } finally {
      inFlight = null;
      state.busy = null;
      endRun(rewriteRun);
      syncAction();
    }
  }

  /* --------------------------------------------------------------- health */

  ctx.onHealth((h) => {
    state.health = h;
    syncAction();
  });

  /* ---------------------------------------------------------- first paint */

  setMode(state.mode, { focus: false });
  renderAll();
  updateSelection();
  requestAnimationFrame(() => autosize());

  return () => {
    clearTimeout(saveTimer);
    clearInterval(tick);
    window.removeEventListener('resize', onResize);
    inFlight?.abort(new DOMException('Screen left', 'AbortError'));
    ctx.storage.set(DRAFT_KEY, snapshot());
  };
}
