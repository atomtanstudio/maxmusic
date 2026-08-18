#!/usr/bin/env node
/**
 * Fast MaxMusic video renderer.
 *
 * The kinetic renderer captures a 1080p browser screenshot for every output
 * frame, which is how it animates type on the beat — it makes the better film
 * and there is no cheaper way to get one. It is the wrong DEFAULT only because
 * it needs a Chromium install and real time to work in. This is the renderer
 * for people who have neither: portable, quick, and honest about being plainer.
 *
 * This renderer keeps the useful pieces in one FFmpeg graph instead:
 *
 *   audio + cover -> darkened background + waveform + ASS karaoke -> MP4
 *
 * Every lyric line is fully visible while it is active; word timestamps only
 * drive the colour sweep. FFmpeg selects NVENC on supported NVIDIA machines,
 * VideoToolbox on supported Macs, and portable libx264 everywhere else.
 *
 *   node render/fast-render.mjs --audio song.flac --timing timing.json \
 *     --mode film --out video.mp4 [--cover cover.png]
 *
 * @module render/fast-render
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const cs = centiseconds % 100;
  const totalSeconds = Math.floor(centiseconds / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function escapeAss(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function dialogue(start, end, style, text) {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`;
}

/**
 * Build an ASS karaoke phrase without allowing broken ASR timestamps to alter
 * the authored word order. The entire line is rendered from the event start;
 * karaoke tags only sweep the accent colour across it.
 */
export function karaokeText(line, leadSeconds = 0) {
  const words = Array.isArray(line?.words) && line.words.length
    ? line.words
    : String(line?.text || '').split(/\s+/).filter(Boolean).map((word) => ({ word }));
  if (!words.length) return '';

  const lineStart = Number(line.t0 || 0);
  const lineEnd = Math.max(lineStart + words.length * 0.08, Number(line.t1 || lineStart + 2));
  const starts = [];
  let cursor = lineStart;
  for (let i = 0; i < words.length; i++) {
    const raw = Number(words[i].t0);
    const remaining = words.length - i - 1;
    const latest = lineEnd - remaining * 0.04;
    const start = Number.isFinite(raw) ? clamp(raw, cursor, latest) : cursor;
    starts.push(start);
    cursor = start + 0.01;
  }

  const parts = [];
  if (leadSeconds > 0.005) parts.push(`{\\k${Math.max(1, Math.round(leadSeconds * 100))}}\u00a0`);
  for (let i = 0; i < words.length; i++) {
    const next = i + 1 < starts.length ? starts[i + 1] : lineEnd;
    const duration = Math.max(1, Math.round(Math.max(0.01, next - starts[i]) * 100));
    parts.push(`{\\kf${duration}}${escapeAss(words[i].word)}`);
  }
  return parts.join(' ');
}

function fullLine(line) {
  return escapeAss(line?.text || line?.words?.map((word) => word.word).join(' ') || '');
}

/* A line appears a moment before its first word and lingers a moment after
   its last, which is what makes a lyric video readable — but only while the
   next line is still waiting. Two lyric events that are on screen at the same
   time are drawn in the same place by libass, and the buried one reads to a
   viewer as a lyric that never appeared at all. */
const PRE_ROLL = 0.28;
const HOLD = 0.55;
const READABLE = 0.9;
/** Nothing shorter than this is worth calling a lyric anyone can read. */
const MIN_SHOW = 0.7;
/** A visible cut between two lines, so neither borrows the other's frame. */
const CUT_GAP = 0.04;
/** As long as a crowded line is ever given: enough to read, no more. */
const COMFORTABLE = 1.2;
/** Even in a pile-up a line gets its own moment rather than being dropped. */
const FLASH = 0.24;

/**
 * Turn timed lines into a strictly non-overlapping sequence of screen slots.
 *
 * The timing sheet is allowed to overlap: `align.mjs` keeps every authored
 * line even where the recogniser heard one merged phrase, so neighbouring
 * lines can share a window. Playback cannot. Each line gets its own stretch
 * of the timeline, in authored order, and a line that would otherwise be
 * squeezed to nothing takes back the hold time the line above it was only
 * lingering with — the line above keeps every word it sings, it just leaves
 * the screen on time instead of late.
 *
 * @param {Array<object>} lines   timed lines in authored order
 * @param {number} totalDuration  the song, in seconds
 * @returns {Array<{from: number, to: number}>} one slot per line
 */
export function lyricSlots(lines, totalDuration) {
  const song = Math.max(1, Number(totalDuration) || 1);
  const count = lines.length;

  // Sung order is the authored order. A rescued or estimated line can carry a
  // t0 slightly behind its predecessor's; that is a timing artefact, and
  // re-sorting on it would print the song's words out of order.
  const first = [];
  const last = [];
  let earliest = 0;
  for (let i = 0; i < count; i++) {
    const t0 = Number(lines[i]?.t0);
    const t1 = Number(lines[i]?.t1);
    const from = Math.min(song, Math.max(earliest, Number.isFinite(t0) ? t0 : earliest));
    first.push(from);
    last.push(Number.isFinite(t1) && t1 > from ? Math.min(song, t1) : from + READABLE);
    earliest = from;
  }
  // The next line's first word is the hard limit for the line before it: a
  // line may eat the pre-roll of the line that follows, never its vocal.
  const limit = (i) => (i + 1 < count ? first[i + 1] : song);

  const froms = [];
  for (let i = 0; i < count; i++) {
    // Normally the pre-roll; where the next line crowds in, as much earlier as
    // it takes to be readable, but never before the line above stops singing.
    const room = Math.min(first[i] - PRE_ROLL, limit(i) - MIN_SHOW - CUT_GAP);
    const sung = i > 0 ? Math.min(last[i - 1], first[i]) + CUT_GAP : 0;
    froms.push(Math.max(0, sung, i > 0 ? froms[i - 1] + FLASH : 0, Math.min(first[i], room)));
  }

  // A pile-up: a run of lines the sheet lands almost on top of each other,
  // usually an outro the recogniser never heard and had to estimate. Nothing
  // can show eight lines inside one second AND keep them in step with the
  // record — and an estimated time is a guess to begin with. So the run takes
  // the room in front of it, a comfortable read each and no more, which puts
  // every line on screen instead of flickering most of them past in three
  // frames. Lines the record actually spaces out are never touched.
  const gapAfter = (i) => (i + 1 < count ? froms[i + 1] : song) - froms[i];
  let head = 0;
  while (head < count) {
    if (gapAfter(head) >= MIN_SHOW) { head++; continue; }
    let tail = head;
    while (tail + 1 < count && gapAfter(tail) < MIN_SHOW) tail++;
    const members = tail - head + 1;
    const share = Math.min((gapAfter(tail) + froms[tail] - froms[head]) / members, COMFORTABLE);
    for (let k = 1; k < members; k++) {
      froms[head + k] = Math.max(froms[head + k], froms[head] + (share * k));
    }
    head = tail + 1;
  }
  // Restore the one invariant everything below relies on: consecutive lines
  // are far enough apart that no line can be drawn over the one before it.
  for (let i = 1; i < count; i++) froms[i] = Math.max(froms[i], froms[i - 1] + FLASH);

  const slots = [];
  for (let i = 0; i < count; i++) {
    const from = Math.min(song, froms[i]);
    const wanted = Math.max(last[i] + HOLD, from + READABLE);
    const ceiling = i + 1 < count
      ? Math.min(Math.max(limit(i), from + MIN_SHOW), froms[i + 1] - CUT_GAP)
      : song;
    const to = Math.min(song, Math.max(from + (FLASH / 2), Math.min(wanted, ceiling)));
    slots.push({ from, to });
  }
  return slots;
}

export function buildAss(timing, { mode = 'film', duration } = {}) {
  const lines = Array.isArray(timing?.lines) ? timing.lines : [];
  const totalDuration = Math.max(
    1,
    Number(duration || 0),
    ...lines.map((line) => Number(line.t1 || 0)),
  );
  const title = escapeAss(timing?.title || 'Untitled');
  const artist = escapeAss(timing?.artist || 'MaxMusic');
  const events = [];

  // A real 0-second lyric start is not a missing value. The old `|| 7`
  // interpretation kept the title card up for nearly seven seconds and laid
  // it directly over songs whose vocal begins immediately.
  const firstLyricStart = Number(lines[0]?.t0);
  const introEnd = Math.min(
    totalDuration,
    Number.isFinite(firstLyricStart)
      ? Math.max(0, Math.min(7, firstLyricStart - 0.35))
      : 7,
  );
  if (introEnd > 0.5) {
    events.push(dialogue(0.15, introEnd, 'Title', `{\\fad(320,420)}${title}\\N{\\rArtist}${artist}`));
  }

  const slots = mode === 'visualizer' ? [] : lyricSlots(lines, totalDuration);

  if (mode !== 'visualizer') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const previous = lines[i - 1];
      const next = lines[i + 1];
      const lineStart = Math.max(0, Number(line.t0 || 0));
      const { from: start, to: end } = slots[i];
      const lead = Math.max(0, lineStart - start);
      const active = karaokeText(line, lead);

      if (mode === 'scroll') {
        const before = previous ? `{\\fs42\\c&H008A8175&}${fullLine(previous)}\\N` : '';
        const after = next ? `\\N{\\fs42\\c&H008A8175&}${fullLine(next)}` : '';
        events.push(dialogue(
          start,
          end,
          'LyricsScroll',
          `{\\fad(130,160)}${before}{\\fs62\\c&H00F4F2EE&}${active}${after}`,
        ));
      } else {
        events.push(dialogue(start, end, 'LyricsFilm', `{\\fad(130,180)}${active}`));
      }
    }
  }

  const lastLyric = slots.length ? slots[slots.length - 1].to : 0;
  const cardStart = Math.max(lastLyric + 0.8, totalDuration - 6.5, introEnd + 0.5);
  if (totalDuration - cardStart > 0.5) {
    events.push(dialogue(cardStart, totalDuration - 0.08, 'EndCard', `{\\fad(420,650)}${title}\\N{\\rArtist}${artist}`));
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: LyricsFilm,Noto Sans,76,&H00F4F2EE,&H00E8C516,&HC8000000,&H70000000,-1,0,0,0,100,100,0,0,1,3.2,1.2,5,150,150,0,1',
    'Style: LyricsScroll,Noto Sans,62,&H00F4F2EE,&H00E8C516,&HC8000000,&H70000000,-1,0,0,0,100,100,0,0,1,3,1,5,220,220,0,1',
    'Style: Title,Noto Serif,88,&H00F4F2EE,&H00F4F2EE,&HC8000000,&H50000000,-1,0,0,0,100,100,1,0,1,3.5,1,5,120,120,0,1',
    'Style: Artist,Noto Sans,32,&H008A8175,&H008A8175,&HC8000000,&H50000000,0,0,0,0,100,100,8,0,1,2,0,5,120,120,0,1',
    'Style: EndCard,Noto Serif,82,&H00F4F2EE,&H00F4F2EE,&HC8000000,&H50000000,-1,0,0,0,100,100,1,0,1,3.5,1,5,120,120,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

function escapeFilterPath(filename) {
  return path.resolve(filename)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function capture(bin, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${path.basename(bin)} exited ${code}`));
    });
  });
}

async function probeDuration(ffprobe, audio) {
  const stdout = await capture(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', audio,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('FFprobe could not measure the song.');
  return seconds;
}

export async function supportedEncoders(ffmpeg) {
  try {
    return await capture(ffmpeg, ['-hide_banner', '-encoders']);
  } catch {
    return '';
  }
}

async function supportedFilters(ffmpeg) {
  try {
    return await capture(ffmpeg, ['-hide_banner', '-filters']);
  } catch {
    return '';
  }
}

/**
 * Every card and lyric in this renderer is drawn by FFmpeg's `ass` filter, and
 * a build without libass simply does not have it. FFmpeg's own answer to that
 * is `No such filter: 'ass'` several hundred lines into a failed graph, which
 * tells somebody installing this for the first time nothing at all.
 */
export function assFilterMissing(filterList) {
  if (!filterList) return false; // could not ask; let FFmpeg answer for itself
  return !String(filterList)
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[1] === 'ass');
}

export function chooseEncoder(encoderList, requested = 'auto', platform = process.platform) {
  const has = (name) => new RegExp(`\\b${name}\\b`).test(encoderList);
  if (requested && requested !== 'auto') return requested;
  if (has('h264_nvenc')) return 'h264_nvenc';
  if (platform === 'darwin' && has('h264_videotoolbox')) return 'h264_videotoolbox';
  return 'libx264';
}

function encoderArgs(encoder) {
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-profile:v', 'high'];
  }
  if (encoder === 'h264_videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-profile:v', 'high'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
}

/** A visible, animated fallback for songs that do not have cover art yet. */
export function fallbackBackgroundArgs(duration) {
  return [
    '-f', 'lavfi',
    '-i',
    `gradients=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${Number(duration).toFixed(3)}`
      + ':c0=0x050812:c1=0x103B69:c2=0x4F176B:c3=0x0E7C86'
      + ':n=4:type=linear:speed=0.012',
  ];
}

export function ffmpegGraph({ duration, subtitles, mode = 'film', hasCover = false }) {
  const d = duration.toFixed(3);
  const parts = [hasCover
    ? `[1:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,gblur=sigma=14,eq=brightness=-0.30:saturation=0.78,format=rgba[bg]`
    : `[1:v]scale=${WIDTH}:${HEIGHT},setsar=1,format=rgba[bg]`,
    `color=c=black@${hasCover ? '0.34' : '0.12'}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${d},format=rgba[shade]`,
    '[bg][shade]overlay=shortest=1[base]',
  ];
  if (mode === 'visualizer') {
    parts.push(
      '[0:a]asplit=2[waveaudio][audioout]',
      `[waveaudio]aformat=channel_layouts=mono,showwaves=s=1620x420:mode=cline:draw=full:rate=${FPS}:colors=0x19D9FF:scale=sqrt,format=rgba,colorkey=black:0.08:0.02[wave]`,
      '[base][wave]overlay=(W-w)/2:(H-h)/2:shortest=1[viz]',
    );
  } else {
    parts.push(
      '[0:a]asplit=2[waveaudio][audioout]',
      `[waveaudio]aformat=channel_layouts=mono,showwaves=s=${WIDTH}x160:mode=cline:rate=${FPS}:colors=0x16C5E8:scale=sqrt,format=rgba,colorchannelmixer=aa=0.72[wave]`,
      `[base][wave]overlay=0:${HEIGHT - 176}:shortest=1[viz]`,
    );
  }
  let current = 'viz';
  if (subtitles) {
    parts.push(`[${current}]ass=filename='${escapeFilterPath(subtitles)}'[subbed]`);
    current = 'subbed';
  }
  parts.push(`[${current}]format=yuv420p[vout]`);
  return parts.join(';');
}

function runFfmpeg(ffmpeg, argv, { duration, encoder }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, argv, { shell: false });
    let stdout = '';
    let stderr = '';
    let lastFrame = -1;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^(?:out_time_ms|out_time_us)=(\d+)/);
        if (!match) continue;
        const seconds = Number(match[1]) / 1e6;
        const frame = Math.min(Math.round(duration * FPS), Math.max(0, Math.round(seconds * FPS)));
        if (frame !== lastFrame) {
          lastFrame = frame;
          process.stdout.write(`frame ${frame}/${Math.round(duration * FPS)} · ${encoder}\n`);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split(/\r?\n/).slice(-8).join(' ') || `FFmpeg exited ${signal || code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const audio = path.resolve(args.audio || '');
  const timingFile = path.resolve(args.timing || '');
  const out = path.resolve(args.out || '');
  const mode = ['film', 'scroll', 'visualizer'].includes(args.mode) ? args.mode : 'film';
  const cover = args.cover && fs.existsSync(path.resolve(args.cover)) ? path.resolve(args.cover) : null;
  const ffmpeg = args.ffmpeg || process.env.MAXMUSIC_FFMPEG || 'ffmpeg';
  const configuredFfprobe = args.ffprobe || process.env.MAXMUSIC_FFPROBE;
  const ffprobe = configuredFfprobe
    || (path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');

  if (!fs.existsSync(audio)) throw new Error('The audio file does not exist.');
  if (!fs.existsSync(timingFile)) throw new Error('The timing sheet does not exist.');
  if (!out || out === path.parse(out).root) throw new Error('Pass a safe --out filename.');

  const [duration, timing, encoders, filters] = await Promise.all([
    probeDuration(ffprobe, audio),
    fsp.readFile(timingFile, 'utf8').then(JSON.parse),
    supportedEncoders(ffmpeg),
    supportedFilters(ffmpeg),
  ]);
  if (assFilterMissing(filters)) {
    throw new Error(
      'This FFmpeg was built without libass, so it cannot draw lyrics or title cards. '
      + 'Install an FFmpeg with subtitle support (Homebrew: brew install ffmpeg; '
      + 'Debian/Ubuntu: apt install ffmpeg; Windows: the gyan.dev "full" build), '
      + 'or point MAXMUSIC_FFMPEG at one.',
    );
  }
  const assFile = path.join(path.dirname(out), `${path.basename(out, path.extname(out))}.ass`);
  const ass = buildAss(timing, { mode, duration });
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(assFile, ass, 'utf8');

  const backgroundArgs = cover
    ? ['-loop', '1', '-framerate', String(FPS), '-i', cover]
    : fallbackBackgroundArgs(duration);
  const graph = ffmpegGraph({ duration, subtitles: assFile, mode, hasCover: Boolean(cover) });
  const requested = args.encoder || process.env.MAXMUSIC_VIDEO_ENCODER || 'auto';
  const preferred = chooseEncoder(encoders, requested);
  const attempts = [...new Set([preferred, 'libx264'])];
  let finalError = null;

  for (const encoder of attempts) {
    await fsp.rm(out, { force: true });
    const ffArgs = [
      '-hide_banner', '-nostdin', '-y',
      '-i', audio,
      ...backgroundArgs,
      '-filter_complex', graph,
      '-map', '[vout]', '-map', '[audioout]',
      ...encoderArgs(encoder),
      '-r', String(FPS), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-t', duration.toFixed(3),
      '-progress', 'pipe:1', '-nostats',
      out,
    ];
    try {
      await runFfmpeg(ffmpeg, ffArgs, { duration, encoder });
      const stat = await fsp.stat(out);
      if (!stat.size) throw new Error('FFmpeg produced an empty video.');
      process.stdout.write(`renderer fast-ffmpeg · encoder ${encoder} · duration ${duration.toFixed(2)}s\n`);
      return;
    } catch (error) {
      finalError = error;
      if (encoder === 'libx264' || requested !== 'auto') break;
      process.stderr.write(`Hardware encoder ${encoder} was unavailable; retrying with libx264.\n`);
    }
  }
  throw finalError || new Error('The video could not be rendered.');
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
