/**
 * Pacing — making the words and the recording the same size.
 *
 * MiniMax sings whatever sheet it is handed at its own natural rate and never
 * negotiates: hand it more words than the running time can hold and the song
 * is cut off in the middle of a line; hand it too few and the last minute is
 * the final hook looped until the clock runs out. Both were reported from real
 * songs, and both are the same bug — nobody was making the two numbers agree.
 * The studio's lyric writer is length-blind on its own: asked for one minute it
 * returns the same four hundred words it returns for five.
 *
 * What six measured takes support is one number — how many sung words a second
 * of running time can carry:
 *
 *     running time  ≈  sung words / 1.65
 *
 * and not much more precision than that. How fast the singer phrases is NOT
 * predictable: two takes of the same sheet, at the same length, from the same
 * brief, sang 1.39 and 2.28 words a second. So this module aims for the
 * density that lands and lets the rest be the model's business.
 *
 * The writer is asked for the right size (`pacedPrompt`), but it is a writer,
 * not a calculator — one 3:00 request came back 40% long — so nothing
 * downstream trusts it. `planSong` is the guarantee.
 *
 * @module pacing
 */

/**
 * Sung words per second of TOTAL running time — the whole song, singing and
 * silence together.
 *
 * Not words-per-second-while-singing, which was the first thing tried and is
 * not a stable number: takes of the same sheet, at the same length, from the
 * same brief have sung anywhere from 1.56 to 2.32 words a second. That variance
 * belongs to the model and no arithmetic here can remove it.
 *
 * So the number is chosen against the SLOWEST singer seen, not the average.
 * Nine measured takes put the line between landing and being cut off at about
 * 1.75: sheets at 1.85, 1.77 and 2.30 were all truncated mid-phrase, and 1.71
 * only survived because that take happened to sing quickly. 1.5 sits clear of
 * it. The cost is that a fast take runs out of words early and plays out
 * instrumentally, which is a musical ending; the cost of being wrong the other
 * way is a song that stops in the middle of a line, which is not.
 */
export const DENSITY = { slow: 1.35, plain: 1.5, fast: 1.7 };

/**
 * The length promise, stated once for the whole application.
 *
 * MiniMax Music 3 decides for itself when a composition has resolved, so the
 * selected length can only ever be creative guidance — the app never trims a
 * finished song back to a number. Guidance still has to mean something, and a
 * quarter of the target either way (never less than fifteen seconds, which is
 * what keeps the shortest songs from being held to an impossible standard) is
 * the band the model, the backend, and the screens all speak in. Asking for
 * five minutes and being handed fifty seconds is not a song that ran short; it
 * is a different request, and the customer is told so.
 *
 * The worker holds the identical rule in `duration_ballpark()`.
 *
 * @param {number} seconds  the requested length
 * @returns {{low: number, high: number}} the inclusive band, in seconds
 */
export function durationBallpark(seconds) {
  const target = Math.max(0, Number(seconds) || 0);
  const slack = Math.max(15, target * 0.25);
  return { low: Math.max(0, target - slack), high: target + slack };
}

/** Whether a finished song answers the length that was asked for. */
export function inDurationBallpark(delivered, requested) {
  const { low, high } = durationBallpark(requested);
  const got = Number(delivered) || 0;
  return got >= low && got <= high;
}

/**
 * How far the running time may move from the length that was asked for.
 *
 * Barely upward, on purpose. Stretching the take was an early idea — keep every
 * word the writer wrote — and the songs disagreed with it: the two that landed
 * on their own wanted no extra time at all, and the take that was stretched to
 * hold an overlong sheet sang everything by 2:43 and then played to nobody for
 * a minute. Downward is where the room is: a thin sheet makes a shorter song,
 * which is how a five-minute request stops being four minutes of song and one
 * minute of the same line over and over.
 */
const STRETCH = { min: 0.75, max: 1.1 };

/** A tail longer than this gets an explicit play-out rather than a loop. */
const TAIL_MAX = 8;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 218 -> "3:38". */
export function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A ballad and a punk song do not carry the same number of words in a minute,
 * so the brief is read for tempo before the arithmetic. Only words that are
 * unambiguously about pace count; a genre alone is too weak a signal to move
 * the number.
 */
const FAST = /\b(fast|uptempo|up-tempo|driving|frantic|breakneck|relentless|energetic|punk|thrash|metal|hardcore|drum ?(and|&|n) ?bass|dnb|jungle|techno|rave|hyperpop|speed|rap|hip ?hop|trap|drill|patter|anthem|stadium)\b/i;
const SLOW = /\b(slow|slower|ballad|hymn|lullaby|elegy|dirge|funeral|ambient|drone|downtempo|meditative|mournful|sparse|hushed|gentle|tender|spacious|languid|half-?time)\b/i;

/** Words per second of running time this brief is likely to carry. */
export function rateFor(text) {
  const t = String(text || '');
  const fast = FAST.test(t);
  const slow = SLOW.test(t);
  if (fast === slow) return DENSITY.plain;      // both, or neither
  return fast ? DENSITY.fast : DENSITY.slow;
}

/** Sung words a recording of this length can hold. */
export function wordsFor(seconds, density = DENSITY.plain) {
  return Math.max(1, Math.round(Math.max(0, Number(seconds) || 0) * density));
}

/** Running time this many words want. */
export function secondsFor(words, density = DENSITY.plain) {
  return Math.max(0, Number(words) || 0) / density;
}

/**
 * Words that will actually be sung: everything except the `[section]` tags,
 * counting only tokens with a letter or a digit in them.
 *
 * @param {string} lyrics
 * @returns {number}
 */
export function countSungWords(lyrics) {
  return String(lyrics || '')
    .split('\n')
    .filter((line) => !/^\s*\[[^\]]*\]\s*$/.test(line))
    .join(' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .length;
}

/**
 * The lyric request, with the length written into it.
 *
 * The number rides in the idea text rather than a field, because that is the
 * part of the request every writer reads, and because the field the studio
 * already has for it is ignored.
 *
 * @param {string} idea       what the customer typed
 * @param {number} seconds    the running time being aimed at
 * @param {{firmer?: boolean, shorter?: boolean, was?: number}} [opts]  after a
 *        first draft came back too thin, or too long to fit
 * @returns {string}
 */
export function pacedPrompt(idea, seconds, opts = {}) {
  const secs = Math.max(1, Number(seconds) || 0);
  const rate = rateFor(idea);
  const target = wordsFor(secs, rate);
  const floor = Math.round(target * 0.85);
  const ceiling = Math.round(target * 1.15);

  let brief;
  if (opts.firmer) {
    brief = `LENGTH — the last draft came to ${opts.was} words, too few for a ${clock(secs)} recording: the singer ends up repeating the hook to fill the time. Write a longer lyric — at least ${floor} words, aiming for ${target} — by adding a verse or a bridge, not by repeating what is already there.`;
  } else if (opts.shorter) {
    brief = `LENGTH — the last draft came to ${opts.was} words, too many to sing inside a ${clock(secs)} recording, so the song would be cut off before its ending. Write a shorter lyric — no more than ${ceiling} words, aiming for ${target} — by cutting whole sections and tightening lines, while keeping the chorus and the ending.`;
  } else {
    brief = `LENGTH — this is a ${clock(secs)} recording, and every written word gets sung. The whole lyric must come to about ${target} words: count them, keep it between ${floor} and ${ceiling}, and use fewer sections rather than more. A longer lyric gets cut off mid-song. Finish with a real [outro] that lands, and make [outro] the FINAL section tag. If the words run out early, put a bare [instrumental] section BEFORE that terminal [outro], never after it. Do not repeat a hook merely to fill time.`;
  }

  return `${String(idea || '').trim()}\n\n${brief}`;
}

/* -------------------------------------------------------------------------- *
 * Fitting a written sheet
 * -------------------------------------------------------------------------- */

/** `[tag]` + its lines. A sheet with no tags at all is one block. */
function toBlocks(text) {
  const out = [];
  let cur = { tag: '', lines: [] };
  const has = (b) => b.tag || b.lines.some((l) => l.trim());
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      if (has(cur)) out.push(cur);
      cur = { tag: line.trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (has(cur)) out.push(cur);
  return out;
}

function fromBlocks(blocks) {
  return blocks
    .map((b) => [b.tag, b.lines.join('\n').replace(/^\n+|\n+$/g, '')].filter(Boolean).join('\n'))
    .join('\n\n')
    .trim();
}

const blockWords = (b) => countSungWords(b.lines.join('\n'));

/** What a block says, ignoring punctuation — so a repeated chorus is spotted. */
const blockKey = (b) => b.lines.join(' ').toLowerCase()
  .replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

/** `[chorus 2]` and `[chorus]` are the same kind of thing. */
const blockKind = (b) => String(b.tag || '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Make the ending unambiguous to Music 3 without changing a single lyric.
 *
 * A generated sheet previously ended `[outro] ... [instrumental]`. That asks
 * the model to finish the words, begin a new musical section, and then run out
 * of frames in that new section. Move the last existing outro to the terminal
 * position, or add a bare terminal outro when the writer supplied none. The
 * latter is a musical direction only; it invents no words.
 */
export function normalizeSongEnding(lyrics) {
  const blocks = toBlocks(lyrics);
  if (!blocks.length) return String(lyrics || '').trim();

  let outroIndex = -1;
  for (let index = 0; index < blocks.length; index += 1) {
    if (blockKind(blocks[index]) === 'outro') outroIndex = index;
  }
  if (outroIndex >= 0 && outroIndex !== blocks.length - 1) {
    const [outro] = blocks.splice(outroIndex, 1);
    blocks.push(outro);
  } else if (outroIndex < 0) {
    blocks.push({ tag: '[outro]', lines: [] });
  }
  return fromBlocks(blocks);
}

/** Add a wordless play-out immediately before, never after, the final outro. */
function addInstrumentalBeforeOutro(lyrics) {
  const blocks = toBlocks(normalizeSongEnding(lyrics));
  const outroIndex = blocks.length - 1;
  if (outroIndex < 0 || blockKind(blocks[outroIndex]) !== 'outro') return fromBlocks(blocks);
  if (outroIndex > 0 && blockKind(blocks[outroIndex - 1]) === 'instrumental') {
    return fromBlocks(blocks);
  }
  blocks.splice(outroIndex, 0, { tag: '[instrumental]', lines: [] });
  return fromBlocks(blocks);
}

/**
 * How many of each kind a song has to keep.
 *
 * One of most things is enough. A chorus is different: sung once it is not a
 * chorus, it is a verse with a tune. Matching on the TAG rather than the words
 * matters — two choruses that differ by a single word are still the chorus,
 * and an earlier rule that compared the text let exactly that case through.
 */
const MIN_OF_KIND = { chorus: 2, refrain: 2, hook: 2 };
const minOfKind = (kind) => MIN_OF_KIND[kind] || 1;

/**
 * Drop whole sections until the sheet fits — the last resort, after the take
 * has been stretched and the writer has been asked twice.
 *
 * A song that has said its chorus three times can say it twice; a song that
 * says it once has no chorus, which is how a first cut of this went wrong —
 * dropping the "duplicate" chorus left a sheet the video director could no
 * longer see a chorus in at all. So a repeat is only surplus while at least
 * two copies remain, and after that the longest middle section goes instead.
 * The opening and the last two sections are never touched: that is where a
 * song ends, and an ending is what this whole module exists to protect.
 */
function trimToBudget(blocks, budget) {
  const keep = blocks.slice();
  const dropped = [];
  let total = keep.reduce((n, b) => n + blockWords(b), 0);

  const copies = (key) => keep.filter((b) => blockKey(b) === key).length;
  const ofKind = (kind) => keep.filter((b) => blockKind(b) === kind).length;

  /**
   * Middle sections only, and never the last of anything.
   *
   * Three rules, each of them a bug that shipped. Word-for-word repeats are
   * safe to thin only while more than two remain, because a sheet whose
   * "duplicate" chorus was deleted is a sheet with no chorus. Every kind keeps
   * its minimum — two choruses, one of everything else — after a cut produced
   * a song with two choruses and no verse. And the opening and the last two
   * sections are never touched at all: that is where a song ends, and an
   * ending is the thing this whole module exists to protect.
   */
  const droppable = (i) => {
    if (i < 1 || i > keep.length - 3) return false;
    const key = blockKey(keep[i]);
    if (key && copies(key) === 2) return false;
    const kind = blockKind(keep[i]);
    return !kind || ofKind(kind) > minOfKind(kind);
  };

  while (total > budget && keep.length > 3) {
    let victim = -1;
    for (let i = keep.length - 3; i >= 1; i--) {
      const key = blockKey(keep[i]);
      if (key && copies(key) >= 3 && droppable(i)) { victim = i; break; }
    }
    if (victim < 0) {
      let best = 0;
      for (let i = keep.length - 3; i >= 1; i--) {
        const w = blockWords(keep[i]);
        if (droppable(i) && w > best) { best = w; victim = i; }
      }
    }
    if (victim < 0) break;
    dropped.push((keep[victim].tag || '[section]').replace(/[[\]]/g, ''));
    total -= blockWords(keep[victim]);
    keep.splice(victim, 1);
  }

  // Whole sections have run out and the sheet is still too long. Rather than
  // start taking the last verse or the ending, shorten what is left: whole
  // lines off the end of the longest section, in pairs so a rhyme is not left
  // hanging, never below two lines, and never out of a refrain — both copies
  // of a chorus have to stay the same words.
  while (total > budget) {
    let victim = -1;
    let best = 0;
    for (let i = 0; i < keep.length; i++) {
      const key = blockKey(keep[i]);
      if (key && copies(key) > 1) continue;
      const body = keep[i].lines.filter((l) => l.trim());
      if (body.length < 4) continue;
      const w = blockWords(keep[i]);
      if (w > best) { best = w; victim = i; }
    }
    if (victim < 0) break;
    const body = keep[victim].lines.filter((l) => l.trim());
    keep[victim] = { ...keep[victim], lines: body.slice(0, body.length - 2) };
    total = keep.reduce((n, b) => n + blockWords(b), 0);
    const name = (keep[victim].tag || '[section]').replace(/[[\]]/g, '');
    if (!dropped.includes(`lines from the ${name}`)) dropped.push(`lines from the ${name}`);
  }

  return { keep, dropped };
}

/**
 * The hard floor: cut a sheet down to what this running time can sing, and
 * change nothing else.
 *
 * `planSong` is the considered version of this — it moves the running time,
 * asks the writer again, and explains itself in the UI. This one exists
 * because that version lives in a screen, and a screen can be bypassed: an
 * open tab still running yesterday's JavaScript, the Studio screen, a script
 * posting to the API. A song was cut off mid-phrase for exactly that reason.
 * So the server puts every generation through this on the way past, where
 * nothing can miss it.
 *
 * Only ever removes words, never adds time, so applying it twice does nothing
 * the second time.
 *
 * @param {{lyrics: string, duration: number, voice?: string}} input
 * @returns {{lyrics: string, words: number, raw: number, limit: number, trimmed: string[]}}
 *          `raw` is the count as it arrived, `words` what is left.
 */
export function enforceLength({ lyrics, duration, voice = '', density = 0 }) {
  const normalized = normalizeSongEnding(lyrics);
  const words = countSungWords(normalized);
  const seconds = Math.max(0, Number(duration) || 0);
  const limit = wordsFor(seconds, density > 0 ? density : rateFor(voice));
  const out = { lyrics: normalized, words, raw: words, limit, trimmed: [] };
  // The floor sits at the boundary the songs themselves drew, not at the
  // comfortable target: nine measured takes put every truncation at 1.77
  // density or worse and every clean ending at 1.71 or better, so 1.5 × 1.15
  // separates them exactly. Below it nothing is touched. Above it the sheet
  // comes all the way down to the comfortable number, not just back over the
  // line — by then the take is already known to be in trouble.
  if (!words || !seconds || words <= limit * 1.15) return out;

  const r = trimToBudget(toBlocks(out.lyrics), limit);
  if (!r.dropped.length) return out;
  out.lyrics = normalizeSongEnding(fromBlocks(r.keep));
  out.words = countSungWords(out.lyrics);
  out.trimmed = r.dropped;
  return out;
}

/**
 * @typedef {Object} SongPlan
 * @property {string}   lyrics    the sheet to render, trimmed only if it had to be
 * @property {number}   words     sung words in that sheet
 * @property {number}   raw       sung words as written, before any trimming
 * @property {number}   duration  the running time to ask for
 * @property {number}   asked     the running time the customer chose
 * @property {string[]} trimmed   sections dropped, named
 * @property {number}   tail      seconds of playing after the last word
 * @property {boolean}  short     too thin even after stretching the take
 */

/**
 * Fit a written sheet and a running time to each other.
 *
 * @param {{lyrics: string, duration: number, voice?: string,
 *          min?: number, max?: number}} input  `voice` is the idea and style
 *          tags, read for tempo.
 * @returns {SongPlan}
 */
export function planSong({ lyrics, duration, voice = '', min = 0.04, max = 360 }) {
  const asked = clamp(Number(duration) || 0, min, max);
  const normalized = normalizeSongEnding(lyrics);
  const words = countSungWords(normalized);
  const rate = rateFor(voice);
  if (!words) {
    return { lyrics: normalized, words: 0, raw: 0, duration: asked, asked, trimmed: [], tail: 0, short: false };
  }

  // A thin sheet shortens the take rather than being padded out to length:
  // that is the difference between a four-minute song and four minutes of song
  // followed by a minute of its last line. Growing is kept to a tenth, because
  // the songs that landed wanted no extra time at all. Rounded DOWN to five
  // seconds so the rounding can never push past the ceiling.
  const ideal = secondsFor(words, rate);
  const seconds = clamp(
    Math.floor(clamp(ideal, asked * STRETCH.min, asked * STRETCH.max) / 5) * 5,
    min,
    max,
  );

  let out = normalized;
  let trimmed = [];
  // Words only come out when the running time could not reach far enough to
  // hold them. The test is on the words themselves rather than on the two
  // durations, because comparing durations put this on a knife edge: rounding
  // the take down to a five-second mark was enough, by itself, to cost a song
  // a whole section.
  const budget = wordsFor(seconds, rate);
  if (words > budget * 1.1) {
    const r = trimToBudget(toBlocks(out), budget);
    if (r.dropped.length) {
      out = normalizeSongEnding(fromBlocks(r.keep));
      trimmed = r.dropped;
    }
  }

  const finalWords = countSungWords(out);
  const tail = Math.max(0, seconds - secondsFor(finalWords, DENSITY.fast));

  // Even a fast singer runs out of words before this tape does, so say so in
  // the sheet. Left unsaid, the model fills the gap by singing its last hook
  // over and over — one real song's final minute was nine repeats of one line
  // — and a tag it might ignore costs nothing next to that.
  if (tail > TAIL_MAX) {
    out = addInstrumentalBeforeOutro(out);
  }

  return {
    lyrics: out,
    words: finalWords,
    raw: words,
    duration: seconds,
    asked,
    trimmed,
    tail: Math.round(tail),
    short: finalWords < wordsFor(seconds, DENSITY.slow) * 0.8,
  };
}
