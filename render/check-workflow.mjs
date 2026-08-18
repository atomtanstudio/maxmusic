#!/usr/bin/env node
/**
 * Is the backend letting the model choose the song's length?
 *
 * Reads the last real generation out of ComfyUI's history and reports whether
 * the audio canvas is wired to the text encoder's own answer (`['4', 1]`) or
 * still hardcoded to whatever length was requested. See
 * the duration handling notes.
 *
 *   node render/check-workflow.mjs [comfyUrl]
 *
 * @module render/check-workflow
 */

const COMFY = process.argv[2] || 'http://127.0.0.1:8189';

/* Songs the BACKEND made, which is what this is asking about — anything
   submitted to ComfyUI by hand for a test writes somewhere else and would
   otherwise answer the question for it. */
const isBackendSong = (e) => {
  const g = Array.isArray(e.prompt) ? e.prompt[2] : null;
  if (!g || g['6']?.class_type !== 'EmptyMiniMaxMusic3LatentAudio') return false;
  return String(g['9']?.inputs?.filename_prefix || '').startsWith('audio/maxmusic');
};

const history = await fetch(`${COMFY}/history?max_items=60`).then((r) => r.json());
const runs = Object.values(history).filter(isBackendSong).sort((a, b) => a.prompt[0] - b.prompt[0]);

const last = runs[runs.length - 1];
if (!last) {
  console.log('No songs in ComfyUI history yet — make one, then run this again.');
  process.exit(0);
}

const canvas = last.prompt[2]['6'].inputs.seconds;
const ceiling = last.prompt[2]['4'].inputs.max_duration;
const wired = Array.isArray(canvas);

console.log(`last song  · ceiling ${ceiling}s · canvas ${wired ? `wired to the model (${JSON.stringify(canvas)})` : `hardcoded to ${canvas}s`}`);
console.log(wired
  ? 'LIVE — the model is choosing how long each song runs.'
  : 'NOT LIVE — the backend answering on this ComfyUI still overrules the model.');
process.exit(wired ? 0 : 1);
