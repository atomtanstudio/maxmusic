/**
 * Lyrics — the writing workspace.
 *
 * Owned by the lyrics lane (SPEC §6). Everything here is wired to
 * `POST /api/lyrics`, which runs the local Codex CLI. The music backend will
 * *not* write lyrics (SPEC §3e), so this screen is the first half of the
 * "one idea → song" flow: write here, then hand the result to Create or Studio.
 *
 * SPEC §3d is enforced in the editor itself:
 *   - the only nine section tags are `ctx.api.SECTION_TAGS`
 *   - a tag sits alone on its line; words after it are dropped by the model,
 *     so they are struck through in the editor and flagged in Rule check
 *   - ~12–16 sung words per 10 s drives the length estimate
 *   - structure is checked against the target duration
 *
 * Cross-lane handoff (new, documented here for the create/studio lanes):
 *   `ctx.storage.set('handoff', { to, source, at, title, lyrics, styleTags,
 *                                 targetDuration, isInstrumental:false })`
 *   plus a `lyrics:handoff` bus event carrying the same object, then
 *   `ctx.navigate(to)`. Consuming it is optional; nothing here depends on it.
 *
 * @module screens/lyrics
 */

export const meta = {
  title: 'Lyrics',
  subtitle: 'Written by the local Codex CLI, checked against the MiniMax tag rules',
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

/* ========================================================================== *
 * §3d — document model
 * ========================================================================== */

const TAG_LINE = /^([ \t]*)(\[[^\]\n]*\])[ \t]*(.*)$/;
const WORD = /[\p{L}\p{N}'’\-]+/gu;

/** 12–16 sung words per 10 s → 1.2–1.6 words per second. */
const WORDS_PER_SEC = { fast: 1.6, slow: 1.2 };

const countWords = (line) => (line.match(WORD) || []).length;

/**
 * Split the document into sections at every tag line.
 * @returns {{tag: ?string, valid: boolean, label: string, line: number,
 *            lines: string[], words: number}[]}
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
      label: tag === null ? 'before the first tag' : tag,
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
 * Sung words. Words that share a line with a tag are dropped by the model, so
 * they do not count towards the length estimate — they are flagged instead.
 */
function sungWords(text) {
  return text.split('\n').reduce((total, raw) => (TAG_LINE.test(raw) ? total : total + countWords(raw)), 0);
}

function structureTarget(seconds) {
  if (seconds <= 30) {
    return { need: ['[verse]', '[chorus]'], shape: 'one verse and one chorus', band: '≤ 30 s' };
  }
  if (seconds < 120) {
    return {
      need: ['[verse]', '[pre-chorus]', '[chorus]'],
      shape: 'verse / pre-chorus / chorus / verse / chorus',
      band: '~ 60 s',
    };
  }
  return {
    need: ['[verse]', '[chorus]', '[bridge]', '[outro]'],
    shape: 'a full structure with a bridge and an outro',
    band: '≥ 120 s',
  };
}

/** Words that describe the production, which SPEC §3d puts in Arrangement. */
const DIRECTION_WORDS = [
  'bpm', 'tempo', 'crescendo', 'reverb', 'delay pedal', 'arpeggio', 'sub-bass',
  '808', 'synth', 'synths', 'guitar solo', 'drum machine', 'fade out', 'fade in',
  'half-time', 'four on the floor', 'sidechain', 'filter sweep',
];

/**
 * Every §3d rule, as a list the inspector can render.
 * @returns {{id, level: 'error'|'warn', title, detail, line: ?number, fix: ?string}[]}
 */
function checkRules(text, allowed, targetSeconds) {
  const issues = [];
  const lines = text.split('\n');
  const trimmed = text.trim();
  if (!trimmed) return issues;

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
        title: `${match[2]} is not one of the nine tags`,
        detail: guess
          ? `MiniMax Music 3 only understands ${allowed.join(' ')}. Closest match: ${guess}.`
          : `MiniMax Music 3 only understands ${allowed.join(' ')}.`,
        line: index,
        fix: guess ? { label: `Use ${guess}`, kind: 'retag', line: index, tag: guess } : null,
      });
    } else if (match[2] !== tag) {
      issues.push({
        id: `case:${index}`,
        level: 'warn',
        title: `${match[2]} should be lowercase`,
        detail: 'Tags are matched literally — write them exactly as [verse], [chorus] and so on.',
        line: index,
        fix: { label: 'Lowercase it', kind: 'retag', line: index, tag },
      });
    }

    if (trailing) {
      issues.push({
        id: `trailing:${index}`,
        level: 'error',
        title: `Words share a line with ${match[2]}`,
        detail: `“${trailing}” is dropped: a section tag must sit alone on its own line.`,
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
      title: 'The song starts before any section tag',
      detail: 'Lines above the first tag have no section. Open with [intro] or [verse].',
      line: firstContent,
      fix: { label: 'Add [verse] above', kind: 'prepend', line: firstContent, tag: '[verse]' },
    });
  }

  for (const section of parseSections(text, allowed)) {
    if ((section.tag === '[instrumental]' || section.tag === '[solo]') && section.words > 0) {
      issues.push({
        id: `instrumental:${section.line}`,
        level: 'error',
        title: `${section.tag} contains ${section.words} word${section.words === 1 ? '' : 's'}`,
        detail: 'Instrumental and solo passages carry no lyrics — move the words into a sung section.',
        line: section.line,
        fix: null,
      });
    }
  }

  if (text.length > 3500) {
    issues.push({
      id: 'length',
      level: 'error',
      title: `${text.length.toLocaleString()} characters — the backend keeps the first 3,500`,
      detail: 'Everything past 3,500 characters is cut before it reaches the model.',
      line: null,
      fix: { label: 'Trim to 3,500', kind: 'trim' },
    });
  }

  const words = sungWords(text);
  if (words) {
    const fast = words / WORDS_PER_SEC.fast;
    const slow = words / WORDS_PER_SEC.slow;
    if (slow < targetSeconds * 0.6) {
      issues.push({
        id: 'short',
        level: 'warn',
        title: `≈ ${clock(fast)}–${clock(slow)} of sung words against a ${clock(targetSeconds)} target`,
        detail: 'At 12–16 words per 10 seconds that is well short. Add sections, or aim the generation at a shorter duration.',
        line: null,
        fix: null,
      });
    } else if (fast > targetSeconds * 1.25) {
      issues.push({
        id: 'long',
        level: 'warn',
        title: `≈ ${clock(fast)}–${clock(slow)} of sung words against a ${clock(targetSeconds)} target`,
        detail: 'More words than the target comfortably carries at 12–16 words per 10 seconds. Cut lines or raise the duration.',
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
      title: `A ${target.band} song wants ${missing.join(', ')}`,
      detail: `At this length MiniMax Music 3 expects ${target.shape}.`,
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
      title: `Possible musical direction in the lyrics — ${found.slice(0, 3).join(', ')}`,
      detail: 'Tempo, instruments and dynamics belong in the Arrangement caption, never in sung lines.',
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
  const alias = { prechorus: '[pre-chorus]', postchorus: '[post-chorus]', refrain: '[chorus]', hook: '[chorus]', intro: '[intro]', ending: '[outro]', break: '[instrumental]' };
  if (alias[bare]) return alias[bare];
  return allowed.find((t) => bare && t.replace(/[^a-z]/g, '').startsWith(bare.slice(0, 4))) || null;
}

/* ========================================================================== *
 * Editor highlighting — tags in brand colour, dropped words struck through
 * ========================================================================== */

function highlight(text, allowed) {
  return `${text.split('\n').map((raw) => {
    const match = TAG_LINE.exec(raw);
    if (!match) return escapeHtml(raw) || '&nbsp;';
    const [, indent, tag, rest] = match;
    const ok = allowed.includes(tag.toLowerCase());
    const tagSpan = `<span class="${ok ? 'hl-tag' : 'hl-tag hl-tag--bad'}">${escapeHtml(tag)}</span>`;
    const restSpan = rest.trim() ? `<span class="hl-dropped">${escapeHtml(rest)}</span>` : escapeHtml(rest);
    return `${escapeHtml(indent)}${tagSpan}${restSpan}`;
  }).join('\n')}\n`;
}

/* ========================================================================== *
 * Mount
 * ========================================================================== */

const DRAFT_KEY = 'lyrics.draft';
const HANDOFF_KEY = 'handoff';

const DURATIONS = [30, 60, 90, 120, 180, 240, 300];

const REWRITE_PRESETS = [
  'Tighter — fewer words, same meaning',
  'Swap the abstractions for concrete images',
  'Make the chorus bigger and easier to sing',
  'Darker, more restrained',
  'Add a bridge that turns the story',
];

export async function mount(root, ctx) {
  const { api } = ctx;
  const TAGS = api.SECTION_TAGS;

  const saved = ctx.storage.get(DRAFT_KEY, null) || {};
  const state = {
    title: String(ctx.route.query.title || saved.title || ''),
    text: String(saved.text || ''),
    idea: String(ctx.route.query.idea || saved.idea || ''),
    target: Number(saved.target) || 120,
    styleTags: String(saved.styleTags || ''),
    provider: saved.provider || '',
    model: saved.model || '',
    busy: null,        // 'write' | 'rewrite'
    undo: null,        // one-level undo of the last Codex rewrite
    health: null,
  };

  /* ---------------------------------------------------------------- shell */

  const page = el('div', { class: 'screen-lyrics' });

  /* ------------------------------------------------------------- topbar -- */

  const providerBadge = el('span', { class: 'badge lyr-provider', title: 'POST /api/lyrics' }, [
    el('span', { class: 'lyr-provider__dot' }),
    el('span', { class: 'lyr-provider__text', text: 'checking…' }),
  ]);
  const newDraftBtn = el('button', {
    class: 'btn btn--sm btn--ghost',
    type: 'button',
    onclick: () => {
      const previous = {
        title: state.title, text: doc.value, idea: ideaInput.value, styleTags: state.styleTags,
      };
      const restore = () => {
        state.title = previous.title;
        state.idea = previous.idea;
        state.styleTags = previous.styleTags;
        titleInput.value = previous.title;
        ideaInput.value = previous.idea;
        doc.value = previous.text;
        renderAll(); renderStyleTags(null); persist();
      };

      state.title = ''; state.idea = ''; state.styleTags = ''; state.undo = null;
      titleInput.value = ''; ideaInput.value = ''; doc.value = '';
      undoBtn.hidden = true;
      renderAll();
      renderStyleTags(null);
      persist();
      ideaInput.focus();

      if (previous.text.trim() || previous.title.trim() || previous.idea.trim()) {
        ctx.toast('Title, idea and lyrics cleared.', {
          kind: 'info', title: 'New draft', timeout: 12000,
          action: { label: 'Undo', onClick: restore },
        });
      }
    },
  }, [ctx.icon('plus'), 'New draft']);
  ctx.headerSlot.append(providerBadge, newDraftBtn);

  /* -------------------------------------------------------------- editor -- */

  const titleInput = el('input', {
    class: 'lyr-title', type: 'text', placeholder: 'Untitled song',
    maxlength: '120', 'aria-label': 'Song title', value: state.title,
    oninput: () => { state.title = titleInput.value; persist(); },
  });

  const charCount = el('span', { class: 'lyr-count mono' });

  const tagbar = el('div', { class: 'lyr-tagbar', role: 'group', 'aria-label': 'Insert a section tag' },
    TAGS.map((tag) => el('button', {
      class: 'chip chip--mono lyr-tagchip', type: 'button', text: tag,
      title: `Insert ${tag} on its own line`,
      onclick: () => insertTag(tag),
    })));

  const highlightLayer = el('pre', { class: 'lyr-doc__hl', 'aria-hidden': 'true' });
  const doc = el('textarea', {
    class: 'lyr-doc__ta',
    spellcheck: 'true',
    placeholder: '[verse]\nWrite here, or let Codex start it for you.\n\n[chorus]\nOne tag to a line — words on a tag line are dropped.',
    'aria-label': 'Lyrics',
  });
  doc.value = state.text;

  const docWrap = el('div', { class: 'lyr-doc' }, [highlightLayer, doc]);

  const statWords = el('span', { class: 'lyr-stat' });
  const statLength = el('span', { class: 'lyr-stat' });
  const statSections = el('span', { class: 'lyr-stat' });
  const statCheck = el('button', {
    class: 'badge lyr-statcheck', type: 'button', hidden: true,
    title: 'Show the rule check',
    onclick: () => {
      checkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      checkPanel.classList.remove('is-flash');
      void checkPanel.offsetWidth;
      checkPanel.classList.add('is-flash');
    },
  });

  const copyBtn = el('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: () => copy(state.text, 'Lyrics copied.'),
  }, [ctx.icon('copy'), 'Copy']);

  const toStudioBtn = el('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: () => handoff('studio', 'Studio'),
  }, [ctx.icon('studio'), 'Send to Studio']);

  const toCreateBtn = el('button', {
    class: 'btn btn--sm btn--primary', type: 'button',
    onclick: () => handoff('create', 'Create'),
  }, [ctx.icon('create'), 'Send to Create']);

  const editor = el('section', { class: 'lyr-editor' }, [
    el('header', { class: 'lyr-editor__head' }, [
      titleInput,
      el('span', { class: 'spacer' }),
      charCount,
    ]),
    tagbar,
    docWrap,
    el('footer', { class: 'lyr-editor__foot' }, [
      el('div', { class: 'lyr-stats' }, [statWords, statLength, statSections, statCheck]),
      el('span', { class: 'spacer' }),
      copyBtn, toStudioBtn, toCreateBtn,
    ]),
  ]);

  /* ----------------------------------------------------------- inspector -- */

  /* 1. Write with Codex ---------------------------------------------------- */

  const ideaInput = el('textarea', {
    class: 'textarea lyr-idea',
    rows: '3',
    placeholder: 'A late-night drive home after saying the wrong thing. Regret, headlights, one honest line in the chorus.',
    'aria-label': 'What the song is about',
  });
  ideaInput.value = state.idea;
  ideaInput.addEventListener('input', () => { state.idea = ideaInput.value; persist(); syncWriteButton(); });
  ideaInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); write(); }
  });

  const targetSelect = el('select', { class: 'select', 'aria-label': 'Target length' },
    DURATIONS.map((sec) => el('option', { value: String(sec), text: `${clock(sec)} target`, selected: sec === state.target })));
  targetSelect.value = String(state.target);
  targetSelect.addEventListener('change', () => {
    state.target = Number(targetSelect.value) || 120;
    persist();
    renderInspector();
  });

  const writeBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => write() }, [
    ctx.icon('wand'),
    el('span', { class: 'lyr-btn__label', text: 'Write the lyrics' }),
  ]);
  const writeHint = el('p', { class: 'hint' });
  const writeStatus = el('div', { class: 'lyr-run', hidden: true });
  const styleOut = el('div', { class: 'lyr-style', hidden: true });

  const writePanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Write with Codex' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'lyr-kbd mono', text: '⌘↵' }),
    ]),
    el('div', { class: 'panel__body stack' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'The idea' }),
        ideaInput,
      ]),
      el('div', { class: 'lyr-writerow' }, [targetSelect, writeBtn]),
      writeHint,
      writeStatus,
      styleOut,
    ]),
  ]);

  /* 2. Rewrite ------------------------------------------------------------- */

  const selectionLabel = el('span', { class: 'lyr-selection mono', text: 'whole song' });
  const instructionInput = el('input', {
    class: 'input', type: 'text',
    placeholder: 'What should change?',
    'aria-label': 'Rewrite instruction',
    oninput: () => syncRewriteButton(),
  });
  instructionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); rewrite(); }
  });

  const presetRow = el('div', { class: 'lyr-presets' }, REWRITE_PRESETS.map((preset) => el('button', {
    class: 'chip', type: 'button', text: preset.split(' — ')[0],
    title: preset,
    onclick: () => { instructionInput.value = preset; syncRewriteButton(); instructionInput.focus(); },
  })));

  const rewriteBtn = el('button', { class: 'btn btn--block', type: 'button', onclick: () => rewrite() }, [
    ctx.icon('refresh'),
    el('span', { class: 'lyr-btn__label', text: 'Rewrite selection' }),
  ]);
  const undoBtn = el('button', {
    class: 'btn btn--sm lyr-undo', type: 'button', hidden: true,
    onclick: () => {
      if (state.undo === null) return;
      setDocValue(state.undo);
      state.undo = null;
      undoBtn.hidden = true;
      ctx.toast('Reverted to the text before the rewrite.', { kind: 'info' });
    },
  }, 'Undo rewrite');
  const rewriteStatus = el('div', { class: 'lyr-run', hidden: true });

  const rewritePanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Rewrite' }),
      el('span', { class: 'spacer' }),
      selectionLabel,
    ]),
    el('div', { class: 'panel__body stack' }, [
      el('p', { class: 'hint', text: 'Select lines in the editor to rewrite just those. With nothing selected the whole song is sent.' }),
      instructionInput,
      presetRow,
      rewriteBtn,
      undoBtn,
      rewriteStatus,
    ]),
  ]);

  /* 3. Structure ----------------------------------------------------------- */

  const outline = el('div', { class: 'lyr-outline' });
  const structurePanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Structure' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'lyr-estimate mono' }),
    ]),
    el('div', { class: 'panel__body' }, [outline]),
  ]);
  const estimateOut = structurePanel.querySelector('.lyr-estimate');

  /* 4. Rule check ---------------------------------------------------------- */

  const checkBody = el('div', { class: 'lyr-checks' });
  const checkBadge = el('span', { class: 'badge' });
  const checkPanel = el('section', { class: 'panel lyr-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Rule check' }),
      el('span', { class: 'spacer' }),
      checkBadge,
    ]),
    el('div', { class: 'panel__body' }, [checkBody]),
  ]);

  const inspector = el('aside', { class: 'lyr-inspector' }, [
    writePanel, rewritePanel, structurePanel, checkPanel,
  ]);

  page.append(editor, inspector);
  root.append(page);

  /* ========================================================================
   * Behaviour
   * ===================================================================== */

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      ctx.storage.set(DRAFT_KEY, {
        title: state.title, text: state.text, idea: state.idea,
        target: state.target, styleTags: state.styleTags,
        provider: state.provider, model: state.model, updatedAt: Date.now(),
      });
    }, 400);
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

  /** Write through execCommand so the browser's own undo stack keeps working. */
  function insertAtCursor(textToInsert) {
    doc.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, textToInsert); } catch { ok = false; }
    if (!ok) {
      const start = doc.selectionStart;
      const end = doc.selectionEnd;
      doc.setRangeText(textToInsert, start, end, 'end');
    }
    onDocInput();
  }

  function setDocValue(next) {
    doc.value = next;
    onDocInput();
  }

  function insertTag(tag) {
    const before = doc.value.slice(0, doc.selectionStart);
    const after = doc.value.slice(doc.selectionEnd);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const trail = after.startsWith('\n') || after === '' ? '\n' : '\n';
    insertAtCursor(`${lead}${tag}${trail}`);
  }

  function lineOffsets(index) {
    const lines = doc.value.split('\n');
    let start = 0;
    for (let i = 0; i < index && i < lines.length; i += 1) start += lines[i].length + 1;
    return { start, end: start + (lines[index] ?? '').length };
  }

  function focusLine(index) {
    const { start, end } = lineOffsets(index);
    doc.focus();
    doc.setSelectionRange(start, end);
    // Put the line roughly in the middle of the viewport.
    const lineHeight = parseFloat(getComputedStyle(doc).lineHeight) || 22;
    doc.scrollTop = Math.max(0, (index * lineHeight) - (doc.clientHeight / 2));
    syncScroll();
    updateSelectionLabel();
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
      const cut = doc.value.slice(0, 3500);
      const lastBreak = cut.lastIndexOf('\n');
      setDocValue(lastBreak > 3000 ? cut.slice(0, lastBreak) : cut);
    }
    persist();
  }

  function handoff(to, label) {
    const lyrics = state.text.trim();
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
    ctx.toast(
      `${lyrics.length.toLocaleString()} characters of lyrics${payload.title ? ` for “${payload.title}”` : ''} are stored under maxmusic:handoff for ${label} to pick up.`,
      { kind: 'success', title: `Sent to ${label}` },
    );
    ctx.navigate(to);
  }

  /* ------------------------------------------------------------ rendering */

  function renderEditor() {
    highlightLayer.innerHTML = highlight(doc.value, TAGS);
    syncScroll();

    const chars = doc.value.length;
    charCount.textContent = `${chars.toLocaleString()} / 3,500`;
    charCount.classList.toggle('is-over', chars > 3500);

    const words = sungWords(doc.value);
    const sections = parseSections(doc.value, TAGS).filter((s) => s.tag);
    statWords.textContent = `${words.toLocaleString()} sung word${words === 1 ? '' : 's'}`;
    statLength.textContent = words
      ? `≈ ${clock(words / WORDS_PER_SEC.fast)}–${clock(words / WORDS_PER_SEC.slow)}`
      : '≈ 0:00';
    statSections.textContent = `${sections.length} section${sections.length === 1 ? '' : 's'}`;

    const empty = !doc.value.trim();
    copyBtn.disabled = empty;
    toStudioBtn.disabled = empty;
    toCreateBtn.disabled = empty;
  }

  function renderOutline() {
    const sections = parseSections(doc.value, TAGS);
    outline.replaceChildren();

    const words = sungWords(doc.value);
    estimateOut.textContent = words
      ? `${clock(words / WORDS_PER_SEC.fast)}–${clock(words / WORDS_PER_SEC.slow)} of ${clock(state.target)}`
      : `0:00 of ${clock(state.target)}`;

    if (!sections.length) {
      outline.append(el('p', { class: 'hint', text: 'No sections yet. Insert a tag from the row above the editor, or let Codex write the first draft.' }));
      return;
    }

    for (const section of sections) {
      const seconds = section.words / WORDS_PER_SEC.slow;
      const row = el('button', {
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
        el('span', { class: 'lyr-outline__meta mono', text: section.words ? `${section.words} w` : '—' }),
      ]);
      outline.append(row);
    }

    const target = structureTarget(state.target);
    outline.append(el('p', {
      class: 'hint lyr-outline__hint',
      text: `${target.band}: ${target.shape}.`,
    }));
  }

  function renderChecks() {
    const issues = checkRules(doc.value, TAGS, state.target);
    checkBody.replaceChildren();

    const errors = issues.filter((i) => i.level === 'error').length;
    const warnings = issues.length - errors;

    const tone = errors ? 'badge--danger' : warnings ? 'badge--warn' : 'badge--ok';
    const summary = errors
      ? `${errors} to fix`
      : warnings ? `${warnings} to look at` : 'clean';
    checkBadge.className = `badge ${tone}`;
    checkBadge.textContent = summary;
    statCheck.hidden = false;
    statCheck.className = `badge lyr-statcheck ${tone}`;
    statCheck.textContent = summary;

    if (!doc.value.trim()) {
      checkBadge.className = 'badge';
      checkBadge.textContent = 'empty';
      statCheck.hidden = true;
      checkBody.append(el('p', { class: 'hint', text: 'The nine tags, one per line, no production notes, 12–16 sung words per 10 seconds. Checked live as you type.' }));
      return;
    }

    if (!issues.length) {
      checkBody.append(el('div', { class: 'lyr-clean' }, [
        el('span', { class: 'lyr-clean__icon', html: ctx.iconMarkup('check') }),
        el('div', {}, [
          el('p', { class: 'lyr-clean__title', text: 'Ready for MiniMax Music 3' }),
          el('p', { class: 'hint', text: 'Tags, structure and length all match SPEC §3d.' }),
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
      checkBody.append(el('div', { class: `lyr-check lyr-check--${issue.level}` }, [
        el('span', { class: 'lyr-check__icon', html: ctx.iconMarkup(issue.level === 'error' ? 'alert' : 'info') }),
        el('div', { class: 'lyr-check__body' }, [
          el('p', { class: 'lyr-check__title', text: issue.title }),
          el('p', { class: 'lyr-check__detail', text: issue.detail }),
          actions.length ? el('div', { class: 'lyr-check__actions' }, actions) : null,
        ]),
      ]));
    }
  }

  function renderInspector() {
    renderOutline();
    renderChecks();
    syncWriteButton();
    syncRewriteButton();
  }

  function renderAll() {
    state.text = doc.value;
    renderEditor();
    renderInspector();
  }

  function syncScroll() {
    highlightLayer.scrollTop = doc.scrollTop;
    highlightLayer.scrollLeft = doc.scrollLeft;
  }

  function updateSelectionLabel() {
    const start = doc.selectionStart;
    const end = doc.selectionEnd;
    if (start === end) {
      selectionLabel.textContent = 'whole song';
      return;
    }
    const slice = doc.value.slice(start, end);
    const lines = slice.split('\n').length;
    selectionLabel.textContent = `${lines} line${lines === 1 ? '' : 's'} · ${sungWords(slice)} words`;
  }

  function onDocInput() {
    renderAll();
    persist();
  }

  doc.addEventListener('input', onDocInput);
  doc.addEventListener('scroll', syncScroll);
  doc.addEventListener('select', updateSelectionLabel);
  doc.addEventListener('keyup', updateSelectionLabel);
  doc.addEventListener('mouseup', updateSelectionLabel);
  doc.addEventListener('blur', updateSelectionLabel);

  /* --------------------------------------------------------- availability */

  function lyricsAvailable() {
    return Boolean(state.health && state.health.lyricsEnabled);
  }

  function unavailableReason() {
    const h = state.health;
    if (!h) return 'Checking /api/health…';
    if (h.status === 'offline') return h.message;
    return `/api/health reports lyrics: "${h.lyricsProvider}". The backend cannot write lyrics — set LOCAL_CODEX_BIN and LOCAL_CODEX_HOME to a signed-in local Codex runtime and restart it. You can still type and check lyrics here.`;
  }

  function syncWriteButton() {
    const available = lyricsAvailable();
    const hasIdea = ideaInput.value.trim().length > 0;
    writeBtn.disabled = Boolean(state.busy) || !available || !hasIdea;
    if (!available) {
      writeHint.className = 'hint hint--warn';
      writeHint.textContent = unavailableReason();
      writeBtn.title = unavailableReason();
    } else if (!hasIdea) {
      writeHint.className = 'hint';
      writeHint.textContent = 'Describe the song in a line or two. Codex returns a title, style tags and a full tagged lyric.';
      writeBtn.title = 'Describe the song first';
    } else {
      writeHint.className = 'hint';
      writeHint.textContent = doc.value.trim()
        ? 'This replaces the lyrics in the editor. The previous text stays one undo away.'
        : `POST /api/lyrics · mode write_full_song · ${state.provider || state.health?.lyricsProvider || 'local codex'}`;
      writeBtn.removeAttribute('title');
    }
  }

  function syncRewriteButton() {
    const available = lyricsAvailable();
    const hasText = doc.value.trim().length > 0;
    const hasInstruction = instructionInput.value.trim().length > 0;
    instructionInput.disabled = !available;
    for (const chip of presetRow.children) chip.disabled = !available;
    rewriteBtn.disabled = Boolean(state.busy) || !available || !hasText || !hasInstruction;
    rewriteBtn.title = !available
      ? unavailableReason()
      : !hasText ? 'Write or paste some lyrics first'
        : !hasInstruction ? 'Say what should change' : 'POST /api/lyrics · mode edit';
  }

  /* ------------------------------------------------------------- requests */

  let inFlight = null;
  let tick = null;

  function startRun(node, label) {
    const started = Date.now();
    node.hidden = false;
    node.replaceChildren(
      el('span', { class: 'brandline lyr-run__line' }),
      el('div', { class: 'lyr-run__row' }, [
        ctx.icon('spinner', 'icon spinner'),
        el('span', { class: 'lyr-run__label', text: label }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'lyr-run__time mono', text: '0:00' }),
        el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', text: 'Cancel',
          onclick: () => inFlight?.abort(new DOMException('Cancelled', 'AbortError')),
        }),
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

  async function write() {
    if (state.busy || !lyricsAvailable() || !ideaInput.value.trim()) return;
    state.busy = 'write';
    syncWriteButton(); syncRewriteButton();
    startRun(writeStatus, 'Codex is writing…');
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
      state.undo = doc.value;
      undoBtn.hidden = false;
      setDocValue(String(result.lyrics || ''));
      if (result.song_title && !state.title.trim()) {
        state.title = result.song_title;
        titleInput.value = result.song_title;
      }
      state.styleTags = String(result.style_tags || '');
      state.provider = result.provider || state.health?.lyricsProvider || '';
      state.model = result.model || '';
      renderStyleTags(result);
      persist();
      ctx.toast(
        `${result.song_title || 'Lyrics'} — ${String(result.lyrics || '').length.toLocaleString()} characters from ${result.provider || 'the local provider'}.`,
        { kind: 'success', title: 'Lyrics written' },
      );
    } catch (err) {
      if (err?.name !== 'AbortError') {
        ctx.toast(api.errorText(err), { kind: 'error', title: 'POST /api/lyrics failed' });
      }
    } finally {
      inFlight = null;
      state.busy = null;
      endRun(writeStatus);
      syncWriteButton(); syncRewriteButton();
    }
  }

  async function rewrite() {
    if (state.busy || !lyricsAvailable()) return;
    const instruction = instructionInput.value.trim();
    if (!instruction || !doc.value.trim()) return;

    const start = doc.selectionStart;
    const end = doc.selectionEnd;
    const partial = end > start;
    const source = partial ? doc.value.slice(start, end) : doc.value;

    state.busy = 'rewrite';
    syncWriteButton(); syncRewriteButton();
    startRun(rewriteStatus, partial ? 'Rewriting the selection…' : 'Rewriting the song…');
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
      if (!next) throw new api.ApiError('The local provider returned no lyrics.', { endpoint: '/api/lyrics' });

      state.undo = doc.value;
      undoBtn.hidden = false;
      if (partial) {
        doc.focus();
        doc.setSelectionRange(start, end);
        insertAtCursor(next);
      } else {
        setDocValue(next);
      }
      if (result.style_tags) state.styleTags = String(result.style_tags);
      renderStyleTags(result);
      persist();
      ctx.toast(partial ? 'Selection rewritten.' : 'Song rewritten.', { kind: 'success' });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        ctx.toast(api.errorText(err), { kind: 'error', title: 'POST /api/lyrics failed' });
      }
    } finally {
      inFlight = null;
      state.busy = null;
      endRun(rewriteStatus);
      syncWriteButton(); syncRewriteButton();
    }
  }

  function renderStyleTags(result) {
    const tags = String(result?.style_tags || state.styleTags || '').trim();
    if (!tags) { styleOut.hidden = true; return; }
    styleOut.hidden = false;
    styleOut.replaceChildren(
      el('div', { class: 'lyr-style__head' }, [
        el('span', { class: 'label', text: 'Style tags from Codex' }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'iconbtn', type: 'button', title: 'Copy style tags',
          'aria-label': 'Copy style tags',
          onclick: () => copy(tags, 'Style tags copied.'),
          html: ctx.iconMarkup('copy'),
        }),
      ]),
      el('p', { class: 'lyr-style__text', text: tags }),
      el('p', {
        class: 'hint',
        text: `${state.provider || 'local provider'}${state.model ? ` · ${state.model}` : ''} — these travel with “Send to Studio” but are not a generation parameter on their own.`,
      }),
    );
  }

  /* ---------------------------------------------------------------- health */

  ctx.onHealth((h) => {
    state.health = h;
    const dot = providerBadge.querySelector('.lyr-provider__dot');
    const text = providerBadge.querySelector('.lyr-provider__text');
    providerBadge.className = `badge lyr-provider ${h.lyricsEnabled ? 'badge--ok' : 'badge--warn'}`;
    text.textContent = h.lyricsEnabled ? h.lyricsProvider : `lyrics: ${h.lyricsProvider}`;
    providerBadge.title = h.lyricsEnabled
      ? `POST /api/lyrics → ${h.lyricsProvider}${state.model ? ` · ${state.model}` : ''}`
      : unavailableReason();
    dot.classList.toggle('is-off', !h.lyricsEnabled);
    syncWriteButton();
    syncRewriteButton();
  });

  /* ------------------------------------------------------------ first paint */

  renderAll();
  renderStyleTags(null);
  updateSelectionLabel();
  if (!state.text.trim() && !state.idea.trim()) ideaInput.focus();

  return () => {
    clearTimeout(saveTimer);
    clearInterval(tick);
    inFlight?.abort(new DOMException('Screen left', 'AbortError'));
    ctx.storage.set(DRAFT_KEY, {
      title: state.title, text: doc.value, idea: ideaInput.value,
      target: state.target, styleTags: state.styleTags,
      provider: state.provider, model: state.model, updatedAt: Date.now(),
    });
  };
}
