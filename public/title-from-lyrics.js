/** Derive a display title from lyrics (not the first style tag). */

function cleanLine(line) {
  return line
    .replace(/\[.*?\]/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^\w\s''-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(phrase) {
  return phrase
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length <= 2 && !/^(I|A|An|The|Of|In|On|At|To)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function normTitle(t) {
  return (t || '').trim().toLowerCase();
}

function candidateFromLine(line) {
  const cleaned = cleanLine(line);
  if (!cleaned) return null;
  const words = cleaned.split(' ').filter((w) => w.length > 0);
  if (words.length < 2) return null;
  if (words.every((w) => w.length <= 2)) return null;
  const phrase = words.slice(0, 7).join(' ');
  if (phrase.length < 6) return null;
  return toTitleCase(phrase).slice(0, 50);
}

function linesFromLyrics(lyrics) {
  return lyrics.split('\n').map((l) => l.trim()).filter(Boolean);
}

function pushCandidate(list, seen, candidate) {
  if (!candidate) return;
  const key = normTitle(candidate);
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

function firstLineAfterSection(lines, sectionPattern) {
  const idx = lines.findIndex((l) => sectionPattern.test(l));
  if (idx < 0) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) break;
    const c = candidateFromLine(lines[i]);
    if (c) return c;
  }
  return null;
}

/** Every singable line in each matching section (verse 2 can title B). */
function allLinesAfterSections(lines, sectionPattern) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!sectionPattern.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\[/.test(lines[j])) break;
      const c = candidateFromLine(lines[j]);
      if (c) out.push(c);
    }
  }
  return out;
}

function repeatedPhrasesByCount(lines, minCount = 2) {
  const counts = new Map();
  for (const line of lines) {
    if (/^\[/.test(line)) continue;
    const c = candidateFromLine(line);
    if (!c) continue;
    const key = c.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => toTitleCase(k).slice(0, 50));
}

function promptTitleCandidates(prompt, mode) {
  if (!prompt?.trim()) {
    return mode === 'instrumental' ? ['Untitled instrumental'] : ['Untitled'];
  }
  const out = [];
  const seen = new Set();
  for (const part of prompt.split(/[,;|]/)) {
    const chunk = part.trim();
    if (chunk.length < 4) continue;
    const short = chunk.split(/\s+/).slice(0, 7).join(' ');
    const title = toTitleCase(short.length >= 4 ? short : chunk).slice(0, 50);
    pushCandidate(out, seen, title);
  }
  const first = prompt.split(/[,.!?\n]/)[0].trim();
  const whole = (first.length >= 4 ? first : prompt.trim()).slice(0, 50);
  pushCandidate(out, seen, whole);
  return out;
}

function fallbackFromPrompt(prompt, mode) {
  return promptTitleCandidates(prompt, mode)[0] || (mode === 'instrumental' ? 'Untitled instrumental' : 'Untitled');
}

/**
 * Ordered unique title ideas (chorus, hooks, verses, lines, then prompt chunks).
 * @param {string} lyrics
 * @param {{ apiTitle?: string, prompt?: string, mode?: string, includeApiTitle?: boolean }} [opts]
 */
export function collectTitleCandidates(lyrics, opts = {}) {
  const candidates = [];
  const seen = new Set();
  const includeApi = opts.includeApiTitle !== false;
  const apiTitle = (opts.apiTitle || '').trim();

  if (includeApi && apiTitle) pushCandidate(candidates, seen, apiTitle.slice(0, 50));

  const text = (lyrics || '').trim();
  if (!text) {
    for (const t of promptTitleCandidates(opts.prompt, opts.mode)) {
      pushCandidate(candidates, seen, t);
    }
    return candidates;
  }

  const lines = linesFromLyrics(text);

  for (const c of allLinesAfterSections(lines, /^\[chorus/i)) pushCandidate(candidates, seen, c);
  for (const c of allLinesAfterSections(lines, /^\[hook/i)) pushCandidate(candidates, seen, c);

  for (const c of repeatedPhrasesByCount(lines, 2)) pushCandidate(candidates, seen, c);

  for (const c of allLinesAfterSections(lines, /^\[verse/i)) pushCandidate(candidates, seen, c);
  for (const c of allLinesAfterSections(lines, /^\[intro/i)) pushCandidate(candidates, seen, c);
  for (const c of allLinesAfterSections(lines, /^\[bridge/i)) pushCandidate(candidates, seen, c);
  for (const c of allLinesAfterSections(lines, /^\[pre-?chorus/i)) pushCandidate(candidates, seen, c);

  const fromChorus =
    firstLineAfterSection(lines, /^\[chorus/i) ||
    firstLineAfterSection(lines, /^\[hook/i);
  pushCandidate(candidates, seen, fromChorus);

  const repeated = repeatedPhrasesByCount(lines, 2)[0] || null;
  pushCandidate(candidates, seen, repeated);

  const fromVerse =
    firstLineAfterSection(lines, /^\[verse/i) ||
    firstLineAfterSection(lines, /^\[intro/i);
  pushCandidate(candidates, seen, fromVerse);

  for (const line of lines) {
    if (/^\[/.test(line)) continue;
    if (/^\([^)]{0,18}\)$/i.test(line)) continue;
    pushCandidate(candidates, seen, candidateFromLine(line));
  }

  for (const t of promptTitleCandidates(opts.prompt, opts.mode)) {
    pushCandidate(candidates, seen, t);
  }

  return candidates;
}

/**
 * @param {string} lyrics
 * @param {{ apiTitle?: string, prompt?: string, mode?: string, excludeTitle?: string, index?: number }} [opts]
 */
export function titleFromLyrics(lyrics, opts = {}) {
  const exclude = normTitle(opts.excludeTitle);
  const list = collectTitleCandidates(lyrics, opts).filter((c) => normTitle(c) !== exclude);
  const idx = opts.index ?? 0;
  if (list[idx]) return list[idx];
  if (list[0]) return list[0];
  return fallbackFromPrompt(opts.prompt, opts.mode);
}

/**
 * Two distinct titles for dual A/B (second pass skips the first pick).
 * @param {string} lyrics
 * @param {{ apiTitle?: string, prompt?: string, mode?: string }} [opts]
 */
export function dualTrackTitles(lyrics, opts = {}) {
  const titleA = titleFromLyrics(lyrics, opts);
  let titleB = titleFromLyrics(lyrics, { ...opts, excludeTitle: titleA });

  if (normTitle(titleB) === normTitle(titleA)) {
    const lyricOnly = collectTitleCandidates(lyrics, { ...opts, includeApiTitle: false });
    titleB = lyricOnly.find((c) => normTitle(c) !== normTitle(titleA)) || titleB;
  }

  if (normTitle(titleB) === normTitle(titleA)) {
    const prompts = promptTitleCandidates(opts.prompt, opts.mode);
    titleB = prompts.find((c) => normTitle(c) !== normTitle(titleA)) || titleB;
  }

  if (normTitle(titleB) === normTitle(titleA) && titleA.length <= 44) {
    titleB = `${titleA} · Alt`;
  }

  return { titleA, titleB };
}