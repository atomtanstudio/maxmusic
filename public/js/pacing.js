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
 * The model that fits four measured renders, to within a few seconds each:
 *
 *     running time  ≈  sung words / 1.78  +  15s
 *
 * — the singer covers about 1.78 words a second while a voice is present, and
 * a song needs roughly a quarter-minute besides that for its intro, its breaks
 * and an ending. `LEAD_OUT` is that quarter-minute; `RATE` is the singing.
 *
 * The writer is asked for the right size (`pacedPrompt`), but it is a writer,
 * not a calculator — one 3:00 request came back 40% long — so nothing
 * downstream trusts it. `planSong` is the guarantee: it moves the running time
 * to fit the words first, because a take twenty seconds longer costs nothing
 * and a deleted verse costs a verse, and trims only when no sane running time
 * could carry the sheet.
 *
 * @module pacing
 */

/** Sung words a second while a voice is present. Measured, not guessed. */
export const RATE = { slow: 1.55, plain: 1.78, fast: 1.95 };

/**
 * Seconds a song spends not singing: the intro, a break or two, and an ending.
 *
 * Twenty-two, not fifteen. Fifteen was read off the songs that happened to
 * land, and a controlled test then showed what happens when a sheet fills the
 * running time exactly: the singer never reaches the outro, loops two lines of
 * the bridge instead, and the recording stops mid-phrase with two tenths of a
 * second to spare. The extra seven seconds are the margin that failure bought.
 */
const LEAD_OUT = 22;

/** How far the running time may move from the length that was asked for. */
const STRETCH = { min: 0.75, max: 1.25 };

/** A tail longer than this gets an explicit play-out rather than a loop. */
const TAIL_MAX = 8;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 218 -> "3:38". */
export function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A ballad and a punk song do not sing the same number of words in a minute —
 * the four measured renders ran 1.56 to 1.90 — so the brief is read for tempo
 * before the arithmetic. Only words unambiguously about pace count; a genre
 * alone is too weak a signal to move the number.
 */
const FAST = /\b(fast|uptempo|up-tempo|driving|frantic|breakneck|relentless|energetic|punk|thrash|metal|hardcore|drum ?(and|&|n) ?bass|dnb|jungle|techno|rave|hyperpop|speed|rap|hip ?hop|trap|drill|patter|anthem|stadium)\b/i;
const SLOW = /\b(slow|slower|ballad|hymn|lullaby|elegy|dirge|funeral|ambient|drone|downtempo|meditative|mournful|sparse|hushed|gentle|tender|spacious|languid|half-?time)\b/i;

/** Words a second this brief is likely to want sung. */
export function rateFor(text) {
  const t = String(text || '');
  const fast = FAST.test(t);
  const slow = SLOW.test(t);
  if (fast === slow) return RATE.plain;      // both, or neither
  return fast ? RATE.fast : RATE.slow;
}

/** Sung words a recording of this length can hold. */
export function wordsFor(seconds, rate = RATE.plain) {
  return Math.max(1, Math.round(Math.max(0, (Number(seconds) || 0) - LEAD_OUT) * rate));
}

/** Running time this many words wants. */
export function secondsFor(words, rate = RATE.plain) {
  return (Math.max(0, Number(words) || 0) / rate) + LEAD_OUT;
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

  // The recording moves first: a take twenty seconds longer keeps every word
  // the writer wrote, and words are the expensive thing here.
  const ideal = secondsFor(words, rate);
  const seconds = clamp(
    Math.round(clamp(ideal, asked * STRETCH.min, asked * STRETCH.max) / 5) * 5,
    min,
    max,
  );

  let out = String(lyrics || '');
  let trimmed = [];
  // Words only come out when the take could NOT stretch far enough to hold
  // them — when the chosen length, plus the quarter it is allowed to grow by,
  // still is not enough. Trimming a sheet that already fits would be deleting
  // someone's verse for nothing. What is cut goes a little past the line, so
  // the song keeps a margin instead of ending exactly as the tape does.
  if (seconds < ideal * 0.98) {
    const r = trimToBudget(toBlocks(out), Math.floor(wordsFor(seconds, rate) * 0.95));
    if (r.dropped.length) {
      out = fromBlocks(r.keep);
      trimmed = r.dropped;
    }
  }

  const finalWords = countSungWords(out);
  const tail = Math.max(0, seconds - secondsFor(finalWords, RATE.fast));

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
    short: finalWords < wordsFor(seconds, RATE.slow) * 0.8,
  };
}
