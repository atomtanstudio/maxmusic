/**
 * Cover art — album artwork for the songs this studio makes.
 *
 * The screen composes an art brief on the client (deterministic, no model call)
 * and renders it into a square cover. Everything the customer sees is in
 * customer language: no hosts, no endpoints, no provider names, no file sizes.
 * Technical detail appears in exactly one place — the transient error state,
 * where the server's own words are shown verbatim so a real failure is
 * actionable rather than mysterious.
 *
 * Layout, top to bottom of the right column:
 *   hero      — the selected cover, its brief and its actions
 *   gallery   — every cover this browser has made, plus starting points
 *
 * Bus:
 *   in  `track:new`   — a finished song becomes a source for artwork
 *   out `covers:new`  — `{ cover, meta }` once a real cover comes back
 *
 * Owned by the covers lane: this file + public/css/screens/covers.css.
 *
 * @module screens/covers
 */

export const meta = {
  title: 'Cover art',
  subtitle: 'Artwork for the songs you make',
  css: '/css/screens/covers.css',
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
 * Everything the art brief can draw on, pulled out of one song.
 * Works on a full structured caption and degrades to plain prose.
 */
function readSong(captionText) {
  const parts = splitCaption(captionText);
  const raw = clean(captionText);
  const attrs = parts['Basic Attributes'] || '';

  const bpm = Number((raw.match(/bpm\s*is\s*(\d{2,3})/i) || [])[1]) || 0;
  const key = (raw.match(/key\s*is\s*([A-G][#b]?)\b/i) || [])[1] || '';
  const scale = /\bminor\b/i.test(attrs || raw) ? 'minor' : /\bmajor\b/i.test(attrs || raw) ? 'major' : '';

  let genre = '';
  if (attrs) {
    genre = attrs
      .split('.')
      .map((s) => clean(s))
      .filter((s) => s && !/^bpm is/i.test(s) && !/^key is/i.test(s) && !/scale is/i.test(s))
      .join(', ');
  }
  if (!genre) genre = raw.split(/[.\n]/).map(clean).filter(Boolean)[0] || '';

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
oh yeah ooh whoa hey na la mmm gonna wanna gotta cause till em`.split(/\s+/));

/** Concrete, repeatable imagery from lyrics. Never the lines themselves. */
function readLyrics(text) {
  const body = String(text || '')
    .split('\n')
    .filter((line) => !/^\s*\[[^\]]*\]\s*$/.test(line))
    .join('\n');
  const counts = new Map();
  for (const word of body.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []) {
    const w = word.replace(/'s$/, '');
    if (STOP.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const motifs = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .filter(([, n]) => n >= 2)
    .slice(0, 3)
    .map(([w]) => w);
  // fall back to the longest distinctive words when nothing repeats
  if (motifs.length < 2) {
    const spare = [...counts.keys()].sort((a, b) => b.length - a.length).slice(0, 3);
    for (const w of spare) if (!motifs.includes(w) && motifs.length < 3) motifs.push(w);
  }
  return motifs;
}

/* ========================================================================== *
 * Art direction lexicons
 *
 * These turn what a song *is* into what a picture *looks like*. Two songs with
 * different genres, keys, tempos and imagery come out of here as two different
 * art directions, not the same sentence with a word swapped.
 * ========================================================================== */

/* Most specific first: strong imagery words beat a genre word, and a genre word
   beats the catch-all. "world music electronica" is ritual, not neon. */
const REGISTERS = [
  {
    match: /(highway|motorway|open road|road trip|headlight|freeway)/i,
    scene: 'an empty highway at last light, the road running out to a flat horizon',
    palette: 'sodium amber over deep blue dusk, the tarmac almost black',
    light: 'a low sun flaring across glass',
  },
  {
    match: /(ocean|the sea|tide|underwater|submerged|shoreline|harbour|harbor)/i,
    scene: 'a still sea under low cloud, the horizon barely separating water from sky',
    palette: 'deep teal, pewter and one thin band of silver',
    light: 'flat overcast light that casts no shadow',
  },
  {
    match: /(world music|tribal|ritual|gamelan|afro|ethnic|eastern|shamanic)/i,
    scene: 'a rain-slicked stone courtyard, incense smoke drifting low over the flagstones',
    palette: 'wet basalt, ember gold and cold blue shadow',
    light: 'first light breaking under heavy cloud',
  },
  {
    match: /(orchestral|classical|symphon|strings|choral|film score|trailer music)/i,
    scene: 'a vast stone interior with a single shaft of light falling across the floor',
    palette: 'slate grey and deep sea blue broken by one band of gold',
    light: 'one narrow shaft cutting through suspended dust',
  },
  {
    match: /(metal|hardcore|punk|industrial|noise|grunge|thrash|sludge)/i,
    scene: 'a corroded steel structure shot from below against a bruised sky',
    palette: 'oxidised iron, ash white and one stripe of alarm red',
    light: 'flat overcast glare with blown highlights',
  },
  {
    match: /(jazz|blues|lounge|swing|bossa|latin|samba|big band)/i,
    scene: 'a near-empty room after the set, one glass and a chair pushed back',
    palette: 'tobacco brown, brass and deep green shadow',
    light: 'a warm practical lamp just out of frame',
  },
  {
    match: /(hip ?hop|trap|rap|drill|boom ?bap|r&b|rnb|soul|funk|neo-?soul)/i,
    scene: 'a lit stairwell at street level, chain-link and steam coming off the pavement',
    palette: 'warm sodium orange against cold concrete grey',
    light: 'a single overhead bulb with hard falloff',
  },
  {
    match: /(folk|acoustic|country|americana|bluegrass|singer-?songwriter)/i,
    scene: 'a dry field at the end of the afternoon, one chair turned away from the road',
    palette: 'sun-bleached ochre, bone white and washed-out denim',
    light: 'low sideways daylight an hour before dusk',
  },
  {
    match: /(ambient|drone|downtempo|chillout|meditative|new ?age|shoegaze|dream ?pop)/i,
    scene: 'a shoreline dissolving into fog, the horizon barely there',
    palette: 'pale grey-green, oyster and a faint rose bloom',
    light: 'flat diffused light, the edges falling away into haze',
  },
  {
    match: /(synth-?wave|synth-?pop|synthpop|techno|\bhouse\b|club|rave|\bedm\b|dance|hyperpop|trance|\belectro\b|\belectronic\b)/i,
    scene: 'a wet city street after midnight, one figure crossing an empty junction',
    palette: 'electric cyan and deep magenta bleeding across black asphalt',
    light: 'hard neon signage doubled in the puddles',
  },
  {
    match: /(lo-?fi|bedroom|indie|alt|alternative|pop ?rock|rock)/i,
    scene: 'a bedroom window at night with the city out of focus behind the glass',
    palette: 'dusty teal, faded red and warm lamp yellow',
    light: 'one window as the only light in the room',
  },
];

const FALLBACK_REGISTER = {
  scene: 'an empty road at night, headlights sweeping past the frame',
  palette: 'deep indigo, sodium amber and a cold white edge',
  light: 'one moving light source and long shadows',
};

const MOODS = [
  { match: /(joy|uplift|euphor|triumph|soar|bright|celebrat|hopeful)/i, note: 'the whole frame lifting toward the light' },
  { match: /(melanchol|wistful|nostalg|bitters?weet|longing|ache|yearn)/i, note: 'held a beat too long, gentle and unresolved' },
  { match: /(tense|urgent|driving|restless|anxious|frantic|relentless)/i, note: 'framed tight and slightly off balance' },
  { match: /(calm|serene|still|gentle|tender|intimate|warm|soft)/i, note: 'quiet, close, almost nothing moving' },
  { match: /(dark|brooding|ominous|menacing|heavy|grim|haunt)/i, note: 'most of the frame given over to shadow' },
  { match: /(defiant|angry|fierce|raw|rebell|furious)/i, note: 'confrontational, the subject filling the frame' },
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

const pick = (list, text, fallback = null) => list.find((row) => row.match.test(text)) || fallback;

/**
 * Compose the art brief. Deterministic and client-side — the same song and the
 * same toggles always produce the same words, and two different songs produce
 * two genuinely different directions.
 */
function composeBrief({ style, lyrics, title, instrumental, useStyle, useLyrics, useTitle }) {
  const styleText = useStyle ? clean(style) : '';
  const song = readSong(styleText);
  const motifs = useLyrics && !instrumental ? readLyrics(lyrics) : [];
  const named = useTitle ? clean(title) : '';

  const source = `${styleText}|${motifs.join(',')}|${named}|${instrumental ? 'i' : 'v'}`;
  if (!styleText && !motifs.length && !named) return '';

  const reg = pick(REGISTERS, `${song.genre} ${song.raw}`, FALLBACK_REGISTER);
  const moodNote = pick(MOODS, `${song.mood} ${song.raw}`)?.note
    || (song.scale === 'minor' ? 'cool and unresolved' : song.scale === 'major' ? 'open and warm' : '');
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

  const motifClause = motifs.length
    ? `${motifs.slice(0, 3).join(', ')} recurring as objects in the frame`
    : '';

  const titleClause = named
    ? (instrumental
      ? `Hold the lower third clear so “${named}” can be set small and centred.`
      : `Leave the upper third open for the title “${named}”.`)
    : 'Leave one clear area for a title.';

  const closing = instrumental
    ? 'Square album cover, wide and centred, no text and no lettering in the image.'
    : 'Square album cover, no text and no lettering in the image.';

  const light = tempoNote ? `${reg.light}, ${tempoNote}` : reg.light;
  const paletteClause = moodNote ? `${reg.palette} — ${moodNote}` : reg.palette;

  // Three sentence shapes, all grammatical whatever the scene turns out to be.
  const shapes = [
    () => [
      cap(scene) + (motifClause ? `, ${motifClause}` : ''),
      cap(paletteClause),
      cap(light),
      cap(texture),
      titleClause,
      closing,
    ],
    () => [
      cap(scene),
      cap(texture),
      cap(paletteClause),
      motifClause ? cap(motifClause) : '',
      cap(light),
      titleClause,
      closing,
    ],
    () => [
      `${cap(scene)}, lit by ${lower(light)}`,
      cap(paletteClause),
      motifClause ? `${cap(motifClause)}, ${lower(texture)}` : cap(texture),
      titleClause,
      closing,
    ],
  ];

  const shape = shapes[hash(source) % shapes.length];
  return shape()
    .map((line) => clean(line))
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .join(' ');
}

/* ========================================================================== *
 * Constants
 * ========================================================================== */

/** A real render, shipped with the app, so the frame is never a grey box. */
const SAMPLE = Object.freeze({
  id: '__sample__',
  sample: true,
  url: '/demo/obsidian-temple.png',
  title: 'Obsidian Temple',
  mode: 'instrumental',
  style: 'world music electronica, ritual drums, deep frame percussion, stone and smoke, 96 bpm, minor',
  prompt: 'A rain-slicked stone courtyard, incense smoke drifting low over the flagstones. '
    + 'Wet basalt, ember gold and cold blue shadow — most of the frame given over to shadow. '
    + 'First light breaking under heavy cloud, a slow drift. '
    + 'Clean large-format capture, no grain, deep shadow detail. '
    + 'Hold the lower third clear so the title can be set small and centred. '
    + 'Square album cover, wide and centred, no text and no lettering in the image.',
  at: 0,
});

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

const HISTORY_KEY = 'covers.history';
const DRAFT_KEY = 'covers.draft';
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
  state.selected = state.history[0] || SAMPLE;

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

  const page = el('div', { class: 'screen-covers' });

  /* ====================================================== COMPOSER ======== */

  const sourceSeg = el('div', { class: 'segment cov-source', role: 'group', 'aria-label': 'Where the artwork comes from' },
    [['track', 'From a song'], ['scratch', 'From scratch']].map(([id, label]) => el('button', {
      class: `segment__item${id === state.source ? ' is-active' : ''}`,
      type: 'button', text: label, dataset: { source: id },
      onclick: () => {
        state.source = id;
        for (const item of sourceSeg.children) item.classList.toggle('is-active', item.dataset.source === id);
        if (id === 'track') applyTrack(tracks.find((t) => t.id === state.trackId) || tracks[0]);
        resuggest({ silent: true });
        renderForm();
      },
    })));

  const trackBtn = el('button', { class: 'btn cov-track', type: 'button' }, [
    ctx.icon('library'),
    el('span', { class: 'cov-track__label truncate', text: 'Choose a song' }),
    ctx.icon('chevron-down', 'icon cov-track__chev'),
  ]);
  ctx.attachMenu(trackBtn, {
    label: 'Choose a song',
    align: 'start',
    items: () => (tracks.length
      ? [{ heading: true, label: 'Your songs' }, ...tracks.map((t) => ({
        label: t.title,
        icon: t.instrumental ? 'wave' : 'mic',
        note: t.duration ? clock(t.duration) : '',
        onSelect: () => { applyTrack(t); resuggest({ silent: true }); renderForm(); },
      }))]
      : [{ label: 'Nothing here yet', disabled: true }]),
  });

  const trackEmpty = el('div', { class: 'cov-nosongs' }, [
    el('p', { class: 'hint cov-nosongs__text', text: 'No songs here yet — write one and it becomes a source for artwork.' }),
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
  const voiceSwitch = el('label', { class: 'switch cov-voice' }, [
    voiceInput,
    el('span', { class: 'switch__track' }),
    el('span', { class: 'switch__label', text: 'Instrumental — no vocal on this track' }),
  ]);
  const syncVoice = () => { voiceInput.checked = state.instrumental; };

  const styleInput = el('textarea', {
    class: 'textarea cov-style', rows: '3',
    placeholder: 'The music in your own words — genre, tempo, mood, the room it was recorded in.',
    'aria-label': 'The music',
    oninput: () => { state.style = styleInput.value; onChange(); },
  });
  styleInput.value = state.style;

  const toggles = {};
  function toggleChip(key, label, describe) {
    const chip = el('button', {
      class: 'chip cov-toggle', type: 'button', text: label,
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

  const drawNote = el('p', { class: 'hint cov-draw__note' });

  const drawOn = el('div', { class: 'cov-toggles', role: 'group', 'aria-label': 'What the brief draws on' }, [
    toggleChip('useStyle', 'Musical style', () => {
      // The parsed genre, never a raw slice of the caption's own field names.
      const song = readSong(state.style);
      const said = clean(song.genre).split(/[,.]/)[0];
      return said ? `style: ${said.slice(0, 44)}` : '';
    }),
    toggleChip('useLyrics', 'Lyrics', () => {
      const motifs = readLyrics(state.lyrics);
      return motifs.length ? `words: ${motifs.join(', ')}` : '';
    }),
    toggleChip('useTitle', 'Title', () => (clean(state.title) ? `title: “${clean(state.title)}”` : '')),
  ]);

  const promptInput = el('textarea', {
    class: 'textarea cov-prompt', rows: '5', 'aria-label': 'Art brief',
    placeholder: 'Describe the picture you want.',
    oninput: () => {
      state.prompt = promptInput.value;
      state.edited = true;
      onChange();
    },
  });
  promptInput.value = state.prompt;

  const promptCount = el('span', { class: 'label__hint mono' });

  const resuggestBtn = el('button', {
    class: 'btn btn--sm', type: 'button',
    title: 'Rewrite the brief from the song',
    onclick: () => resuggest({ force: true }),
  }, [ctx.icon('wand'), el('span', { text: 'Re-suggest' })]);

  const generateBtn = el('button', {
    class: 'btn btn--primary btn--lg btn--block', type: 'button',
    onclick: () => generate(),
  }, [ctx.icon('covers'), el('span', { text: 'Generate cover art' })]);

  const generateHint = el('p', { class: 'hint cov-foot__hint' });

  const readBox = el('div', { class: 'cov-read' });

  function renderRead() {
    const song = readSong(state.style);
    const scene = clean((song.scenes || '').split(/[.;]/)[0] || '');
    const tempo = [song.bpm ? `${song.bpm} bpm` : '', song.key ? `${song.key} ${song.scale || ''}`.trim() : song.scale]
      .filter(Boolean).join(' · ');
    const rows = [
      ['Style', [song.genre, tempo].filter(Boolean).join(' · ') || '—'],
      scene ? ['Imagery', scene] : (song.mood ? ['Mood', clean(song.mood.split(/[.;]/)[0])] : null),
    ].filter(Boolean);
    readBox.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'cov-read__row' }, [
      el('span', { class: 'cov-read__key', text: k }),
      el('span', { class: 'cov-read__val', text: v }),
    ])));
  }

  const sourcePanel = el('section', { class: 'panel cov-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Source' }),
    ]),
    el('div', { class: 'panel__body stack' }, [
      el('div', { class: 'field' }, [sourceSeg]),
      trackEmpty,
      el('div', { class: 'field cov-stylefield' }, [
        el('label', { class: 'label' }, [
          el('span', { text: 'The music' }),
          el('span', { class: 'label__hint cov-stylefield__from' }),
        ]),
        el('div', { class: 'cov-trackfield' }, [trackBtn, readBox]),
        styleInput,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'label', text: 'Title' }),
        titleInput,
      ]),
      voiceSwitch,
    ]),
  ]);

  const briefPanel = el('section', { class: 'panel cov-panel' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Art brief' }),
      el('span', { class: 'spacer' }),
      promptCount,
      resuggestBtn,
    ]),
    el('div', { class: 'panel__body' }, [
      el('div', { class: 'field cov-draw' }, [
        el('label', { class: 'label', text: 'Draw on' }),
        drawOn,
        drawNote,
      ]),
      promptInput,
      el('p', { class: 'hint cov-brief__hint', text: 'Edit it freely — this is the text the artwork is made from.' }),
    ]),
  ]);

  const composer = el('aside', { class: 'cov-compose dock' }, [
    el('div', { class: 'dock__scroll cov-form' }, [sourcePanel, briefPanel]),
    el('div', { class: 'dock__foot' }, [
      el('div', { class: 'cov-foot' }, [generateBtn, generateHint]),
    ]),
  ]);

  /* ========================================================= OUTPUT ======= */

  const frame = el('div', { class: 'cov-frame' });
  const heroMeta = el('div', { class: 'cov-meta' });
  const heroLine = el('div', { class: 'brandline cov-hero__line', hidden: true });
  const hero = el('section', { class: 'panel cov-hero' }, [
    heroLine,
    el('div', { class: 'cov-hero__body' }, [frame, heroMeta]),
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

  const galleryCount = el('span', { class: 'cov-count mono' });
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
          state.selected = SAMPLE;
          renderOutput();
        },
      },
    ],
  });
  const grid = el('div', { class: 'cov-grid' });
  const dirGrid = el('div', { class: 'cov-dirs' });
  const gallery = el('section', { class: 'panel cov-gallery' }, [
    el('div', { class: 'panel__head' }, [
      el('span', { class: 'panel__title', text: 'Gallery' }),
      galleryCount,
      el('span', { class: 'spacer' }),
      el('div', { class: 'actionbar' }, [galleryMenu]),
    ]),
    el('div', { class: 'panel__body cov-gallery__body' }, [
      grid,
      el('div', { class: 'cov-dirhead' }, [
        el('span', { class: 'label', text: 'Starting points' }),
        el('span', { class: 'hint', text: 'A direction to build on — it replaces the music description.' }),
      ]),
      dirGrid,
    ]),
  ]);

  const output = el('section', { class: 'cov-out' }, [hero, gallery]);

  page.append(composer, output);
  root.append(page);

  /* ========================================================================
   * Derived
   * ===================================================================== */

  const available = () => Boolean(state.health?.coverArtEnabled) && state.health?.status !== 'offline';

  function blockedReason() {
    const h = state.health;
    if (!h) return 'Checking the studio…';
    if (h.status === 'offline') return h.message;
    if (!h.coverArtEnabled) return 'Artwork is switched off for this studio.';
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
    syncVoice();
  }

  /** Recompose the brief. A hand-edited brief is never silently overwritten. */
  function resuggest({ force = false, silent = false } = {}) {
    if (state.edited && !force) return;
    const next = composeBrief({
      style: state.style,
      lyrics: state.lyrics,
      title: state.title,
      instrumental: state.instrumental,
      useStyle: state.useStyle,
      useLyrics: state.useLyrics,
      useTitle: state.useTitle,
    });
    if (!next) return;
    state.prompt = next;
    state.edited = false;
    promptInput.value = next;
    if (force && !silent) ctx.toast('Brief rewritten from the song.', { kind: 'success' });
  }

  /* ========================================================================
   * Render
   * ===================================================================== */

  function renderForm() {
    const onTrack = state.source === 'track';
    sourcePanel.querySelector('.cov-trackfield').hidden = !onTrack || !tracks.length;
    trackEmpty.hidden = !onTrack || tracks.length > 0;

    const track = tracks.find((t) => t.id === state.trackId);
    const reading = onTrack && Boolean(track);
    trackBtn.querySelector('.cov-track__label').textContent = track ? track.title : 'Choose a song';
    sourcePanel.querySelector('.cov-stylefield__from').textContent = reading ? `read from “${track.title}”` : '';
    styleInput.hidden = reading;
    readBox.hidden = !reading;
    if (reading) renderRead();

    const has = {
      useStyle: Boolean(clean(state.style)),
      useLyrics: !state.instrumental && Boolean(clean(state.lyrics)),
      useTitle: Boolean(clean(state.title)),
    };
    const why = {
      useStyle: 'Describe the music first',
      useLyrics: state.instrumental ? 'This one has no words' : 'Pick a song that has lyrics',
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
      ? `Using ${parts.join(' · ')}`
      : 'Nothing selected — the brief is yours to write.';

    const chars = clean(state.prompt).length;
    promptCount.textContent = chars ? `${chars} characters` : '';
    resuggestBtn.disabled = !clean(state.style) && !clean(state.title);
    resuggestBtn.querySelector('span').textContent = state.edited ? 'Re-suggest' : 'Suggest again';

    const reason = blockedReason();
    generateBtn.disabled = state.busy || Boolean(reason);
    generateBtn.querySelector('span').textContent = state.busy ? 'Making artwork…' : 'Generate cover art';
    generateHint.className = reason && state.health && !available()
      ? 'hint cov-foot__hint hint--warn'
      : 'hint cov-foot__hint';
    generateHint.textContent = reason
      || 'One square cover, about a minute. It is saved to the gallery below.';
  }

  function renderFrame() {
    frame.replaceChildren();
    heroLine.hidden = !state.busy;

    if (state.busy) {
      frame.dataset.mode = 'busy';
      const started = state.startedAt || Date.now();
      const time = el('span', { class: 'cov-frame__time mono', text: clock((Date.now() - started) / 1000) });
      clearInterval(tick);
      tick = setInterval(() => { time.textContent = clock((Date.now() - started) / 1000); }, 1000);
      frame.append(el('div', { class: 'cov-frame__state' }, [
        ctx.icon('spinner', 'icon spinner cov-frame__spin'),
        el('p', { class: 'cov-frame__title', text: 'Making your artwork' }),
        time,
      ]));
      return;
    }

    if (state.error && !state.selected?.url) {
      frame.dataset.mode = 'error';
      frame.append(el('div', { class: 'cov-frame__state' }, [
        el('span', { class: 'cov-frame__icon', html: ctx.iconMarkup('alert') }),
        el('p', { class: 'cov-frame__title', text: 'That render stopped short' }),
      ]));
      return;
    }

    const cover = state.selected;
    if (cover?.url) {
      frame.dataset.mode = 'image';
      frame.append(
        el('img', {
          class: 'cov-frame__img',
          src: api.mediaUrl(cover.url),
          alt: cover.title ? `Cover art for ${cover.title}` : 'Cover art',
          onerror: () => {
            frame.dataset.mode = 'error';
            frame.replaceChildren(el('div', { class: 'cov-frame__state' }, [
              el('span', { class: 'cov-frame__icon', html: ctx.iconMarkup('alert') }),
              el('p', { class: 'cov-frame__title', text: 'That image is no longer on disk' }),
            ]));
          },
        }),
        cover.sample ? el('span', { class: 'cov-tag', text: 'Sample' }) : null,
      );
      return;
    }

    frame.dataset.mode = 'idle';
    frame.append(el('div', { class: 'cov-frame__state' }, [
      el('span', { class: 'cov-frame__icon', html: ctx.iconMarkup('covers') }),
      el('p', { class: 'cov-frame__title', text: 'Your cover lands here' }),
    ]));
  }

  function briefBlock(text, label = 'Art brief') {
    return el('div', { class: 'cov-brief' }, [
      el('p', { class: 'label', text: label }),
      // The clamp lives on the inner <p> and the padding on the box: a clamped
      // line must never show through a padded edge as a half-cut sliver.
      el('div', { class: 'cov-brief__box' }, [el('p', { class: 'cov-brief__text', text })]),
    ]);
  }

  function renderMeta() {
    heroMeta.replaceChildren();

    if (state.busy) {
      heroMeta.append(
        el('p', { class: 'cov-meta__eyebrow', text: 'Working' }),
        el('h2', { class: 'cov-meta__title', text: clean(state.title) || 'Untitled' }),
        el('p', { class: 'cov-meta__lead', text: 'Painting the brief below. You can leave this screen — it keeps going.' }),
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
        el('p', { class: 'cov-meta__eyebrow', text: 'Not finished' }),
        el('h2', { class: 'cov-meta__title', text: 'The artwork service turned this one down' }),
        el('p', { class: 'cov-meta__lead', text: 'Nothing was saved. Here is exactly what came back, in its own words:' }),
        el('pre', { class: 'cov-verbatim mono', text: state.error.text }),
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
        el('p', { class: 'cov-meta__eyebrow', text: 'Ready' }),
        el('h2', { class: 'cov-meta__title', text: 'Nothing made yet' }),
        el('p', { class: 'cov-meta__lead', text: 'Compose a brief on the left and generate — the result lands here and in the gallery.' }),
      );
      return;
    }

    const url = api.mediaUrl(cover.url);
    const chips = el('div', { class: 'cov-chips' }, [
      el('span', { class: 'chip cov-chip', text: cover.mode === 'instrumental' ? 'Instrumental' : 'With vocals' }),
      el('span', { class: 'chip cov-chip', text: 'Square' }),
      cover.at ? el('span', { class: 'chip cov-chip', text: relTime(cover.at) }) : null,
    ]);

    const actions = el('div', { class: 'actionbar cov-actions' }, [
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
      el('p', { class: 'cov-meta__eyebrow', text: cover.sample ? 'Example' : 'Latest cover' }),
      el('h2', { class: 'cov-meta__title truncate', text: cover.title || 'Untitled' }),
      chips,
      cover.sample
        ? el('p', { class: 'cov-meta__lead', text: 'An example of what this screen makes. Yours replaces it the moment you generate one.' })
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
    if (state.selected?.id === cover.id) state.selected = state.history[0] || SAMPLE;
    renderOutput();
    ctx.toast('Removed from the gallery.', { kind: 'info' });
  }

  function renderGallery() {
    const items = [...state.history, SAMPLE];
    galleryCount.textContent = state.history.length
      ? `${state.history.length} cover${state.history.length === 1 ? '' : 's'}`
      : 'sample only';

    grid.replaceChildren();
    for (const item of items) {
      const active = state.selected?.id === item.id && !state.busy && !state.error;
      grid.append(el('button', {
        class: `cov-tile${active ? ' is-active' : ''}`,
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        title: item.title || 'Untitled',
        onclick: () => {
          state.selected = item;
          state.error = null;
          renderOutput();
        },
      }, [
        el('span', { class: 'cov-tile__frame' }, [
          el('img', { src: api.mediaUrl(item.url), alt: '', loading: 'lazy' }),
          item.sample ? el('span', { class: 'cov-tag cov-tag--sm', text: 'Sample' }) : null,
        ]),
        el('span', { class: 'cov-tile__label truncate', text: item.title || 'Untitled' }),
      ]));
    }

    // Terminal card, on the same rhythm as the tiles — the grid ends on purpose.
    grid.append(el('button', {
      class: 'cov-tile cov-tile--new',
      type: 'button',
      title: 'Start a new cover',
      onclick: () => { promptInput.focus(); promptInput.select(); },
    }, [
      el('span', { class: 'cov-tile__frame cov-tile__frame--new' }, [
        el('span', { class: 'cov-tile__plus', html: ctx.iconMarkup('plus') }),
      ]),
      el('span', { class: 'cov-tile__label truncate', text: 'New cover' }),
    ]));
  }

  function renderDirections() {
    dirGrid.replaceChildren();
    for (const dir of DIRECTIONS) {
      dirGrid.append(el('button', {
        class: 'cov-dir', type: 'button',
        onclick: () => {
          state.source = 'scratch';
          for (const item of sourceSeg.children) item.classList.toggle('is-active', item.dataset.source === 'scratch');
          state.style = dir.style;
          state.instrumental = dir.mode === 'instrumental';
          state.lyrics = '';
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
          ctx.toast(`“${dir.name}” loaded into the brief.`, { kind: 'success' });
        },
      }, [
        el('span', { class: 'cov-dir__name', text: dir.name }),
        el('span', { class: 'cov-dir__line', text: dir.line }),
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
        throw new api.ApiError('The studio reported success but sent no artwork back.', {
          status: 200, endpoint: '/api/cover-art', body: result,
        });
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
      ctx.bus.emit('covers:new', { cover: record, meta: { ...body } });
      ctx.toast(`“${record.title}” is ready.`, { kind: 'success', title: 'Cover art' });
    } catch (err) {
      if (err?.name === 'AbortError') {
        ctx.toast('Artwork cancelled.', { kind: 'info' });
      } else {
        const text = api.errorText(err);
        state.error = { status: err?.status ?? 0, text };
        ctx.toast('Nothing was saved. The reason is on the cover panel.', {
          kind: 'error', key: 'covers-error', title: 'The artwork did not render',
        });
        if (err?.status === 501) await ctx.refreshHealth();
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
      key: 'covers-newtrack',
      action: {
        label: 'Use it',
        onClick: () => {
          state.source = 'track';
          for (const item of sourceSeg.children) item.classList.toggle('is-active', item.dataset.source === 'track');
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
