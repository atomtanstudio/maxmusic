import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAss,
  chooseEncoder,
  fallbackBackgroundArgs,
  ffmpegGraph,
  karaokeText,
  lyricSlots,
  assFilterMissing,
} from '../render/fast-render.mjs';

const nativeData = await fsp.mkdtemp(path.join(os.tmpdir(), 'maxmusic-video-test-'));
const previousData = process.env.MAXMUSIC_DATA;
const previousRenderData = process.env.MAXMUSIC_RENDER_DATA;
process.env.MAXMUSIC_DATA = nativeData;
delete process.env.MAXMUSIC_RENDER_DATA;
const jobs = await import(`../render/jobs.mjs?video-test=${Date.now()}`);
if (previousData === undefined) delete process.env.MAXMUSIC_DATA;
else process.env.MAXMUSIC_DATA = previousData;
if (previousRenderData === undefined) delete process.env.MAXMUSIC_RENDER_DATA;
else process.env.MAXMUSIC_RENDER_DATA = previousRenderData;

after(async () => {
  await fsp.rm(nativeData, { recursive: true, force: true });
});

test('native video startup creates every writable renderer directory', () => {
  for (const relative of ['video-jobs', 'render-data', 'videos', 'models']) {
    assert.equal(fs.statSync(path.join(nativeData, relative)).isDirectory(), true, relative);
  }
});

test('child process errors retain the useful exception instead of the Node footer', () => {
  const stderr = [
    'node:internal/fs/promises:640',
    'Error: ENOENT: no such file or directory, open \'/data/render-data/song.json\'',
    '    at async Object.writeFile (node:internal/fs/promises:1257:14)',
    "  code: 'ENOENT',",
    '}',
    'Node.js v24.15.0',
  ].join('\n');
  assert.equal(
    jobs.childFailureMessage(stderr, 'node exited 1'),
    "ENOENT: no such file or directory, open '/data/render-data/song.json'",
  );
});

test('video tools can resolve an explicitly configured executable without a shell', () => {
  assert.equal(jobs.findExecutable(process.execPath), process.execPath);
  assert.equal(jobs.findExecutable(path.join(nativeData, 'missing-tool')), null);
});

test('video progress uses the newest complete frame counter in a renderer chunk', () => {
  assert.equal(jobs.rendererFrameProgress('frame 90/900\nframe 180/900\n'), 0.2);
  assert.equal(jobs.rendererFrameProgress('renderer starting'), null);
});

test('video creation carries the song id for durable SQLite association', async () => {
  const { videoJobCreate } = await import('../public/js/api.js');
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'queued',
      progress: 0,
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  try {
    await videoJobCreate({
      trackId: 'song-123',
      trackUrl: '/tracks/song.flac',
      mode: 'film',
      title: 'Song',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestBody.trackId, 'song-123');
  assert.equal(requestBody.visualizerConfirmed, false);
});

test('video creation sends an explicit intentional-visualizer confirmation', async () => {
  const { videoJobCreate } = await import('../public/js/api.js');
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: '22222222-2222-4222-8222-222222222222',
      mode: 'visualizer',
      status: 'queued',
      progress: 0,
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  try {
    await videoJobCreate({
      trackId: 'song-456',
      trackUrl: '/tracks/song.flac',
      mode: 'visualizer',
      visualizerConfirmed: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestBody.visualizerConfirmed, true);
});

test('vocal visualizers fail safe to a lyric video unless explicitly confirmed', () => {
  const lyrics = '[verse]\nEvery word belongs on screen';
  assert.equal(jobs.resolveVideoMode('visualizer', lyrics, false), 'film');
  assert.equal(jobs.resolveVideoMode('visualizer', lyrics, true), 'visualizer');
  assert.equal(jobs.resolveVideoMode('film', lyrics, false), 'film');
  assert.equal(jobs.hasAuthoredLyrics('[instrumental]\n'), false);
});

test('a stale video request recovers the saved lyric sheet by track id', () => {
  const store = {
    list: () => [{
      id: 'song-saved',
      isInstrumental: false,
      lyrics: '[verse]\nThe durable words return',
    }],
  };
  assert.equal(
    jobs.resolveJobLyrics('', 'song-saved', store),
    '[verse]\nThe durable words return',
  );
  assert.equal(jobs.resolveJobLyrics('Fresh words', 'song-saved', store), 'Fresh words');
});

test('merged ASR phrases cannot remove canonical lyric lines or words', async () => {
  const fixture = await fsp.mkdtemp(path.join(nativeData, 'alignment-'));
  const sheetFile = path.join(fixture, 'sheet.json');
  const segFile = path.join(fixture, 'segments.json');
  const wordFile = path.join(fixture, 'words.json');
  const outFile = path.join(fixture, 'timing.json');
  const canonical = [
    'Silver lanterns cross the bay',
    'Quiet water knows the way',
    'Morning opens through the rain',
    'Every voice comes home again',
  ];
  await fsp.writeFile(sheetFile, JSON.stringify({
    title: 'Coverage Test',
    artist: 'MaxMusic',
    sections: [
      { id: 'verse-1', kind: 'verse', lines: canonical.slice(0, 2).map((text) => ({ text })) },
      { id: 'verse-2', kind: 'verse', lines: canonical.slice(2).map((text) => ({ text })) },
    ],
  }));
  await fsp.writeFile(segFile, JSON.stringify({ transcription: [
    { text: 'Silver lanterns cross the bay Quiet waters know the way', offsets: { from: 1000, to: 7000 } },
    { text: 'Morning opens through the rain Every voice comes home again', offsets: { from: 8000, to: 14000 } },
  ] }));
  const tokens = canonical.join(' ').split(/\s+/);
  await fsp.writeFile(wordFile, JSON.stringify({ transcription: tokens.map((text, index) => ({
    text,
    offsets: { from: 1000 + index * 500, to: 1400 + index * 500 },
  })) }));

  const aligned = spawnSync(process.execPath, [
    path.resolve('render/align.mjs'), sheetFile, segFile, wordFile, outFile, '--keep-all',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(aligned.status, 0, aligned.stderr || aligned.stdout);
  const timing = JSON.parse(await fsp.readFile(outFile, 'utf8'));
  assert.deepEqual(timing.lines.map((line) => line.text), canonical);
  assert.equal(timing.coverage.canonicalLines, 4);
  assert.equal(timing.coverage.timedLines, 4);
  assert.equal(timing.coverage.canonicalWords, timing.coverage.timedWords);
  assert.equal(timing.coverage.complete, true);
});

test('an empty transcription still yields a complete estimated lyric sheet', async () => {
  const fixture = await fsp.mkdtemp(path.join(nativeData, 'alignment-empty-'));
  const sheetFile = path.join(fixture, 'sheet.json');
  const segFile = path.join(fixture, 'segments.json');
  const wordFile = path.join(fixture, 'words.json');
  const outFile = path.join(fixture, 'timing.json');
  const canonical = ['First line remains', 'Second line remains', 'The ending remains'];
  await fsp.writeFile(sheetFile, JSON.stringify({
    title: 'Fallback Test',
    artist: 'MaxMusic',
    sections: [{ id: 'verse-1', kind: 'verse', lines: canonical.map((text) => ({ text })) }],
  }));
  await fsp.writeFile(segFile, JSON.stringify({ transcription: [] }));
  await fsp.writeFile(wordFile, JSON.stringify({ transcription: [] }));
  const aligned = spawnSync(process.execPath, [
    path.resolve('render/align.mjs'), sheetFile, segFile, wordFile, outFile, '--keep-all',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(aligned.status, 0, aligned.stderr || aligned.stdout);
  const timing = JSON.parse(await fsp.readFile(outFile, 'utf8'));
  assert.deepEqual(timing.lines.map((line) => line.text), canonical);
  assert.equal(timing.coverage.complete, true);
  assert.equal(timing.coverage.estimatedLines, canonical.length);
});

test('fast renderer subtitles show the complete active line before karaoke highlighting', () => {
  const line = {
    text: 'Every written word stays on screen',
    t0: 2,
    t1: 5,
    words: [
      { word: 'Every', t0: 2, t1: 2.5 },
      { word: 'written', t0: 2.5, t1: 3 },
      { word: 'word', t0: 3, t1: 3.5 },
      { word: 'stays', t0: 3.5, t1: 4 },
      { word: 'on', t0: 4, t1: 4.4 },
      { word: 'screen', t0: 4.4, t1: 5 },
    ],
  };
  const karaoke = karaokeText(line, 0.25);
  for (const word of line.words) assert.match(karaoke, new RegExp(`\\b${word.word}\\b`));
  const ass = buildAss({ title: 'Test', artist: 'MaxMusic', lines: [line] }, { mode: 'film', duration: 7 });
  assert.match(ass, /Style: LyricsFilm/);
  assert.match(ass, /Every/);
  assert.match(ass, /screen/);
});

test('an immediate first lyric never overlaps a fallback title card', () => {
  const ass = buildAss({
    title: 'Immediate vocal',
    artist: 'MaxMusic',
    lines: [{
      text: 'Begin on the first beat',
      t0: 0,
      t1: 2,
      words: [
        { word: 'Begin', t0: 0, t1: 0.4 },
        { word: 'on', t0: 0.4, t1: 0.7 },
        { word: 'the', t0: 0.7, t1: 1 },
        { word: 'first', t0: 1, t1: 1.5 },
        { word: 'beat', t0: 1.5, t1: 2 },
      ],
    }],
  }, { mode: 'film', duration: 4 });
  assert.doesNotMatch(ass, /,Title,/);
  assert.match(ass, /Begin/);
});

test('two lyric lines are never on screen at the same time', () => {
  // Both failure shapes the aligner legitimately produces: lines packed
  // tighter than a screen slot, and a rescued line whose estimated start sits
  // behind the line above it. libass draws simultaneous events in the same
  // place, so an overlap is a lyric the viewer never gets to read.
  const lines = [
    { text: 'Turn it on', t0: 2, t1: 2.6 },
    { text: 'Turn it over', t0: 2.7, t1: 3.1 },
    { text: 'Turn it loose', t0: 3.15, t1: 3.4 },
    { text: 'Streetlight fever on a blacktop vein', t0: 8, t1: 11 },
    { text: 'Chrome-heart rhythm in the pouring rain', t0: 11, t1: 13.4 },
    { text: 'Let it roll', t0: 12.9, t1: 13.1 },
    { text: 'Shake the town', t0: 13.05, t1: 13.2 },
  ];
  const slots = lyricSlots(lines, 30);
  assert.equal(slots.length, lines.length);
  for (let i = 0; i < slots.length; i++) {
    assert.ok(slots[i].to > slots[i].from, `line ${i} has no on-screen time`);
    assert.ok(slots[i].to <= 30 + 1e-9, `line ${i} runs past the song`);
    if (i) assert.ok(slots[i].from >= slots[i - 1].to - 1e-9, `line ${i} overlaps line ${i - 1}`);
  }

  const ass = buildAss({ title: 'Overlap', artist: 'MaxMusic', lines }, { mode: 'film', duration: 30 });
  const events = ass.split('\n').filter((line) => line.includes(',LyricsFilm,'));
  assert.equal(events.length, lines.length);
  for (const line of lines) assert.ok(ass.includes(line.text.split(' ')[0]), line.text);
});

test('a packed run shares the room in front of it instead of flickering past', () => {
  // Eight outro lines the recogniser never heard, estimated into one second
  // while the record still has half a minute left to play.
  const lines = Array.from({ length: 8 }, (_unused, index) => ({
    text: `Estimated line ${index + 1}`,
    t0: 30 + index * 0.12,
    t1: 30 + index * 0.12 + 0.1,
    timingEstimated: true,
  }));
  const slots = lyricSlots(lines, 60);
  for (let i = 0; i < slots.length; i++) {
    const shown = slots[i].to - slots[i].from;
    assert.ok(shown >= 0.6, `line ${i} is on screen for ${shown}s`);
    // Readable, but still recognisably an outro rather than a second song:
    // the run may not wander off across the rest of the record.
    assert.ok(slots[i].from - lines[i].t0 < 10, `line ${i} drifted ${slots[i].from - lines[i].t0}s`);
    if (i) assert.ok(slots[i].from >= slots[i - 1].to - 1e-9, `line ${i} overlaps line ${i - 1}`);
  }
});

test('an FFmpeg without libass is named as the problem before a render starts', () => {
  const withAss = [
    ' ... aspectralstats     A->A       Show frequency domain statistics.',
    ' ..C ass                V->V       Render ASS subtitles onto input video using the libass library.',
    ' ... atempo             A->A       Adjust audio tempo.',
  ].join('\n');
  const withoutAss = [
    ' ... aspectralstats     A->A       Show frequency domain statistics.',
    ' T.. gradfun            V->V       Debands video quickly using gradients.',
    ' .S. gradients          |->V       Draw a gradients.',
  ].join('\n');
  assert.equal(assFilterMissing(withAss), false);
  assert.equal(assFilterMissing(withoutAss), true);
  // An FFmpeg that would not answer the question is not accused of anything.
  assert.equal(assFilterMissing(''), false);
});

test('fast renderer prefers NVIDIA acceleration and retains a portable fallback', () => {
  assert.equal(chooseEncoder(' V....D h264_nvenc NVIDIA NVENC H.264 encoder'), 'h264_nvenc');
  assert.equal(chooseEncoder(' V....D libx264 H.264 encoder'), 'libx264');
  assert.equal(chooseEncoder(' V....D h264_videotoolbox VideoToolbox', 'auto', 'darwin'), 'h264_videotoolbox');
});

test('no-cover visualizers use a visible animated gradient and large waveform', () => {
  const background = fallbackBackgroundArgs(30).join(' ');
  assert.match(background, /gradients=/);
  assert.match(background, /c0=0x050812/);
  assert.match(background, /c3=0x0E7C86/);

  const graph = ffmpegGraph({
    duration: 30,
    subtitles: '/tmp/maxmusic-visualizer.ass',
    mode: 'visualizer',
    hasCover: false,
  });
  assert.match(graph, /showwaves=s=1620x420/);
  assert.match(graph, /draw=full/);
  assert.match(graph, /colors=0x19D9FF/);
  assert.match(graph, /colorkey=black/);
  assert.match(graph, /ass=filename=/);
});

test('visualizers retain title and end cards while intentionally omitting lyrics', () => {
  const ass = buildAss({
    title: 'Visible Visualizer',
    artist: 'MaxMusic',
    lines: [],
  }, { mode: 'visualizer', duration: 30 });
  assert.match(ass, /,Title,.*Visible Visualizer/);
  assert.match(ass, /,EndCard,.*Visible Visualizer/);
  assert.doesNotMatch(ass, /,LyricsFilm,/);
});
