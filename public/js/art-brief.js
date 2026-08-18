/**
 * Art brief — turning one song into one art direction.
 *
 * Deterministic and client-side: no model call and no round trip, so the same
 * song and the same toggles always produce the same direction, and two songs
 * produce two genuinely different ones. SPEC §10c.2 is explicit that lyrics are
 * abstracted into visual subject matter, never pasted — a word only contributes
 * if a camera could photograph it.
 *
 * This was the Art screen's reading half. The screen is gone — artwork is made
 * from the song itself, in the cover-art dialog — and the reading survived it.
 *
 * @module art-brief
 */

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

/* ========================================================================== *
 * Sleeve design language
 *
 * REGISTERS above answer "what is in the picture". They are all scene, palette
 * and light, which is why every cover came back looking like a photograph of a
 * place — good work, but not an album cover. A sleeve is a designed object: it
 * has a medium, a typographic treatment and a layout convention, and those
 * conventions are what make a black metal record legible as a black metal
 * record across a room. That is the part this table carries.
 *
 * `type` is written as an instruction because the title and artist are set INTO
 * the artwork by the image model. The old brief ended "no text or lettering in
 * the image itself", which is why no cover ever had a title on it.
 * ========================================================================== */

const SLEEVES = [
  {
    match: /(synth-?wave|retro-?wave|outrun|vapor-?wave|darksynth|80s|eighties)/i,
    scene: 'an endless coast highway running to a chrome sun on the horizon',
    palette: 'hot magenta and cyan bleeding over deep indigo',
    light: 'sun-grid glow with a long lens flare',
    medium: 'a 1980s airbrush illustration: chrome, deep gradients, a wireframe grid running to a low horizon, faint VHS scanlines over the whole thing',
    type: 'set the title in a wide italic chrome logotype with a bevelled edge and a magenta-to-cyan glow, centred across the upper third',
    layout: 'symmetrical, the horizon low and a sun disc behind the type',
  },
  {
    match: /(black ?metal|death ?metal|doom|thrash|sludge|grindcore|metal|hardcore)/i,
    scene: 'a bare winter forest, or a ruined stone chapel with no way in',
    palette: 'black, bone white and one bruise of dried colour',
    light: 'flat cold daylight with the shadows crushed shut',
    medium: 'a high-contrast near-monochrome image, engraved linework and decayed photographic grain, heavy vignette eating the corners',
    type: 'set the band name as an ornate spiked blackletter logotype across the top, barely legible by design, and the title beneath it small in stark spaced capitals',
    layout: 'rigidly symmetrical and centred, blacks crushed to nothing',
  },
  {
    match: /(old ?school hip ?hop|boom ?bap|golden ?age|hip ?hop|rap|turntabl|breakbeat)/i,
    scene: 'a city block in the afternoon: brick, roller shutters, a stoop, a payphone',
    palette: 'warm sodium orange against cold concrete grey',
    light: 'hard low sun raking down the street',
    medium: 'grainy 1990s 35mm street photography, wide-angle and shot slightly low, heavy film grain and a little motion in it',
    type: 'paint the title as a graffiti piece — fat outlined bubble letters with a spray drop-shadow — overlapping the photograph, and set the artist beside it in a chunky condensed sans',
    layout: 'the lettering sits over the image like it was put there afterwards, sticker energy, nothing precious',
  },
  {
    match: /(k-?pop|j-?pop|idol|bubblegum|dance ?pop|teen ?pop)/i,
    scene: 'a bright studio set: pastel backdrop, oversized props, confetti caught mid-air',
    palette: 'candy pink, mint and butter yellow',
    light: 'even high-key studio light with no hard shadow anywhere',
    medium: 'a glossy high-key studio photograph with candy pastel seamless behind it, cut-paper collage and sticker shapes layered over the top',
    type: 'set the title in a clean geometric sans, tight tracking, one bright accent colour, stacked off-centre with plenty of air around it',
    layout: 'playful and asymmetric, lots of white, a photobook page rather than a poster',
  },
  {
    match: /(lo-?fi|chill-?hop|study beats|bedroom|jazzhop)/i,
    scene: 'a small bedroom at night — desk lamp, headphones, rain running down the window',
    palette: 'muted teal, dusty rose and warm lamp amber',
    light: 'one warm lamp inside and the cold blue of the window',
    medium: 'a soft anime cel illustration: a cosy interior at night, warm lamp, rain running down the window, gentle film grain over flat colour',
    type: 'set the title small and lowercase in an unobtrusive sans, tucked into a lower corner at low contrast',
    layout: 'generous empty space, anyone in it small and seen from behind',
  },
  {
    match: /(classical|orchestral|symphon|concerto|chamber|baroque|opera|choral|piano solo)/i,
    scene: 'a single object on a plain ground, or one architectural detail',
    palette: 'ivory, slate and a single restrained gold',
    light: 'soft raking light with long gentle falloff',
    medium: 'one restrained image, printed like a catalogue plate — nothing busy, nothing incidental',
    type: 'set the title in an elegant serif with clear hierarchy, the work large and the performer smaller beneath, on a solid colour band with generous margins',
    layout: 'symmetrical, wide quiet margins, composed like a record label house style',
  },
  {
    match: /(punk|garage|riot|oi!|street ?punk)/i,
    scene: 'a wall of torn flyers, or an empty club floor after closing',
    palette: 'black, white and one screaming spot colour',
    light: 'direct flash, blown out and unflattering',
    medium: 'a photocopied black-and-white image, blown-out contrast, torn edges and halftone dots',
    type: 'set the title in ransom-note cut-out letters or a stencil, slightly crooked, over a strip of flat colour',
    layout: 'cut-and-paste, off-register, deliberately rough',
  },
  {
    match: /(jazz|blues|bossa|swing|big band|lounge)/i,
    scene: 'a stage after the set, the lights still up and nobody on it',
    palette: 'tobacco brown, brass and deep green shadow',
    light: 'one warm practical just outside the frame',
    medium: 'a mid-century photograph with a duotone wash over it, generous flat colour field beside the image',
    type: 'set the title in a confident modernist sans, lower case, aligned hard to one edge of the colour field',
    layout: 'a strict grid, the image occupying part of the square and flat colour the rest',
  },
  {
    match: /(ambient|drone|meditat|new ?age|shoegaze|dream ?pop|downtempo)/i,
    medium: 'a soft-focus field of colour and haze, almost abstract, no clear subject',
    type: 'set the title very small in a light sans, low contrast, near one edge',
    layout: 'the image fills the square edge to edge, the type almost an afterthought',
  },
  {
    match: /(folk|acoustic|country|americana|bluegrass|singer-?songwriter)/i,
    medium: 'a warm faded photograph with the character of a 1970s sleeve, slight colour shift and print texture',
    type: 'set the title in a friendly serif, hand-drawn in feel, across the lower third',
    layout: 'centred and unhurried, the horizon high',
  },
];

const FALLBACK_SLEEVE = {
  medium: 'a photographic image with the finish of a designed record sleeve rather than an illustration',
  type: 'set the title in a confident sans with clear hierarchy, placed where the composition leaves room',
  layout: 'composed as a square sleeve, the type an intended part of the design',
};

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
export function composeBrief({ style, lyrics, title, artist, instrumental, useStyle, useLyrics, useTitle }) {
  const styleText = useStyle ? clean(style) : '';
  const song = readSong(styleText);
  const read = useLyrics && !instrumental
    ? readLyrics(lyrics)
    : { words: [], images: [], hook: false };
  const named = useTitle ? clean(title) : '';

  if (!styleText && !read.images.length && !read.words.length && !named) return null;

  // The music picks the register; failing that the lyrics do; failing that the
  // catch-all. So switching every toggle still lands somewhere specific.
  // The sleeve is the more specific read of the genre, so where it carries its
  // own art direction it decides the picture too. A k-pop sleeve asking for a
  // candy pastel studio and a register answering "wet city street at midnight"
  // produced a brief that argued with itself.

  // The sleeve is the more specific read of the genre, so where it carries its
  // own art direction it decides the picture too. A k-pop sleeve asking for a
  // candy pastel studio and a register answering "wet city street at midnight"
  // produced a brief that argued with itself.
  const sleeve = pick(SLEEVES, `${song.genre} ${song.raw}`)
    || pick(SLEEVES, styleText)
    || FALLBACK_SLEEVE;

  const baseReg = pick(REGISTERS, `${song.genre} ${song.raw}`)
    || pick(REGISTERS, read.words.join(' '))
    || FALLBACK_REGISTER;
  const reg = {
    ...baseReg,
    scene: sleeve.scene || baseReg.scene,
    palette: sleeve.palette || baseReg.palette,
    light: sleeve.light || baseReg.light,
  };

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

  // The title goes ON the cover. Real sleeves carry their own name, including
  // instrumental ones — a concerto is not sold in a blank wrapper. What an
  // instrumental must not have is anything that could be read as lyrics.
  const performer = clean(artist || '');
  const titleClause = named
    ? `${cap(sleeve.type)}: the title reads exactly “${named}”`
      + `${performer && performer.toLowerCase() !== 'maxmusic' ? `, with “${performer}” as the artist` : ''}`
      + '. Spell it correctly and set no other words anywhere in the image.'
    : `${cap(sleeve.type.replace(/\bthe title\b/g, 'any lettering'))}, kept to a few words at most.`;

  const closing = `Square album cover, artwork filling the whole square edge to edge. ${cap(sleeve.layout)}.`;

  const light = tempoNote ? `${reg.light}, ${tempoNote}` : reg.light;
  const colour = mood ? `${reg.palette} — ${mood}` : reg.palette;
  const sceneLine = read.images.length
    ? `${cap(scene)}, ${read.images.join(' and ')} somewhere in it`
    : cap(scene);

  // Three sentence shapes, all grammatical whatever the scene turns out to be.
  const medium = cap(sleeve.medium);
  const shapes = [
    () => [medium, sceneLine, cap(colour), cap(light), subject, titleClause, closing],
    () => [medium, sceneLine, subject, cap(colour), cap(light), titleClause, closing],
    () => [
      medium,
      `${cap(scene)}, lit by ${lower(light)}`,
      read.images.length ? `${cap(read.images.join(' and '))} somewhere in the frame` : '',
      cap(colour),
      subject,
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
    sleeve,
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
