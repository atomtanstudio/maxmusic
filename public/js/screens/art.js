/**
 * Art — album artwork for the songs this studio makes.
 *
 * The screen turns a song into an art direction on the client: deterministic,
 * no model call, no round trip. Everything the customer sees is in customer
 * language — no hosts, no endpoints, no provider names, no file sizes. The one
 * exception is the transient error state, where the service's own words are
 * shown verbatim so a real failure is actionable rather than mysterious.
 *
 * Layout:
 *   left    composer — source, what the brief draws on, the brief, the direction
 *   right   hero (the selected cover + its brief) over the gallery
 *
 * Bus:
 *   in  `track:new`   — a finished song becomes a source for artwork
 *   out `art:new`     — `{ cover, meta }` once a real cover comes back
 *
 * Owned by the art lane: this file + public/css/screens/art.css.
 *
 * @module screens/art
 */

export const meta = {
  title: 'Art',
  subtitle: 'Artwork for the songs you make',
  css: '/css/screens/art.css',
};

/* ========================================================================== *
 * Small helpers
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
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

const clock = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
  if (!ts) return '';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Stable small hash — variation in the composed brief must be reproducible. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const lower = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');

/** Shorten on a word boundary. Never cuts a word in half mid-label. */
const snip = (s, n) => {
  const t = clean(s);
  return t.length <= n ? t : `${t.slice(0, n).replace(/[\s,;/-]+\S*$/, '')}…`;
};

/* ========================================================================== *
 * Reading a song: the structured caption, and the lyrics
 * ========================================================================== */

const CAPTION_FIELDS = [
  'Basic Attributes',
  'Global Emotional Progression',
  'Application Scenarios & Imagery',
  'Sonics & Production Profile',
  'Vocal Gender & Timbre',
  'Vocal Style',
  'Harmony/Backing Vocals',
  'Vocal FX',
  'Instrument Lifecycle Description (Primary/Secondary Layering)',
  'Instrument Lifecycle Description',
  'Groove & Foundation Progression',
  'Embellishments, Textures & Spatial FX',
];

/** Slice a labelled caption into its parts. Unlabelled prose returns {}. */
function splitCaption(text) {
  const src = String(text || '');
  const low = src.toLowerCase();
  const marks = [];
  for (const label of CAPTION_FIELDS) {
    const at = low.indexOf(`${label.toLowerCase()}:`);
    if (at < 0) continue;
    if (marks.some((m) => m.at === at)) continue; // "…Description" inside "…Description (…)"
    marks.push({ label, at, from: at + label.length + 1 });
  }
  marks.sort((a, b) => a.at - b.at);
  const out = {};
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    out[mark.label] = clean(src.slice(mark.from, end));
  });
  return out;
}

/**
 * Everything the art direction can draw on, pulled out of one song.
 * Works on a full structured caption and degrades to plain prose.
 *
 * @param {string} captionText
 */
export function readSong(captionText) {
  const parts = splitCaption(captionText);
  const raw = clean(captionText);
  const attrs = parts['Basic Attributes'] || '';

  const bpm = Number((raw.match(/bpm\s*is\s*(\d{2,3})/i) || raw.match(/(\d{2,3})\s*bpm/i) || [])[1]) || 0;
  const key = (raw.match(/key\s*is\s*([A-G][#b]?)\b/i) || [])[1] || '';
  const scale = /\bminor\b/i.test(attrs || raw) ? 'minor' : /\bmajor\b/i.test(attrs || raw) ? 'major' : '';

  // The genre is what is left of the attributes once the numbers are taken out,
  // so a label never reads "seventies country rock, 88 bpm, major" beside a
  // tempo column that already says 88 bpm.
  const notNumbers = (s) => s
    && !/^bpm is/i.test(s) && !/^key is/i.test(s) && !/scale is/i.test(s)
    && !/^\d+\s*bpm$/i.test(s) && !/^(major|minor)$/i.test(s)
    && !/^(in\s+)?[A-G][#b]?\s*(major|minor)?$/i.test(s);

  let genre = '';
  if (attrs) genre = attrs.split(/[.]/).map(clean).filter(notNumbers).join(', ');
  if (!genre) {
    const first = raw.split(/[.\n]/).map(clean).filter(Boolean)[0] || '';
    genre = first.split(',').map(clean).filter(notNumbers).join(', ');
  }

  return {
    raw,
    genre,
    bpm,
    key,
    scale,
    scenes: parts['Application Scenarios & Imagery'] || '',
    mood: parts['Global Emotional Progression'] || '',
    sonics: parts['Sonics & Production Profile'] || '',
    instruments: parts['Instrument Lifecycle Description (Primary/Secondary Layering)']
      || parts['Instrument Lifecycle Description'] || '',
    vocal: parts['Vocal Gender & Timbre'] || '',
    structured: Object.keys(parts).length > 0,
  };
}

const STOP = new Set(`the a an and or but if then than that this these those there here when while
with without within into onto from for you your yours me my mine we our ours they them their
he she his her it its is are was were be been being am do does did done have has had will would
can could should shall may might must not no nor so too very just only ever never always about
over under again down out up off back away come came go goes going get got let like know knew
say said see saw feel felt want need make made take took give gave keep kept turn turned all
one two three now still yet even more most some any each every own same other another how what
who whom which why where because before after until since through around between against upon
oh yeah ooh whoa hey na la mmm gonna wanna gotta cause till em well been much many long little
right left thing things somebody someone nobody everything nothing something anymore tonight
used using really maybe almost enough alone together again else such once twice been being
above below behind beside across along past near toward towards inside outside beneath onto`
  .split(/\s+/));

/**
 * Lyric words → things a camera could actually photograph.
 *
 * SPEC §10c.2 is explicit that lyrics must be *abstracted into visual subject
 * matter*, never pasted. So a word only contributes if it maps to an object;
 * "promise", "believe" and "forever" contribute nothing to a picture and are
 * dropped rather than dressed up as nouns.
 */
const MOTIF_IMAGES = [
  [/^(fire|fires|burn|burns|burned|burning|burnt|flame|flames|ember|embers|ash|ashes|spark|sparks)$/, 'low embers'],
  [/^(smoke|smoking|cigarette|cigarettes|match|matches|lighter)$/, 'smoke holding its shape in still air'],
  [/^(rain|rains|raining|storm|storms|thunder|flood|downpour|soaked|drenched|puddle|puddles)$/, 'standing water'],
  [/^(ocean|oceans|sea|seas|wave|waves|tide|tides|water|waters|river|rivers|drown|drowning|swim|swimming|shore|shores)$/, 'a waterline running out of frame'],
  [/^(road|roads|drive|drives|drove|driving|highway|highways|freeway|street|streets|mile|miles|wheel|wheels|engine|car|cars|truck)$/, 'a pair of tail lights'],
  [/^(train|trains|track|tracks|station|platform|leaving|gone|goodbye)$/, 'an empty platform after a departure'],
  [/^(night|nights|midnight|dark|darkness|moon|moonlight|star|stars|sky|skies)$/, 'one bright point in a black sky'],
  [/^(light|lights|shine|shines|shining|glow|glowing|sun|sunlight|sunrise|dawn|morning|daylight|golden)$/, 'one hard source of light'],
  [/^(home|house|houses|door|doors|room|rooms|window|windows|kitchen|bed|beds|floor|stairs|hall)$/, 'a lit interior seen through one window'],
  [/^(heart|hearts|blood|bone|bones|breath|breathe|skin|hand|hands|arms|eyes|face|body|touch)$/, 'a pair of hands, cropped close'],
  [/^(city|cities|town|towns|neon|sign|signs|building|buildings|concrete|subway|avenue|corner)$/, 'city signage thrown out of focus'],
  [/^(wind|winds|air|breeze|dust|desert|sand|dune|dunes)$/, 'dust carried sideways'],
  [/^(gold|golden|silver|diamond|diamonds|crown|money|dollar|dollars|rich|jewel|jewels)$/, 'one gilded object among plain ones'],
  [/^(ghost|ghosts|haunt|haunted|haunting|memory|memories|remember|forget|forgot|past)$/, 'a double exposure that never resolves'],
  [/^(bird|birds|wing|wings|fly|flying|flew|feather|feathers|angel|angels)$/, 'wings against a flat sky'],
  [/^(glass|mirror|mirrors|reflection|broken|break|breaking|shatter|shattered|crack|cracked)$/, 'a cracked reflective surface'],
  [/^(phone|call|calls|calling|letter|letters|message|paper|write|wrote|written|pen|ink|name|names)$/, 'a handwritten page, half legible'],
  [/^(snow|winter|cold|colder|ice|frozen|freeze|frost)$/, 'frost forming at the edges'],
  [/^(summer|beach|heat|hot|august|july|sunburn)$/, 'heat haze over a flat surface'],
  [/^(dance|dances|dancing|danced|floor|club|clubs|party|crowd|crowds)$/, 'a crowd blurred by its own movement'],
  [/^(war|fight|fighting|battle|soldier|soldiers|gun|guns|knife|blade|scar|scars|bruise)$/, 'a scar left on a hard surface'],
  [/^(wine|whiskey|whisky|drink|drinks|drinking|drunk|bottle|bottles|glasses|bar|bars)$/, 'an empty glass on a wet ring'],
  [/^(time|times|clock|clocks|hour|hours|minute|minutes|year|years|season|wait|waiting|waited)$/, 'a clock with no hands'],
  [/^(flower|flowers|rose|roses|garden|gardens|grow|grows|growing|tree|trees|leaves|forest|weeds)$/, 'one flowering thing in a dead space'],
  [/^(mountain|mountains|hill|hills|valley|stone|stones|rock|rocks|cliff|canyon)$/, 'stone worn smooth at the top'],
  [/^(dream|dreams|dreaming|dreamt|sleep|sleeping|asleep|wake|woke|awake|pillow)$/, 'a bed with the covers thrown back'],
  [/^(mother|father|mama|papa|child|children|baby|brother|sister|family|son|daughter|kids)$/, 'an old family photograph with soft edges'],
  [/^(song|songs|sing|singing|sang|radio|music|melody|record|records|tape|tapes|guitar|piano|drum|drums|strings)$/, 'a record sleeve left open'],
  [/^(chain|chains|key|keys|lock|locked|cage|rope|bound|bind|shackle)$/, 'a key left in a lock'],
  [/^(church|pray|prayer|prayed|god|holy|saint|saints|sin|sins|soul|souls|altar|candle|candles)$/, 'a candle burning at the edge of the frame'],
  [/^(bridge|bridges|border|borders|cross|crossing|crossed|line|lines|edge|edges|map|maps)$/, 'a bridge span with nothing on it'],
  [/^(machine|machines|wire|wires|circuit|signal|signals|static|screen|screens|electric|current|wired)$/, 'a screen carrying nothing but static'],
  [/^(smile|smiles|laugh|laughing|tear|tears|cry|crying|cried|weep)$/, 'a wet mark drying on a hard surface'],
  [/^(shadow|shadows|silhouette|dusk|twilight|evening|sunset)$/, 'a long shadow reaching across the ground'],
  [/^(gold|amber|honey|copper|rust|rusted|iron|steel|metal)$/, 'oxidised metal catching the light'],
];

/**
 * Concrete, repeatable imagery from a lyric sheet — never the lines themselves.
 *
 * Words carried by the most-repeated line (the hook) count double, so the
 * picture leans on what the song actually keeps coming back to.
 *
 * @param {string} text
 * @returns {{ words: string[], images: string[], hook: boolean }}
 */
export function readLyrics(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l));

  // The hook is the line the song repeats most. It is read, never reproduced.
  const lineCounts = new Map();
  for (const line of lines) {
    const k = line.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length > 6) lineCounts.set(k, (lineCounts.get(k) || 0) + 1);
  }
  let hook = '';
  let hookN = 1;
  for (const [k, n] of lineCounts) if (n > hookN) { hookN = n; hook = k; }

  const counts = new Map();
  const tally = (source, weight) => {
    for (const word of String(source).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) {
      const w = word.replace(/'s$/, '').replace(/^'+|'+$/g, '');
      if (w.length < 4 || STOP.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + weight);
    }
  };
  tally(lines.join('\n'), 1);
  if (hook) tally(hook, 2);

  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([w]) => w);

  const words = ranked.slice(0, 4);

  const images = [];
  for (const word of ranked) {
    if (images.length >= 2) break;
    const hit = MOTIF_IMAGES.find(([re]) => re.test(word));
    if (hit && !images.includes(hit[1])) images.push(hit[1]);
  }

  return { words, images, hook: Boolean(hook) };
}

/* ========================================================================== *
 * Art direction lexicons
 *
 * These turn what a song *is* into what a picture *looks like*. Two songs with
 * different genres, keys, tempos and imagery come out of here as two different
 * art directions, not the same sentence with a word swapped.
 *
 * `swatch` is the palette as actual colour, so the composer can show the
 * direction rather than only describe it. Photographic tones, deliberately —
 * these are content, not interface accents.
 * ========================================================================== */

/* Most specific first: strong imagery words beat a genre word, and a genre word
   beats the catch-all. "world music electronica" is ritual, not neon. */
const REGISTERS = [
  {
    match: /(highway|motorway|open road|road trip|headlight|freeway)/i,
    scene: 'an empty highway at last light, the road running out to a flat horizon',
    palette: 'sodium amber over deep blue dusk, the tarmac almost black',
    swatch: ['#e0a04a', '#2a4260', '#0d1016'],
    light: 'a low sun flaring across glass',
  },
  {
    match: /(ocean|the sea|tide|underwater|submerged|shoreline|harbour|harbor|dub techno)/i,
    scene: 'a still sea under low cloud, the horizon barely separating water from sky',
    palette: 'deep teal, pewter and one thin band of silver',
    swatch: ['#14484e', '#8a97a0', '#d7dee2'],
    light: 'flat overcast light that casts no shadow',
  },
  {
    match: /(world music|tribal|ritual|gamelan|afro|ethnic|eastern|shamanic)/i,
    scene: 'a rain-slicked stone courtyard, incense smoke drifting low over the flagstones',
    palette: 'wet basalt, ember gold and cold blue shadow',
    swatch: ['#2c2b30', '#c88c34', '#2b445e'],
    light: 'first light breaking under heavy cloud',
  },
  {
    match: /(orchestral|classical|symphon|strings|choral|film score|trailer music|cinematic)/i,
    scene: 'a vast stone interior with a single shaft of light falling across the floor',
    palette: 'slate grey and deep sea blue broken by one band of gold',
    swatch: ['#59616b', '#1b3350', '#c6a02c'],
    light: 'one narrow shaft cutting through suspended dust',
  },
  {
    match: /(metal|hardcore|punk|industrial|noise|grunge|thrash|sludge)/i,
    scene: 'a corroded steel structure shot from below against a bruised sky',
    palette: 'oxidised iron, ash white and one stripe of alarm red',
    swatch: ['#6a4632', '#d6d3cc', '#b8382c'],
    light: 'flat overcast glare with blown highlights',
  },
  {
    match: /(jazz|blues|lounge|swing|bossa|latin|samba|big band)/i,
    scene: 'a near-empty room after the set, one glass and a chair pushed back',
    palette: 'tobacco brown, brass and deep green shadow',
    swatch: ['#5a3a22', '#b5872c', '#1e3a2f'],
    light: 'a warm practical lamp just out of frame',
  },
  {
    match: /(hip ?hop|trap|rap|drill|boom ?bap|r&b|rnb|soul|funk|neo-?soul)/i,
    scene: 'a lit stairwell at street level, chain-link and steam coming off the pavement',
    palette: 'warm sodium orange against cold concrete grey',
    swatch: ['#d4762c', '#7d838a', '#292c31'],
    light: 'a single overhead bulb with hard falloff',
  },
  {
    match: /(folk|acoustic|country|americana|bluegrass|singer-?songwriter|ballad)/i,
    scene: 'a dry field at the end of the afternoon, one chair turned away from the road',
    palette: 'sun-bleached ochre, bone white and washed-out denim',
    swatch: ['#c6a069', '#e5ded1', '#7d92a7'],
    light: 'low sideways daylight an hour before dusk',
  },
  {
    match: /(ambient|drone|downtempo|chillout|meditative|new ?age|shoegaze|dream ?pop)/i,
    scene: 'a shoreline dissolving into fog, the horizon barely there',
    palette: 'pale grey-green, oyster and a faint rose bloom',
    swatch: ['#a6b2a5', '#ddd6ca', '#c69a9a'],
    light: 'flat diffused light, the edges falling away into haze',
  },
  {
    match: /(synth-?wave|synth-?pop|synthpop|techno|\bhouse\b|club|rave|\bedm\b|dance|hyperpop|trance|\belectro\b|\belectronic\b|neon)/i,
    scene: 'a wet city street after midnight, one figure crossing an empty junction',
    palette: 'electric cyan and deep magenta bleeding across black asphalt',
    swatch: ['#2ab6c8', '#9c3187', '#101014'],
    light: 'hard neon signage doubled in the puddles',
  },
  {
    match: /(lo-?fi|bedroom|indie|alt|alternative|pop ?rock|rock|chiptune|8-?bit)/i,
    scene: 'a bedroom window at night with the city out of focus behind the glass',
    palette: 'dusty teal, faded red and warm lamp yellow',
    swatch: ['#3e6b6b', '#ac4a44', '#dcb257'],
    light: 'one window as the only light in the room',
  },
];

const FALLBACK_REGISTER = {
  scene: 'an empty road at night, headlights sweeping past the frame',
  palette: 'deep indigo, sodium amber and a cold white edge',
  swatch: ['#232a4a', '#d5903c', '#e7ecf1'],
  light: 'one moving light source and long shadows',
};

/* Mood words only — anything that doubles as a production word ("warm",
   "bright") lives in TEXTURES instead, or a tape-saturated country record comes
   out reading as a tender ballad. */
const MOODS = [
  { match: /(joy|uplift|euphor|triumph|soar|celebrat|hopeful)/i, note: 'the whole frame lifting toward the light' },
  { match: /(melanchol|wistful|nostalg|bitters?weet|longing|ache|yearn)/i, note: 'held a beat too long, gentle and unresolved' },
  { match: /(tense|urgent|driving|restless|anxious|frantic|relentless)/i, note: 'framed tight and slightly off balance' },
  { match: /(calm|serene|still|gentle|tender|intimate|hushed)/i, note: 'quiet, close, almost nothing moving' },
  { match: /(dark|brooding|ominous|menacing|heavy|grim|haunt|reverent|solemn)/i, note: 'most of the frame given over to shadow' },
  { match: /(defiant|angry|fierce|rebell|furious)/i, note: 'confrontational, the subject filling the frame' },
];

const TEXTURES = [
  { match: /(analog|analogue|tape|vinyl|warm|vintage|retro|saturat)/i, note: 'shot on 35mm with visible grain and gentle halation' },
  { match: /(lo-?fi|dusty|crackle|degrad|cassette|worn)/i, note: 'a generation-loss photocopy, dust and hairline scratches' },
  { match: /(clean|polished|pristine|hi-?fi|crisp|modern|digital|glossy)/i, note: 'clean large-format capture, no grain, deep shadow detail' },
  { match: /(wide|spacious|cavern|reverb|vast|expansive|atmospher)/i, note: 'a long exposure with the far edges falling away' },
  { match: /(gritty|raw|distort|fuzz|overdriv|crush)/i, note: 'high-contrast push-processed film, crushed blacks' },
];

const TEMPO = [
  { under: 78, note: 'nothing in motion, a held still frame' },
  { under: 100, note: 'a slow drift, one element just beginning to move' },
  { under: 128, note: 'a walking pace, weight shifting in the composition' },
  { under: 999, note: 'caught mid-motion, edges smeared by the movement' },
];

const pick = (list, text, fallback = null) => (clean(text)
  ? list.find((row) => row.match.test(text)) || fallback
  : fallback);

/**
 * Like `pick`, but the winner is the entry whose word appears FIRST in the
 * text rather than the one highest in the table. An emotional progression is
 * written as an arc — "restless and urgent … euphoric on the drop" — and the
 * register it opens in is the one a single still frame has to carry.
 */
function pickEarliest(list, text) {
  const src = clean(text);
  if (!src) return null;
  let best = null;
  let at = Infinity;
  for (const row of list) {
    const m = src.match(row.match);
    if (m && m.index < at) { at = m.index; best = row; }
  }
  return best;
}

const PEOPLE = /\b(figure|figures|man|men|woman|women|person|people|crowd|dancer|dancing|singer|child|children|couple|face|faces|hands?)\b/i;

/**
 * Work out the art direction behind the brief. Deterministic and client-side:
 * the same song and the same toggles always produce the same direction, and
 * two different songs produce two genuinely different ones.
 *
 * @returns {?{text: string, scene: string, palette: string, swatch: string[],
 *            light: string, texture: string, images: string[], mood: string}}
 */
export function composeBrief({ style, lyrics, title, instrumental, useStyle, useLyrics, useTitle }) {
  const styleText = useStyle ? clean(style) : '';
  const song = readSong(styleText);
  const read = useLyrics && !instrumental
    ? readLyrics(lyrics)
    : { words: [], images: [], hook: false };
  const named = useTitle ? clean(title) : '';

  if (!styleText && !read.images.length && !read.words.length && !named) return null;

  // The music picks the register; failing that the lyrics do; failing that the
  // catch-all. So switching every toggle still lands somewhere specific.
  const reg = pick(REGISTERS, `${song.genre} ${song.raw}`)
    || pick(REGISTERS, read.words.join(' '))
    || FALLBACK_REGISTER;

  // The caption's own emotional line wins; a bare style sentence is scanned
  // next; a key signature is the last resort.
  const mood = (pickEarliest(MOODS, song.mood) || pickEarliest(MOODS, song.raw))?.note
    || (song.scale === 'minor' ? 'cool and unresolved'
      : song.scale === 'major' ? 'open and warm' : '');
  const texture = pick(TEXTURES, `${song.sonics} ${song.raw}`)?.note
    || 'shot on 35mm with visible grain';
  const tempoNote = song.bpm ? TEMPO.find((t) => song.bpm < t.under).note : '';

  // The scene: the caption's own imagery beats anything in a lookup table.
  let scene = '';
  if (song.scenes) {
    scene = clean(song.scenes.split(/[.;]/).map(clean).filter(Boolean)[0] || '');
    if (scene.length > 130) scene = clean(scene.slice(0, 130).replace(/\s+\S*$/, ''));
    scene = lower(scene.replace(/^(imagery|scenarios?|for|picture|imagine)\s*[:—-]?\s*/i, ''));
  }
  if (!scene) scene = reg.scene;

  const peopled = PEOPLE.test(scene);
  // An instrumental gets a different visual register, not a different label:
  // the place carries the picture, and nothing in it can be read as lyrics.
  const subject = instrumental
    ? (peopled
      ? 'Shot wide enough that no face is readable'
      : 'Nobody in the frame — the place carries it on its own')
    : (peopled
      ? 'Whoever is in it stays small and turned away'
      : 'One figure, small and turned away, is the only living thing in it');

  const titleClause = named
    ? (instrumental
      ? `Keep the lower third quiet so “${named}” can sit small and centred.`
      : `Leave the upper third open for the title “${named}”.`)
    : 'Leave one calm area where a title can sit.';

  const closing = instrumental
    ? 'Square album cover. No text, no lettering and no legible signage anywhere in it.'
    : 'Square album cover. No text or lettering in the image itself.';

  const light = tempoNote ? `${reg.light}, ${tempoNote}` : reg.light;
  const colour = mood ? `${reg.palette} — ${mood}` : reg.palette;
  const sceneLine = read.images.length
    ? `${cap(scene)}, ${read.images.join(' and ')} somewhere in it`
    : cap(scene);

  // Three sentence shapes, all grammatical whatever the scene turns out to be.
  const shapes = [
    () => [sceneLine, cap(colour), cap(light), subject, cap(texture), titleClause, closing],
    () => [sceneLine, subject, cap(texture), cap(colour), cap(light), titleClause, closing],
    () => [
      `${cap(scene)}, lit by ${lower(light)}`,
      read.images.length ? `${cap(read.images.join(' and '))} somewhere in the frame` : '',
      cap(colour),
      subject,
      cap(texture),
      titleClause,
      closing,
    ],
  ];

  const seed = `${styleText}|${read.images.join(',')}|${named}|${instrumental ? 'i' : 'v'}`;
  const text = shapes[hash(seed) % shapes.length]()
    .map((line) => clean(line))
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .join(' ');

  return {
    text,
    scene,
    palette: reg.palette,
    swatch: reg.swatch,
    light,
    texture,
    images: read.images,
    words: read.words,
    mood,
  };
}

/* ========================================================================== *
 * Constants
 * ========================================================================== */

/**
 * Real renders shipped with the app, each with the caption it came from, so
 * the gallery is populated rather than an empty grid and the range of art
 * directions this screen produces is visible before anything is generated.
 * Their briefs are composed by the same code path as everything else — the
 * examples are the feature demonstrating itself, not hand-written copy.
 */
const SAMPLES = [
  {
    file: 'obsidian-temple', title: 'Obsidian Temple', mode: 'instrumental',
    style: 'Basic Attributes: bpm is 96. key is D, and scale is minor. World Music Electronica / Ritual Downtempo. '
      + 'Global Emotional Progression: reverent and suspended, gathering a ceremonial weight it never puts down. '
      + 'Application Scenarios & Imagery: a rain-slicked temple courtyard before dawn, incense smoke moving low across wet flagstones. '
      + 'Sonics & Production Profile: vast reverberant space, pristine modern capture, wide stereo field.',
  },
  {
    file: 'cover-cinematic', title: 'The Vault', mode: 'instrumental',
    style: 'Basic Attributes: bpm is 72. key is C, and scale is minor. Orchestral Trailer Score. '
      + 'Global Emotional Progression: solemn and withholding, then one enormous reveal. '
      + 'Application Scenarios & Imagery: a black marble hall with a vault door standing open, light pouring out of it across the floor. '
      + 'Sonics & Production Profile: vast cinematic space, pristine capture, enormous low end.',
  },
  {
    file: 'cover-synthwave', title: 'Chrome Dusk', mode: 'instrumental',
    style: 'Basic Attributes: bpm is 118. key is A, and scale is minor. Synthwave / Neon Drive. '
      + 'Global Emotional Progression: restless and forward-leaning, never resolving. '
      + 'Application Scenarios & Imagery: a long empty road seen from inside a moving car, a low neon sun sitting on the tarmac ahead. '
      + 'Sonics & Production Profile: glossy modern digital polish, crisp transients, wide spacious reverb.',
  },
  {
    file: 'cover-lofi', title: 'Rain on the Glass', mode: 'vocal',
    style: 'Basic Attributes: bpm is 76. key is F, and scale is major. Lo-fi Bedroom Pop. '
      + 'Global Emotional Progression: calm the whole way through, gently nostalgic. '
      + 'Application Scenarios & Imagery: a desk under one lamp at night, rain running down the window and the city out of focus behind it. '
      + 'Sonics & Production Profile: warm cassette texture, dusty tape crackle, close and intimate.',
  },
  {
    file: 'cover-blues', title: 'Dry Lake', mode: 'vocal',
    style: 'Basic Attributes: bpm is 92. key is E, and scale is minor. Desert Americana / Slide Guitar. '
      + 'Global Emotional Progression: weary and unhurried, a long ache that never lifts. '
      + 'Application Scenarios & Imagery: a rusted car left on a cracked dry lakebed, dust devils turning on the far horizon. '
      + 'Sonics & Production Profile: warm vintage tape, sun-bleached and worn.',
  },
].map((s) => Object.freeze({
  id: `__sample_${s.file}__`,
  sample: true,
  url: `/demo/${s.file}.png`,
  title: s.title,
  mode: s.mode,
  style: s.style,
  prompt: composeBrief({
    style: s.style,
    lyrics: '',
    title: s.title,
    instrumental: s.mode === 'instrumental',
    useStyle: true,
    useLyrics: false,
    useTitle: true,
  })?.text || '',
  at: 0,
}));

/** Starting points for a cover with no song behind it (SPEC §10c.5). */
const DIRECTIONS = Object.freeze([
  { name: 'Neon rain', line: 'Wet streets, analogue warmth',
    style: 'late-night synth-pop, 104 bpm, minor. Rain-soaked city, analogue warmth, tape saturation.', mode: 'vocal' },
  { name: 'Sun-bleached', line: 'Dry summer, seventies tape',
    style: 'seventies folk rock, 88 bpm, major. Dry summer air, warm vintage tape, close acoustic guitar.', mode: 'vocal' },
  { name: 'Obsidian', line: 'Ritual drums, stone and smoke',
    style: 'world music electronica, 96 bpm, minor. Ritual frame drums, stone and smoke, vast reverb.', mode: 'instrumental' },
  { name: 'Paper and ink', line: 'One voice, winter light',
    style: 'sparse acoustic ballad, 68 bpm, minor. One intimate voice, close mic, clean pristine capture.', mode: 'vocal' },
  { name: 'Chrome dusk', line: 'Long highway, low sun',
    style: 'cinematic synthwave, 118 bpm, minor. Long empty highway, driving arpeggios, wide spacious reverb.', mode: 'instrumental' },
  { name: 'Deep water', line: 'Submerged, slow tide',
    style: 'ambient dub techno, 120 bpm, minor. Submerged chords, slow tide, degraded cassette texture.', mode: 'instrumental' },
]);

const HISTORY_KEY = 'art.history';
const DRAFT_KEY = 'art.draft';
const LIBRARY_KEY = 'library.tracks';
const HISTORY_MAX = 36;

/* ========================================================================== *
 * Mount
 * ========================================================================== */

export async function mount(root, ctx) {
  const { api } = ctx;

  const saved = ctx.storage.get(DRAFT_KEY, null) || {};
  const tracks = loadTracks();

  const state = {
    source: saved.source === 'track' && tracks.length ? 'track' : 'scratch',
    trackId: String(saved.trackId || ''),
    title: String(ctx.route.query.title || saved.title || ''),
    style: String(ctx.route.query.prompt || saved.style || ''),
    lyrics: String(saved.lyrics || ''),
    instrumental: Boolean(saved.instrumental),
    useStyle: saved.useStyle !== false,
    useLyrics: saved.useLyrics !== false,
    useTitle: saved.useTitle !== false,
    prompt: String(saved.prompt || ''),
    edited: Boolean(saved.edited),
    plan: null,
    undo: null,
    health: null,
    busy: false,
    startedAt: 0,
    error: null,
    selected: null,
    history: (ctx.storage.get(HISTORY_KEY, []) || []).filter((c) => c && c.url).slice(0, HISTORY_MAX),
  };

  if (state.source === 'track' && !tracks.some((t) => t.id === state.trackId)) state.source = 'scratch';
  if (!clean(state.style) && state.source === 'scratch') {
    // Never a blank composer: open on a real direction the user can throw away.
    const seed = DIRECTIONS[0];
    state.style = seed.style;
    state.instrumental = seed.mode === 'instrumental';
    if (!clean(state.title)) state.title = seed.name;
  }
  state.selected = state.history[0] || SAMPLES[0];

  function loadTracks() {
    const raw = ctx.storage.get(LIBRARY_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t && (t.title || t.prompt))
      .map((t) => ({
        id: String(t.id || t.filename || ''),
        title: String(t.title || 'Untitled take'),
        prompt: String(t.prompt || ''),
        lyrics: String(t.lyrics || ''),
        instrumental: Boolean(t.isInstrumental),
        duration: Number(t.duration) || 0,
      }))
      .slice(0, 40);
  }

  const page = el('div', { class: 'screen-art' });

  /* ====================================================== COMPOSER ======== */

  const sourceSeg = el('div', { class: 'segment art-source', role: 'group', 'aria-label': 'Where the artwork comes from' },
    [['track', 'From a song'], ['scratch', 'From scratch']].map(([id, label]) => el('button', {
      class: `segment__item${id === state.source ? ' is-active' : ''}`,
      type: 'button', text: label, dataset: { source: id },
      onclick: () => {
        setSource(id);
        if (id === 'track') applyTrack(tracks.find((t) => t.id === state.trackId) || tracks[0]);
        resuggest({ silent: true });
        renderForm();
        persist();
      },
    })));

  function setSource(id) {
    state.source = id;
    for (const item of sourceSeg.children) item.classList.toggle('is-active', item.dataset.source === id);
  }

  const trackBtn = el('button', { class: 'btn art-track', type: 'button' }, [
    ctx.icon('library'),
    el('span', { class: 'art-track__label truncate', text: 'Choose a song' }),
    ctx.icon('chevron-down', 'icon art-track__chev'),
  ]);
  ctx.attachMenu(trackBtn, {
    label: 'Choose a song',
    align: 'start',
    items: () => (tracks.length
      ? [{ heading: true, label: 'Your songs' }, ...tracks.map((t) => ({
        label: t.title,
        icon: t.instrumental ? 'wave' : 'mic',
        note: t.duration ? clock(t.duration) : '',
        onSelect: () => { applyTrack(t); resuggest({ silent: true }); renderForm(); persist(); },
      }))]
      : [{ label: 'Nothing here yet', disabled: true }]),
  });

  const trackEmpty = el('div', { class: 'art-nosongs' }, [
    el('p', { class: 'hint art-nosongs__text', text: 'No songs here yet — write one and it becomes a source for artwork.' }),
    el('button', {
      class: 'btn btn--sm', type: 'button', text: 'Write a song',
      onclick: () => ctx.navigate('create'),
    }),
  ]);

  const titleInput = el('input', {
    class: 'input', type: 'text', maxlength: '120', placeholder: 'Untitled',
    'aria-label': 'Title', value: state.title,
    oninput: () => { state.title = titleInput.value; onChange(); },
  });

  const voiceInput = el('input', {
    type: 'checkbox', checked: state.instrumental,
    onchange: () => { state.instrumental = voiceInput.checked; onChange(); },
  });
  const voiceSwitch = el('label', {
    class: 'switch art-voice',
    title: 'An instrumental is drawn in a different register — no lyrics are read, and nothing readable goes in the picture.',
  }, [
    voiceInput,
    el('span', { class: 'switch__track' }),
    el('span', { class: 'switch__label', text: 'Instrumental' }),
  ]);
  const syncVoice = () => { voiceInput.checked = state.instrumental; };

  const styleInput = el('textarea', {
    class: 'textarea art-style', rows: '3',
    placeholder: 'The music in your own words — genre, tempo, mood, the room it was recorded in.',
    'aria-label': 'The music',
    oninput: () => { state.style = styleInput.value; onChange(); },
  });
  styleInput.value = state.style;

  const lyricsInput = el('textarea', {
    class: 'textarea art-lyrics', rows: '3',
    placeholder: 'Paste the words, if there are any. They are read for imagery only — never printed on the cover.',
    'aria-label': 'Lyrics',
    oninput: () => { state.lyrics = lyricsInput.value; onChange(); },
  });
  lyricsInput.value = state.lyrics;

  const lyricsField = el('div', { class: 'field art-lyricsfield' }, [
    el('label', { class: 'label' }, [
      el('span', { text: 'Lyrics' }),
      el('span', { class: 'label__hint', text: 'optional' }),
    ]),
    lyricsInput,
  ]);

  const toggles = {};
  function toggleChip(key, label, describe) {
    const chip = el('button', {
      class: 'chip art-toggle', type: 'button', text: label,
      'aria-pressed': state[key] ? 'true' : 'false',
      onclick: () => {
        if (chip.disabled) return;
        state[key] = !state[key];
        onChange();
      },
    });
    toggles[key] = { chip, describe };
    return chip;
  }

  const drawNote = el('p', { class: 'hint art-draw__note' });

  const drawOn = el('div', { class: 'art-toggles', role: 'group', 'aria-label': 'What the brief draws on' }, [
    toggleChip('useStyle', 'Musical style', () => {
      // The parsed genre, never a raw slice of the caption's own field names.
      const song = readSong(state.style);
      const said = clean(song.genre).split(/[.]/)[0];
      return said ? `the ${lower(snip(said, 38))}` : '';
    }),
    toggleChip('useLyrics', 'Lyrics', () => {
      const read = readLyrics(state.lyrics);
      if (read.images.length) return read.images.join(' and ');
      return read.words.length ? 'the words, abstractly' : '';
    }),
    toggleChip('useTitle', 'Title', () => (clean(state.title) ? `“${clean(state.title)}”` : '')),
  ]);

  const promptInput = el('textarea', {
    class: 'textarea art-prompt', rows: '5', 'aria-label': 'Art brief',
    placeholder: 'Describe the picture you want.',
    oninput: () => {
      state.prompt = promptInput.value;
      state.edited = true;
      state.undo = null;
      onChange();
    },
  });
  promptInput.value = state.prompt;

  const promptCount = el('span', { class: 'label__hint mono' });

  const resuggestBtn = el('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: () => resuggest({ force: true }),
  }, [ctx.icon('wand'), el('span', { text: 'Suggest again' })]);

  const briefHint = el('p', { class: 'hint art-brief__hint' });

  /* The direction behind the brief, in four lines and three colours. It is
     read from the song, so it keeps telling the truth even after the brief has
     been rewritten by hand. */
  const swatchRow = el('div', { class: 'art-swatch', 'aria-hidden': 'true' });
  const dirRows = el('div', { class: 'art-plan__rows' });
  const planBox = el('div', { class: 'art-plan' }, [
    el('p', { class: 'label art-plan__label' }, [
      el('span', { text: 'Direction' }),
      el('span', { class: 'label__hint', text: 'read from the song' }),
    ]),
    el('div', { class: 'art-plan__body' }, [swatchRow, dirRows]),
  ]);

  const generateBtn = el('button', {
    class: 'btn btn--primary btn--lg btn--block', type: 'button',
    onclick: () => generate(),
  }, [ctx.icon('art'), el('span', { text: 'Generate cover art' })]);

  const generateHint = el('p', { class: 'hint art-foot__hint' });

  const pausedTitle = el('span', { class: 'notice__title', text: 'Artwork is paused' });
  const pausedText = el('p', { class: 'art-paused__text' });
  const pausedNotice = el('div', { class: 'notice notice--warn art-paused', hidden: true }, [
    el('span', { class: 'notice__icon', html: ctx.iconMarkup('alert') }),
    el('div', { class: 'notice__body' }, [
      el('p', { class: 'notice__head' }, [pausedTitle, el('span', { class: 'sev sev--warn', text: 'Paused' })]),
      pausedText,
    ]),
    el('button', {
      class: 'btn btn--sm art-paused__btn', type: 'button', text: 'Check again',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await ctx.refreshHealth(); } finally { btn.disabled = false; }
      },
    }),
  ]);

  const readBox = el('div', { class: 'art-read' });

  function renderRead() {
    const song = readSong(state.style);
    const scene = clean((song.scenes || '').split(/[.;]/)[0] || '');
    const tempo = [song.bpm ? `${song.bpm} bpm` : '', song.key ? `${song.key} ${song.scale || ''}`.trim() : song.scale]
      .filter(Boolean).join(' · ');
    const rows = [
      ['Style', [song.genre, tempo].filter(Boolean).join(' · ') || '—'],
      scene ? ['Imagery', scene] : (song.mood ? ['Mood', clean(song.mood.split(/[.;]/)[0])] : null),
    ].filter(Boolean);
    readBox.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'art-read__row' }, [
      el('span', { class: 'art-read__key', text: k }),
      el('span', { class: 'art-read__val', text: v }),
    ])));
  }

  const sourcePanel = el('section', { class: 'panel art-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Source' }),
      el('span', { class: 'spacer' }),
      voiceSwitch,
    ]),
    el('div', { class: 'panel__body stack' }, [
      el('div', { class: 'field' }, [sourceSeg]),
      trackEmpty,
      el('div', { class: 'field art-stylefield' }, [
        el('label', { class: 'label' }, [
          el('span', { text: 'The music' }),
          el('span', { class: 'label__hint art-stylefield__from' }),
        ]),
        el('div', { class: 'art-trackfield' }, [trackBtn, readBox]),
        styleInput,
      ]),
      lyricsField,
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'Title' }),
        titleInput,
      ]),
    ]),
  ]);

  const briefPanel = el('section', { class: 'panel art-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Art brief' }),
      el('span', { class: 'spacer' }),
      promptCount,
      resuggestBtn,
    ]),
    el('div', { class: 'panel__body' }, [
      el('div', { class: 'field art-draw' }, [
        el('label', { class: 'label', text: 'Draw on' }),
        drawOn,
        drawNote,
      ]),
      promptInput,
      briefHint,
      planBox,
    ]),
  ]);

  const composer = el('aside', { class: 'art-compose dock' }, [
    el('div', { class: 'dock__scroll art-form' }, [sourcePanel, briefPanel]),
    el('div', { class: 'dock__foot dock__foot--fade' }, [
      el('div', { class: 'art-foot' }, [pausedNotice, generateBtn, generateHint]),
    ]),
  ]);

  /* ========================================================= OUTPUT ======= */

  const frame = el('div', { class: 'art-frame' });
  const heroMeta = el('div', { class: 'art-meta' });
  const heroLine = el('div', { class: 'brandline art-hero__line', hidden: true });
  const hero = el('section', { class: 'panel art-hero' }, [
    heroLine,
    el('div', { class: 'art-hero__body' }, [frame, heroMeta]),
  ]);

  const heroMenu = ctx.menu({
    label: 'More actions for this cover',
    items: () => {
      const cover = state.selected;
      if (!cover) return [{ label: 'Nothing selected', disabled: true }];
      return [
        { label: 'Use this brief', icon: 'pencil', onSelect: () => useBrief(cover) },
        cover.sample ? null : { separator: true },
        cover.sample ? null : {
          label: 'Remove from gallery', icon: 'trash', danger: true, onSelect: () => removeCover(cover),
        },
      ].filter(Boolean);
    },
  });

  const galleryCount = el('span', { class: 'art-count mono' });
  const galleryMenu = ctx.menu({
    label: 'Gallery actions',
    items: () => [
      { label: 'Copy the brief', icon: 'copy', disabled: !state.selected?.prompt, onSelect: () => copy(state.selected.prompt, 'Brief copied.') },
      { separator: true },
      {
        label: 'Clear gallery',
        icon: 'trash',
        danger: true,
        disabled: state.history.length === 0,
        onSelect: () => {
          state.history = [];
          ctx.storage.set(HISTORY_KEY, []);
          state.selected = SAMPLES[0];
          renderOutput();
        },
      },
    ],
  });
  const grid = el('div', { class: 'art-grid' });
  const dirGrid = el('div', { class: 'art-dirs' });
  const gallery = el('section', { class: 'panel art-gallery' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Gallery' }),
      galleryCount,
      el('span', { class: 'spacer' }),
      el('div', { class: 'actionbar' }, [galleryMenu]),
    ]),
    el('div', { class: 'panel__body art-gallery__body' }, [
      grid,
      el('div', { class: 'art-dirhead' }, [
        el('span', { class: 'label', text: 'Starting points' }),
        el('span', { class: 'hint', text: 'A direction to build on — it replaces the music description.' }),
      ]),
      dirGrid,
    ]),
  ]);

  const output = el('section', { class: 'art-out' }, [hero, gallery]);

  page.append(composer, output);
  root.append(page);

  /* ========================================================================
   * Derived
   * ===================================================================== */

  const available = () => Boolean(state.health?.coverArtEnabled) && state.health?.status !== 'offline';

  /** Why the button is off, in the customer's words. Empty string when it is on. */
  function blockedReason() {
    const h = state.health;
    if (!h) return 'Checking your studio…';
    if (h.status === 'offline') return h.message;
    if (!h.coverArtEnabled) return 'Artwork can’t be rendered right now.';
    if (!clean(state.prompt) && !clean(state.title) && !clean(state.style)) {
      return 'Write a brief, or pick a starting point, first.';
    }
    return '';
  }

  function requestBody() {
    return {
      prompt: clean(state.prompt),
      title: clean(state.title),
      mode: state.instrumental ? 'instrumental' : 'vocal',
      musicPrompt: clean(state.style),
      aspect_ratio: '1:1',
      n: 1,
    };
  }

  function persist() {
    ctx.storage.set(DRAFT_KEY, {
      source: state.source, trackId: state.trackId, title: state.title,
      style: state.style, lyrics: state.lyrics, instrumental: state.instrumental,
      useStyle: state.useStyle, useLyrics: state.useLyrics, useTitle: state.useTitle,
      prompt: state.prompt, edited: state.edited,
    });
  }

  async function copy(text, message) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(message, { kind: 'success' });
    } catch (err) {
      ctx.toast(`The clipboard refused the copy: ${err?.message || err}`, { kind: 'warn' });
    }
  }

  function applyTrack(track) {
    if (!track) return;
    state.trackId = track.id;
    state.title = track.title;
    state.style = track.prompt;
    state.lyrics = track.lyrics;
    state.instrumental = track.instrumental;
    titleInput.value = state.title;
    styleInput.value = state.style;
    lyricsInput.value = state.lyrics;
    syncVoice();
  }

  function currentPlan() {
    return composeBrief({
      style: state.style,
      lyrics: state.lyrics,
      title: state.title,
      instrumental: state.instrumental,
      useStyle: state.useStyle,
      useLyrics: state.useLyrics,
      useTitle: state.useTitle,
    });
  }

  /**
   * Recompose the brief.
   *
   * A hand-edited brief is never silently overwritten (SPEC §10c.3): live
   * recomposition stops the moment the customer types, and `force` — the
   * explicit "Suggest again" — is the only thing that replaces their words.
   * Even then it is undoable from the toast.
   */
  function resuggest({ force = false, silent = false } = {}) {
    const plan = currentPlan();
    state.plan = plan;
    if (!plan) return;
    if (state.edited && !force) return;
    const previous = state.prompt;
    state.prompt = plan.text;
    state.edited = false;
    promptInput.value = plan.text;
    if (force && !silent) {
      const changed = clean(previous) && clean(previous) !== clean(plan.text);
      state.undo = changed ? previous : null;
      ctx.toast('Brief rewritten from the song.', {
        kind: 'success',
        key: 'art-resuggest',
        actions: changed
          ? [{
            label: 'Undo',
            onClick: () => {
              state.prompt = previous;
              state.edited = true;
              state.undo = null;
              promptInput.value = previous;
              onChange();
            },
          }]
          : [],
      });
    }
  }

  /* ========================================================================
   * Render
   * ===================================================================== */

  function renderPlan() {
    const plan = state.plan;
    planBox.hidden = !plan;
    if (!plan) return;

    swatchRow.replaceChildren(...plan.swatch.map((hex) => el('span', {
      class: 'art-swatch__chip', style: `background:${hex}`,
    })));

    const rows = [
      ['Palette', plan.palette],
      ['Light', plan.light],
      ['Finish', plan.texture],
    ];
    dirRows.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'art-plan__row' }, [
      el('span', { class: 'art-plan__key', text: k }),
      el('span', { class: 'art-plan__val', text: cap(v) }),
    ])));
  }

  function renderForm() {
    const onTrack = state.source === 'track';
    sourcePanel.querySelector('.art-trackfield').hidden = !onTrack || !tracks.length;
    trackEmpty.hidden = !onTrack || tracks.length > 0;

    const track = tracks.find((t) => t.id === state.trackId);
    const reading = onTrack && Boolean(track);
    trackBtn.querySelector('.art-track__label').textContent = track ? track.title : 'Choose a song';
    sourcePanel.querySelector('.art-stylefield__from').textContent = reading ? `read from “${track.title}”` : '';
    styleInput.hidden = reading;
    readBox.hidden = !reading;
    if (reading) renderRead();
    // On a chosen song the words come with it; from scratch they are typed.
    lyricsField.hidden = reading || state.instrumental;

    const has = {
      useStyle: Boolean(clean(state.style)),
      useLyrics: !state.instrumental && Boolean(clean(state.lyrics)),
      useTitle: Boolean(clean(state.title)),
    };
    const why = {
      useStyle: 'Describe the music first',
      useLyrics: state.instrumental ? 'This one has no words' : 'Add the words first',
      useTitle: 'Give it a title first',
    };
    const parts = [];
    for (const [key, t] of Object.entries(toggles)) {
      const on = has[key] && state[key];
      t.chip.disabled = !has[key];
      t.chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.chip.title = has[key] ? '' : why[key];
      if (on) {
        const said = t.describe();
        if (said) parts.push(said);
      }
    }
    drawNote.textContent = parts.length
      ? `Drawing on ${parts.join(' · ')}`
      : 'Nothing selected — the brief is yours to write.';

    const chars = clean(state.prompt).length;
    promptCount.textContent = chars ? `${chars} characters` : '';
    resuggestBtn.disabled = !state.plan;
    briefHint.textContent = state.edited
      ? 'Your words win — this brief no longer follows the toggles. Suggest again to rebuild it.'
      : 'It rewrites itself as the source changes. Edit it and it stops, and your version is kept.';

    renderPlan();

    const reason = blockedReason();
    const paused = Boolean(state.health) && !available();
    generateBtn.disabled = state.busy || Boolean(reason);
    generateBtn.querySelector('span').textContent = state.busy ? 'Making artwork…' : 'Generate cover art';

    pausedNotice.hidden = !paused;
    if (paused) {
      const offline = state.health.status === 'offline';
      pausedTitle.textContent = offline ? 'Your studio is not answering' : 'Artwork is paused';
      pausedText.textContent = offline
        ? `${state.health.message} Your brief is saved here.`
        : 'Nothing can be rendered right now. Your brief is saved, and this switches back on by itself.';
    }
    generateHint.hidden = paused;
    generateHint.textContent = paused ? '' : (reason
      || 'One square cover, about a minute. It is saved to the gallery below.');
  }

  function renderFrame() {
    frame.replaceChildren();
    heroLine.hidden = !state.busy;

    if (state.busy) {
      frame.dataset.mode = 'busy';
      const started = state.startedAt || Date.now();
      const time = el('span', { class: 'art-frame__time mono', text: clock((Date.now() - started) / 1000) });
      clearInterval(tick);
      tick = setInterval(() => { time.textContent = clock((Date.now() - started) / 1000); }, 1000);
      frame.append(el('div', { class: 'art-frame__state' }, [
        ctx.icon('spinner', 'icon spinner art-frame__spin'),
        el('p', { class: 'art-frame__title', text: 'Making your artwork' }),
        time,
      ]));
      return;
    }

    if (state.error) {
      frame.dataset.mode = 'error';
      frame.append(el('div', { class: 'art-frame__state' }, [
        el('span', { class: 'art-frame__icon', html: ctx.iconMarkup('alert') }),
        el('p', { class: 'art-frame__title', text: 'That render stopped short' }),
      ]));
      return;
    }

    const cover = state.selected;
    if (cover?.url) {
      frame.dataset.mode = 'image';
      frame.append(
        el('img', {
          class: 'art-frame__img',
          src: api.mediaUrl(cover.url),
          alt: cover.title ? `Cover art for ${cover.title}` : 'Cover art',
          onerror: () => {
            frame.dataset.mode = 'error';
            frame.replaceChildren(el('div', { class: 'art-frame__state' }, [
              el('span', { class: 'art-frame__icon', html: ctx.iconMarkup('alert') }),
              el('p', { class: 'art-frame__title', text: 'That image is no longer on disk' }),
            ]));
          },
        }),
        cover.sample ? el('span', { class: 'art-tag', text: 'Example' }) : null,
      );
      return;
    }

    frame.dataset.mode = 'idle';
    frame.append(el('div', { class: 'art-frame__state' }, [
      el('span', { class: 'art-frame__icon', html: ctx.iconMarkup('art') }),
      el('p', { class: 'art-frame__title', text: 'Your cover lands here' }),
    ]));
  }

  function briefBlock(text, label = 'Art brief') {
    return el('div', { class: 'art-brief' }, [
      el('p', { class: 'label', text: label }),
      // The clamp lives on the inner <p> and the padding on the box: a clamped
      // line must never show through a padded edge as a half-cut sliver.
      el('div', { class: 'art-brief__box' }, [el('p', { class: 'art-brief__text', text })]),
    ]);
  }

  function renderMeta() {
    heroMeta.replaceChildren();

    if (state.busy) {
      heroMeta.append(
        el('p', { class: 'art-meta__head' }, [
          el('span', { class: 'art-meta__eyebrow', text: 'Working' }),
          el('span', { class: 'sev sev--live', text: 'Rendering' }),
        ]),
        el('h2', { class: 'art-meta__title', text: clean(state.title) || 'Untitled' }),
        el('p', { class: 'art-meta__lead', text: 'Painting the brief below. You can leave this screen — it keeps going.' }),
        briefBlock(clean(state.prompt), 'Brief in progress'),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn btn--sm', type: 'button', text: 'Cancel',
            onclick: () => inFlight?.abort(new DOMException('Cancelled', 'AbortError')),
          }),
        ]),
      );
      return;
    }

    if (state.error) {
      heroMeta.append(
        el('p', { class: 'art-meta__head' }, [
          el('span', { class: 'art-meta__eyebrow', text: 'Not finished' }),
          el('span', { class: 'sev sev--error', text: 'Error' }),
        ]),
        el('h2', { class: 'art-meta__title', text: 'This one was turned down' }),
        el('p', { class: 'art-meta__lead', text: 'Nothing was saved and your brief is untouched. Here is exactly what came back, in its own words:' }),
        el('pre', { class: 'art-verbatim mono', text: state.error.text }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn--sm btn--strong', type: 'button', text: 'Try again', onclick: () => generate() }),
          el('button', {
            class: 'btn btn--sm', type: 'button', text: 'Dismiss',
            onclick: () => { state.error = null; renderOutput(); },
          }),
        ]),
      );
      return;
    }

    const cover = state.selected;
    if (!cover) {
      heroMeta.append(
        el('p', { class: 'art-meta__head' }, [el('span', { class: 'art-meta__eyebrow', text: 'Ready' })]),
        el('h2', { class: 'art-meta__title', text: 'Nothing made yet' }),
        el('p', { class: 'art-meta__lead', text: 'Compose a brief on the left and generate — the result lands here and in the gallery.' }),
      );
      return;
    }

    const url = api.mediaUrl(cover.url);
    const chips = el('div', { class: 'art-chips' }, [
      el('span', { class: 'chip art-chip', text: cover.mode === 'instrumental' ? 'Instrumental' : 'With vocals' }),
      el('span', { class: 'chip art-chip', text: 'Square' }),
      cover.at ? el('span', { class: 'chip art-chip', text: relTime(cover.at) }) : null,
    ]);

    const actions = el('div', { class: 'actionbar art-actions' }, [
      cover.sample ? null : el('a', {
        class: 'actionchip', href: url, download: cover.filename || '',
        'aria-label': 'Download this cover', title: 'Download',
      }, [ctx.icon('download')]),
      el('a', {
        class: 'actionchip', href: url, target: '_blank', rel: 'noopener',
        'aria-label': 'Open the full size image', title: 'Open full size',
      }, [ctx.icon('external')]),
      el('button', {
        class: 'actionchip', type: 'button', 'aria-label': 'Copy the brief', title: 'Copy the brief',
        onclick: () => copy(cover.prompt || '', 'Brief copied.'),
      }, [ctx.icon('copy')]),
      el('span', { class: 'actionbar__sep' }),
      heroMenu,
    ]);

    heroMeta.append(
      el('p', { class: 'art-meta__head' }, [
        el('span', { class: 'art-meta__eyebrow', text: cover.sample ? 'Example' : 'Latest cover' }),
      ]),
      el('h2', { class: 'art-meta__title truncate', text: cover.title || 'Untitled' }),
      chips,
      cover.sample
        ? el('p', {
          class: 'art-meta__lead',
          text: 'An example, shown with the brief that directs it. Yours takes this spot the moment you generate one.',
        })
        : null,
      briefBlock(cover.prompt || 'No brief was recorded for this one.'),
      actions,
    );
  }

  function useBrief(cover) {
    if (!cover?.prompt) return;
    state.prompt = cover.prompt;
    state.edited = true;
    if (cover.style) { state.style = cover.style; styleInput.value = cover.style; }
    if (cover.title) { state.title = cover.title; titleInput.value = cover.title; }
    state.instrumental = cover.mode === 'instrumental';
    syncVoice();
    promptInput.value = state.prompt;
    onChange();
    promptInput.focus();
    ctx.toast('Brief loaded into the composer.', { kind: 'success' });
  }

  function removeCover(cover) {
    state.history = state.history.filter((c) => c.id !== cover.id);
    ctx.storage.set(HISTORY_KEY, state.history);
    if (state.selected?.id === cover.id) state.selected = state.history[0] || SAMPLES[0];
    renderOutput();
    ctx.toast('Removed from the gallery.', { kind: 'info' });
  }

  function renderGallery() {
    const items = [...state.history, ...SAMPLES];
    galleryCount.textContent = state.history.length
      ? `${state.history.length} cover${state.history.length === 1 ? '' : 's'}`
      : `${SAMPLES.length} examples`;

    grid.replaceChildren();
    // Before anything has been generated every tile is an example and the
    // count says so, so the per-tile tag would be five copies of one word. It
    // appears the moment there is something of the customer's to tell apart.
    const tagSamples = state.history.length > 0;
    for (const item of items) {
      const active = state.selected?.id === item.id && !state.busy && !state.error;
      grid.append(el('button', {
        class: `art-tile${active ? ' is-active' : ''}`,
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        title: item.title || 'Untitled',
        onclick: () => {
          state.selected = item;
          state.error = null;
          renderOutput();
        },
      }, [
        el('span', { class: 'art-tile__frame' }, [
          el('img', { src: api.mediaUrl(item.url), alt: '', loading: 'lazy' }),
          item.sample && tagSamples ? el('span', { class: 'art-tag art-tag--sm', text: 'Example' }) : null,
        ]),
        el('span', { class: 'art-tile__label truncate', text: item.title || 'Untitled' }),
      ]));
    }

    // Terminal card, on the same rhythm as the tiles — the grid ends on purpose.
    grid.append(el('button', {
      class: 'art-tile art-tile--new',
      type: 'button',
      title: 'Start a new cover',
      onclick: () => { promptInput.focus(); promptInput.select(); },
    }, [
      el('span', { class: 'art-tile__frame art-tile__frame--new' }, [
        el('span', { class: 'art-tile__plus', html: ctx.iconMarkup('plus') }),
      ]),
      el('span', { class: 'art-tile__label truncate', text: 'New cover' }),
    ]));
  }

  function renderDirections() {
    dirGrid.replaceChildren();
    for (const dir of DIRECTIONS) {
      const reg = pick(REGISTERS, dir.style) || FALLBACK_REGISTER;
      dirGrid.append(el('button', {
        class: 'art-dir', type: 'button',
        onclick: () => {
          setSource('scratch');
          state.style = dir.style;
          state.instrumental = dir.mode === 'instrumental';
          state.lyrics = '';
          lyricsInput.value = '';
          // Only ever replace a working title, never one the user typed.
          if (!clean(state.title) || DIRECTIONS.some((d) => d.name === clean(state.title))) {
            state.title = dir.name;
            titleInput.value = dir.name;
          }
          styleInput.value = dir.style;
          syncVoice();
          state.edited = false;
          resuggest();
          renderForm();
          persist();
          ctx.toast(`“${dir.name}” loaded into the brief.`, { kind: 'success', key: 'art-direction' });
        },
      }, [
        el('span', { class: 'art-dir__swatch', 'aria-hidden': 'true' },
          reg.swatch.map((hex) => el('span', { class: 'art-dir__chip', style: `background:${hex}` }))),
        el('span', { class: 'art-dir__name', text: dir.name }),
        el('span', { class: 'art-dir__line', text: dir.line }),
      ]));
    }
  }

  function renderOutput() {
    renderFrame();
    renderMeta();
    renderGallery();
  }

  function onChange() {
    persist();
    resuggest();
    renderForm();
  }

  /* ========================================================================
   * The one real call
   * ===================================================================== */

  let inFlight = null;
  let tick = null;

  async function generate() {
    if (state.busy || blockedReason()) return;
    state.busy = true;
    state.startedAt = Date.now();
    state.error = null;
    inFlight = new AbortController();
    renderForm();
    renderOutput();

    const body = requestBody();
    try {
      const result = await api.coverArt(body, { signal: inFlight.signal });
      const cover = result?.cover;
      if (!cover?.url) {
        throw new api.ApiError('Your studio reported success but sent no artwork back.', { status: 200 });
      }
      const record = {
        id: cover.id || cover.filename || String(Date.now()),
        filename: cover.filename || '',
        url: cover.url,
        prompt: cover.prompt || body.prompt,
        title: body.title || 'Untitled',
        style: body.musicPrompt,
        mode: body.mode,
        at: Date.now(),
      };
      state.selected = record;
      state.history = [record, ...state.history.filter((c) => c.id !== record.id)].slice(0, HISTORY_MAX);
      ctx.storage.set(HISTORY_KEY, state.history);
      ctx.bus.emit('art:new', { cover: record, meta: { ...body } });
      ctx.toast(`“${record.title}” is ready.`, { kind: 'success', title: 'Cover art' });
    } catch (err) {
      if (err?.name === 'AbortError') {
        ctx.toast('Artwork cancelled.', { kind: 'info' });
      } else {
        state.error = { status: err?.status ?? 0, text: api.errorText(err) };
        ctx.toast('Nothing was saved. The reason is on the cover panel.', {
          kind: 'error', key: 'art-error', title: 'The artwork did not render',
        });
        await ctx.refreshHealth();
      }
    } finally {
      clearInterval(tick);
      tick = null;
      inFlight = null;
      state.busy = false;
      renderForm();
      renderOutput();
    }
  }

  /* ------------------------------------------------------- bus + health -- */

  ctx.bus.on('track:new', (payload) => {
    const m = payload?.meta || {};
    const title = clean(m.title);
    const prompt = clean(m.prompt);
    if (!title && !prompt) return;
    const id = String(payload?.track?.id || payload?.track?.filename || Date.now());
    if (!tracks.some((t) => t.id === id)) {
      tracks.unshift({
        id,
        title: title || 'Untitled take',
        prompt,
        lyrics: String(m.lyrics || ''),
        instrumental: Boolean(m.isInstrumental),
        duration: Number(m.duration) || 0,
      });
    }
    renderForm();
    ctx.toast(`“${title || 'Your new take'}” is in the studio. Make artwork for it?`, {
      kind: 'info',
      key: 'art-newtrack',
      action: {
        label: 'Use it',
        onClick: () => {
          setSource('track');
          applyTrack(tracks[0]);
          state.edited = false;
          resuggest();
          renderForm();
          persist();
        },
      },
    });
  });

  ctx.onHealth((h) => {
    state.health = h;
    renderForm();
  });

  resuggest({ silent: true });
  renderForm();
  renderDirections();
  renderOutput();

  return () => {
    clearInterval(tick);
    inFlight?.abort(new DOMException('Screen left', 'AbortError'));
    persist();
  };
}
