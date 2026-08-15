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
 * not a stable number: two takes of the same sheet, the same length and the
 * same brief phrased it 1.39 and 2.28 words a second. That variance belongs to
 * the model and no arithmetic here can remove it. What six measured takes DO
 * agree on is the density that lands: at 1.71 and 1.60 songs ended cleanly, at
 * 1.77 one was cut off mid-phrase, and at 1.38 another looped its last line for
 * sixty-six seconds. So 1.65 is the middle of the band that works.
 */
export const DENSITY = { slow: 1.45, plain: 1.65, fast: 1.85 };

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
    brief = `LENGTH — this is a ${clock(secs)} recording, and every written word gets sung. The whole lyric must come to about ${target} words: count them, keep it between ${floor} and ${ceiling}, and use fewer sections rather than more. A longer lyric gets cut off mid-song. Finish with a real ending that lands, never a hook repeated to fill time, and if the words run out before the running time does, close with a bare [instrumental] tag and let the band play it out.`;
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

  /**
   * Middle sections only — and a section that appears exactly twice is what
   * makes a song have a refrain at all, so it is left alone. That leaves the
   * surplus copies of anything sung three times or more, and the one-off
   * sections, as the only things this is allowed to take.
   */
  const droppable = (i) => {
    if (i < 1 || i > keep.length - 3) return false;
    const key = blockKey(keep[i]);
    return !key || copies(key) !== 2;
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
  return { keep, dropped };
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
  const words = countSungWords(lyrics);
  const rate = rateFor(voice);
  if (!words) {
    return { lyrics: String(lyrics || ''), words: 0, raw: 0, duration: asked, asked, trimmed: [], tail: 0, short: false };
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

  let out = String(lyrics || '');
  let trimmed = [];
  // Words only come out when the running time could NOT reach far enough to
  // hold them. Trimming a sheet that already fits would be deleting someone's
  // verse for nothing, so the comparison is loose enough that rounding the
  // take down to a five-second mark cannot by itself cost a section.
  if (seconds < ideal * 0.95) {
    const r = trimToBudget(toBlocks(out), wordsFor(seconds, rate));
    if (r.dropped.length) {
      out = fromBlocks(r.keep);
      trimmed = r.dropped;
    }
  }

  const finalWords = countSungWords(out);
  const tail = Math.max(0, seconds - secondsFor(finalWords, DENSITY.fast));

  // Even a fast singer runs out of words before this tape does, so say so in
  // the sheet. Left unsaid, the model fills the gap by singing its last hook
  // over and over — one real song's final minute was nine repeats of one line
  // — and a tag it might ignore costs nothing next to that.
  if (tail > TAIL_MAX && !/\[\s*instrumental\s*\]\s*$/i.test(out.trim())) {
    out = `${out.trim()}\n\n[instrumental]`;
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
