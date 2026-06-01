/** Style prompts: Suno-like richness + genre-first ordering for MiniMax. */

const GENRE_FRAMES = {
  folk: ['indie folk campfire', 'acoustic porch session', 'americana dust-road'],
  jazz: ['jazz noir small-room', 'late-night jazz lounge', 'swing quartet live'],
  electronic: ['synthwave night-drive', 'minimal tech-trailer', 'ambient electronic drift'],
  pop: ['indie pop radio hook', 'dream pop shimmer', 'alt-pop chorus lift'],
  rock: ['indie rock band room', 'post-rock swell', 'emo anthem guitars'],
  hiphop: ['90s boom-bap block party', 'east coast crate-dig', 'west coast g-funk glide', 'trap noir bounce'],
  metal: ['heavy metal chug groove', 'thrash palm-mute assault', 'melodic metal chorus lift'],
  rnb: ['neo-soul lounge cut', '90s R&B slow jam', 'quiet storm radio'],
  classical: ['cinematic orchestral swell', 'chamber strings intimate'],
  general: ['deep focus pulse', 'cinematic underscore bed'],
};

const BPM_BY_GENRE = {
  folk: [72, 78, 82, 86, 90, 92, 95],
  jazz: [72, 78, 82, 86, 90, 95, 100, 110, 120],
  electronic: [95, 100, 108, 110, 115, 120, 124, 128, 132, 140],
  pop: [90, 95, 98, 102, 108, 110, 115, 120, 128],
  rock: [95, 100, 108, 110, 115, 120, 128, 132, 140],
  hiphop: [82, 86, 88, 90, 92, 95, 98, 102],
  metal: [100, 108, 110, 120, 128, 132, 140, 150, 160],
  rnb: [72, 78, 82, 86, 90, 92, 95],
  classical: [60, 72, 80, 90, 100],
  general: [72, 78, 82, 86, 90, 92, 95, 98, 102, 108, 110, 115, 120],
};

const DETAIL_POOLS = {
  folk: {
    tone: ['fingerpicked acoustic guitar', 'warm male vocal', 'harmonica accents', 'mandolin layer', 'nylon-string guitar'],
    drums: ['brush kit shuffle', 'soft kick thump', 'tambourine on chorus'],
    prod: ['tape saturation', 'room mic bleed', 'spring reverb'],
    mood: ['melancholic glow', 'bittersweet nostalgia', 'rainy window intimacy', 'morning coffee calm', 'porch-swing warmth'],
    avoid: ['synthwave', 'synthpop', 'EDM', 'heavy 808', 'detuned saw lead', 'sidechain pump', 'death metal'],
  },
  jazz: {
    tone: ['upright bass walk', 'saxophone breath solo', 'rhodes electric warmth', 'muted trumpet phrase', 'vibraphone shimmer'],
    drums: ['brush kit shuffle', 'rimshot groove', 'ride cymbal swing', 'light kick feathering'],
    prod: ['plate vocal reverb', 'room mic bleed', 'tape saturation', 'ribbon mic warmth'],
    mood: ['late-night confession', 'smoky bar intimacy', 'playful swing', 'after-hours glow'],
    avoid: ['synthwave', 'trap', 'EDM drop', 'distorted power chord', '808 sub tail'],
  },
  electronic: {
    tone: ['warm analog synth pulse', 'pulsating synth arpeggios', 'mono synth bassline', 'detuned saw lead', 'vocoder hook'],
    drums: ['gated toms', 'syncopated kick pattern', 'hi-hat 16th chatter', 'four-on-the-floor kick'],
    prod: ['sidechain pump', 'stereo widening chorus', 'low-pass filter sweep', 'tape flutter'],
    mood: ['nocturnal momentum', 'neon city haze', 'cold tension', 'retro-future drive'],
    avoid: ['fingerpicked acoustic', 'brush kit shuffle', 'bluegrass', 'mandolin', 'morning coffee calm'],
  },
  pop: {
    tone: ['clean electric guitar', 'stacked vocal harmonies', 'rhodes electric warmth', 'synth pad bed'],
    drums: ['dry snare crack', 'four-on-the-floor kick', 'clap layer', 'shaker 8ths'],
    prod: ['parallel compression glue', 'plate vocal reverb', 'stereo widening chorus'],
    mood: ['euphoric lift', 'bittersweet nostalgia', 'triumphant resolve', 'radio-ready shine'],
    avoid: ['phonk', 'death metal', 'free jazz atonal', 'vinyl crackle only'],
  },
  rock: {
    tone: ['distorted power chord stack', 'driving electric guitar', 'bass guitar punch', 'arena lead tone'],
    drums: ['dry snare crack', 'crash cymbal energy', 'syncopated kick pattern', 'tom fills'],
    prod: ['tape saturation', 'room mic bleed', 'parallel compression glue', 'amp room mic'],
    mood: ['urgent chase energy', 'triumphant resolve', 'haunted reverie', 'stadium adrenaline'],
    avoid: ['lo-fi vinyl bed only', 'orchestral strings only', 'morning coffee calm'],
  },
  hiphop: {
    tone: ['sampled jazz chord loop', 'filtered soul break', 'mono synth stab', 'gritty rap vocal', 'DJ scratch hook'],
    drums: ['boom-bap kick-snare', '808 sub tail', 'hi-hat rolls', 'rimshot groove', 'snare crack punch'],
    prod: ['vinyl crackle bed', 'mono collapse chorus', 'tape delay throws', 'bit-crushed sample', 'SP-1200 grit'],
    mood: ['block-party energy', 'street-corner storytelling', 'nocturnal city grit', 'boom-bap head-nod', 'desert highway heat'],
    avoid: ['orchestral swell', 'choir pad halo', 'fingerpicked nylon', 'morning coffee calm', 'acoustic porch', 'mandolin'],
  },
  metal: {
    tone: ['high-gain rhythm guitar', 'scooped mid bass', 'harmonic pinch squeal', 'double-tracked leads'],
    drums: ['double-kick blast', 'tight snare crack', 'china cymbal crash', 'blast beat pulse'],
    prod: ['tube amp saturation', 'parallel distortion', 'tight gate on drums', 'stereo double-track'],
    mood: ['aggressive drive', 'dark anthem weight', 'mosh-pit intensity', 'apocalyptic tension'],
    avoid: ['morning coffee calm', 'acoustic porch', 'bossa nova', 'vinyl crackle lounge', 'soft brush kit'],
  },
  rnb: {
    tone: ['electric piano chords', 'smooth bass line', 'stacked harmony stacks', 'talk-box accent'],
    drums: ['tight pocket kick', 'snare with ghost notes', 'hi-hat swing'],
    prod: ['warm tape glue', 'plate vocal reverb', 'subtle chorus widening'],
    mood: ['late-night intimacy', 'silk-sheet groove', 'heartfelt confession', 'slow-dance warmth'],
    avoid: ['death metal', 'blast beat', 'synthwave arpeggio only'],
  },
  classical: {
    tone: ['string section swell', 'solo piano motif', 'french horn line', 'woodwind countermelody'],
    drums: ['timpani roll', 'soft mallet pulse'],
    prod: ['concert hall reverb', 'wide stereo image'],
    mood: ['triumphant resolve', 'haunted reverie', 'melancholic glow', 'rising tension arc'],
    avoid: ['808', 'trap', 'vocoder', 'distorted power chord'],
  },
  general: {
    tone: ['clean guitar texture', 'subtle pad wash', 'warm vocal'],
    drums: ['dry snare crack', 'soft kick pattern'],
    prod: ['tape saturation', 'spring reverb'],
    mood: ['focused atmosphere', 'steady forward motion', 'reflective calm'],
    avoid: [],
  },
};

/** Moods/terms that clash with a genre — never picked by wand for that genre. */
const MOOD_MISMATCH = {
  folk: /\b(neon|808|blast beat|detuned saw|mosh)\b/i,
  jazz: /\b(808|blast beat|mosh|death metal|synthwave night)\b/i,
  electronic: /\b(morning coffee|porch|mandolin|brush kit shuffle|campfire)\b/i,
  pop: /\b(blast beat|mosh|death growl)\b/i,
  rock: /\b(morning coffee|bossa|brush kit shuffle)\b/i,
  hiphop: /\b(morning coffee|porch|campfire|mandolin|harmonica|choir pad halo|acoustic porch|spring reverb lounge)\b/i,
  metal: /\b(morning coffee|coffee calm|porch|bossa|brush kit shuffle|acoustic porch|soft jazz)\b/i,
  rnb: /\b(blast beat|mosh|death metal)\b/i,
  classical: /\b(808|trap|sidechain pump)\b/i,
  general: /\b(morning coffee)\b/i,
};

const SYNTH_MARKERS = /\b(synth|synthwave|synthpop|synth pop|edm|techno|trance|house|arpeggio|detuned saw|vocoder|sidechain|808|hyperpop)\b/i;
const ACOUSTIC_MARKERS = /\b(folk|acoustic|americana|bluegrass|country|singer-songwriter|fingerpick|nylon guitar|brush kit|mandolin|banjo)\b/i;

const GENERIC_SEED_RE = [
  /^an?\s+original\s+song\b/i,
  /^original\s+song\b/i,
  /clear\s+mood\s+and\s+genre/i,
  /^write\s+(a\s+)?(song|full\s+song)\b/i,
  /^song\s+with\b/i,
  /^new\s+song\b/i,
  /^untitled\b/i,
  /^music\s+(for|with)\b/i,
  /^a\s+song\s+about\b/i,
];

const WAND_THEME_BY_GENRE = {
  folk: 'A soulful indie folk song about a long goodbye on a dusty road',
  jazz: 'A late-night jazz ballad in a rainy city diner',
  electronic: 'A neon synthwave drive through empty midnight streets',
  pop: 'A bright indie pop anthem about small victories after doubt',
  rock: 'An indie rock song about running toward the horizon',
  hiphop: 'A gritty boom-bap story about the block after dark',
  metal: 'A heavy metal track about standing against the storm',
  rnb: 'A slow neo-soul confession after the party ends',
  classical: 'A cinematic orchestral piece with quiet tension building',
  general: 'An original song with vivid imagery and a clear emotional arc',
};

export function isGenericSeed(text) {
  const t = (text || '').trim();
  if (!t || t.length < 3) return true;
  if (GENERIC_SEED_RE.some((re) => re.test(t))) return true;
  const hasGenreHint = /\b(folk|pop|rock|jazz|trap|edm|synth|acoustic|country|blues|soul|r&b|metal|punk|indie|ballad|cinematic|orchestral|lo-?fi|reggae|funk|disco|house|techno|ambient|hip hop|hip-hop|rap)\b/i.test(t);
  if (!hasGenreHint && t.split(/\s+/).length > 8) return true;
  return false;
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function pickUnique(rng, list, count, filterFn = () => true) {
  const copy = list.filter(filterFn);
  const out = [];
  while (out.length < count && copy.length) {
    const i = Math.floor(rng() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function splitSegments(raw) {
  return raw
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True when two style segments express the same genre/vibe (avoids "old school hip hop" twice). */
export function segmentsSimilar(a, b) {
  const na = normKey(a);
  const nb = normKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(/\s+/).filter((w) => w.length > 2);
  const wb = new Set(nb.split(/\s+/).filter((w) => w.length > 2));
  if (!wa.length) return false;
  const overlap = wa.filter((w) => wb.has(w)).length;
  return overlap >= Math.min(2, wa.length);
}

function shouldAppendStyleSuffix(primary) {
  const words = primary.trim().split(/\s+/);
  return words.length <= 2 && !/\bstyle\b/i.test(primary);
}

export function classifyPromptGenre(text) {
  const t = (text || '').toLowerCase();
  if (/\b(death metal|black metal|heavy metal|thrash|metalcore|doom metal|power metal)\b/.test(t)) return 'metal';
  if (/\b(old school|boom[- ]?bap|g[- ]?funk|east coast|west coast|hip hop|hip-hop|rap|trap|phonk)\b/.test(t)) return 'hiphop';
  if (/\b(indie folk|folk|acoustic|americana|bluegrass|country|singer-songwriter)\b/.test(t)) return 'folk';
  if (/\b(jazz|swing|bebop|bossa)\b/.test(t)) return 'jazz';
  if (/\b(synthwave|synthpop|synth pop|edm|techno|house|trance|electronic|dnb|drum and bass)\b/.test(t)) return 'electronic';
  if (/\b(neo-?soul|r&b|rnb|quiet storm)\b/.test(t)) return 'rnb';
  if (/\b(rock|punk|grunge|emo)\b/.test(t)) return 'rock';
  if (/\b(metal)\b/.test(t)) return 'metal';
  if (/\b(orchestral|cinematic|classical|chamber)\b/.test(t)) return 'classical';
  if (/\b(pop|indie pop|dream pop)\b/.test(t)) return 'pop';
  if (/\b(lo-?fi hip hop|lofi hip hop)\b/.test(t)) return 'hiphop';
  if (/\b(lo-?fi|lofi)\b/.test(t)) return 'folk';
  return 'general';
}

function segmentConflictsGenre(seg, genre) {
  const s = seg.toLowerCase();
  const pool = DETAIL_POOLS[genre] || DETAIL_POOLS.general;
  if (pool.avoid.some((a) => s.includes(a.toLowerCase()))) return true;
  if (MOOD_MISMATCH[genre]?.test(seg)) return true;
  if ((genre === 'folk' || genre === 'jazz') && SYNTH_MARKERS.test(s)) return true;
  if (genre === 'electronic' && ACOUSTIC_MARKERS.test(s) && !/\blo-?fi\b/i.test(s)) return true;
  return false;
}

function filterPool(list, genre, lead, used) {
  const mismatch = MOOD_MISMATCH[genre];
  return list.filter((item) => {
    if (mismatch?.test(item)) return false;
    if (segmentsSimilar(item, lead)) return false;
    if (used.some((u) => segmentsSimilar(item, u))) return false;
    return true;
  });
}

function extractBpm(segments) {
  for (const seg of segments) {
    const m = seg.match(/(\d{2,3})\s*bpm/i);
    if (m) return `${m[1]} BPM`;
  }
  return null;
}

function dedupeSegments(list) {
  const seen = new Set();
  const out = [];
  for (const seg of list) {
    const key = normKey(seg);
    if (!key || seen.has(key)) continue;
    if (out.some((existing) => segmentsSimilar(existing, seg))) continue;
    seen.add(key);
    out.push(seg);
  }
  return out;
}

export function prepareMusicPrompt(raw) {
  const segments = splitSegments(raw);
  if (!segments.length) return '';

  const primary = segments.find((s) => !isGenericSeed(s)) || segments[0];
  const genre = classifyPromptGenre(primary + ', ' + segments.join(', '));
  const pool = DETAIL_POOLS[genre] || DETAIL_POOLS.general;

  const bpm = extractBpm(segments);
  const rest = segments
    .filter((seg) => seg !== primary && !isGenericSeed(seg) && !segmentsSimilar(seg, primary) && !segmentConflictsGenre(seg, genre));

  const ordered = dedupeSegments([
    primary,
    ...(isGenericSeed(primary) || !shouldAppendStyleSuffix(primary) ? [] : [`${primary} style`]),
    ...rest.slice(0, 10),
  ]);

  if (bpm && !ordered.some((s) => /bpm/i.test(s))) ordered.splice(Math.min(2, ordered.length), 0, bpm);

  if (pool.avoid.length) {
    const guard = `not ${pool.avoid.slice(0, 3).join(', not ')}`;
    if (!ordered.some((s) => s.toLowerCase().startsWith('not '))) ordered.push(guard);
  }

  return ordered.join(', ').slice(0, 2000);
}

export function pickWandTheme(seedHint = '') {
  const genre = classifyPromptGenre(seedHint);
  const rng = mulberry32(hashSeed(`wand|${seedHint}|${Date.now()}`));
  const themes = WAND_THEME_BY_GENRE[genre] ? [WAND_THEME_BY_GENRE[genre]] : [WAND_THEME_BY_GENRE.general];
  return pick(rng, themes);
}

export function buildRichStylePrompt(seed = '', apiStyleTags = '') {
  const seedSegs = splitSegments(seed).filter((s) => !isGenericSeed(s));
  const apiSegs = splitSegments(apiStyleTags).filter((s) => !isGenericSeed(s));

  const rng = mulberry32(hashSeed(`${seed}|${apiStyleTags}|${Date.now() % 9973}`));
  const seedLead = seedSegs[0] || '';
  const context = [seedLead, ...seedSegs, ...apiSegs].join(', ');
  const genre = classifyPromptGenre(context);

  const pool = DETAIL_POOLS[genre] || DETAIL_POOLS.general;
  const frames = (GENRE_FRAMES[genre] || GENRE_FRAMES.general).filter((f) => !segmentsSimilar(f, seedLead));
  const bpms = BPM_BY_GENRE[genre] || BPM_BY_GENRE.general;

  let lead = seedLead;
  if (!lead) {
    const apiFiltered = apiSegs.find((s) => !segmentConflictsGenre(s, genre));
    lead = apiFiltered || pick(rng, GENRE_FRAMES[genre] || GENRE_FRAMES.general);
  }

  const frameCandidates = frames.length ? frames : GENRE_FRAMES[genre] || GENRE_FRAMES.general;
  const frame = frameCandidates.find((f) => !segmentsSimilar(f, lead)) || null;

  const bpm = extractBpm([...seedSegs, ...apiSegs]) || `${pick(rng, bpms)} BPM`;

  const used = [lead, frame].filter(Boolean);
  const enrich = (list, n) => pickUnique(rng, list, n, (item) => {
    if (segmentConflictsGenre(item, genre)) return false;
    if (segmentsSimilar(item, lead)) return false;
    return !used.some((u) => segmentsSimilar(item, u));
  });

  const userBits = [...apiSegs, ...seedSegs.slice(1)]
    .filter((seg) => !segmentsSimilar(seg, lead) && !segmentConflictsGenre(seg, genre))
    .slice(0, 4);

  const parts = dedupeSegments([
    lead,
    frame,
    bpm,
    ...userBits,
    ...enrich(pool.tone, 2),
    ...enrich(pool.drums, 1),
    ...enrich(pool.prod, 1),
    ...enrich(pool.mood, 2),
  ].filter(Boolean));

  return prepareMusicPrompt(parts.join(', '));
}