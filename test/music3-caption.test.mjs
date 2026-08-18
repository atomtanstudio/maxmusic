import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureMusic3Caption,
  hasSungLyrics,
  hasOfficialCaptionStructure,
  instrumentalStructureLyrics,
  requestsInstrumental,
  simpleMusic3Caption,
} from '../public/js/music3-caption.js';
import { normalizeSongEnding, planSong } from '../public/js/pacing.js';

test('Create emits the native three-part caption with a soft ending timeline', () => {
  const lyrics = '[intro]\nA light appears\n\n[verse]\nWe follow it home\n\n[outro]\nThe final word is done';
  const caption = simpleMusic3Caption({
    idea: 'luminous electronic pop about finding the road home',
    styleTags: 'electronic pop, 104 BPM, clear alto lead',
    duration: 210,
    lyrics,
    instrumental: false,
  });
  assert.equal(hasOfficialCaptionStructure(caption), true);
  assert.match(caption, /Complete section order: intro -> verse -> outro\./);
  assert.match(caption, /ballpark target, never a hard edit point/i);
  assert.match(caption, /emit end-of-song only after/i);
  assert.ok(caption.length < 6000);
});

test('a structured A/B fixture is preserved byte-for-byte', () => {
  const source = [
    '### Global Metadata',
    'Basic Attributes: synth-pop.',
    '',
    '### Vocal Details',
    'One clear singer.',
    '',
    '### Arrangement',
    'Resolve after the outro.',
  ].join('\n');
  assert.equal(ensureMusic3Caption({ prompt: source, duration: 60, lyrics: '[outro]\nDone' }), source);
});

test('whole-track instrumental intent is explicit and does not swallow an instrumental outro', () => {
  assert.equal(requestsInstrumental('Instrumental, dark ambient thall, no lyrics.'), true);
  assert.equal(requestsInstrumental('a cozy lo-fi beat with no vocals'), true);
  assert.equal(requestsInstrumental('wordless operatic wails over sub-bass drones'), true);
  assert.equal(requestsInstrumental('a vocal song with a long instrumental outro'), false);
  assert.equal(hasSungLyrics('[intro]\n\n[instrumental]\n\n[outro]'), false);
  assert.equal(hasSungLyrics('[verse]\nOne real line\n\n[outro]'), true);
});

test('a contradictory structured vocal caption is rebuilt as instrumental', () => {
  const source = [
    '### Global Metadata',
    'Basic Attributes: instrumental, dark ambient thall, no lyrics.',
    '### Vocal Details',
    'A clear lead vocal delivers every written lyric.',
    '### Arrangement',
    'Shape one complete song around 4:00 with a resolved outro.',
    'Complete section order: intro -> instrumental -> outro.',
  ].join('\n');
  const lyrics = instrumentalStructureLyrics(240);
  const repaired = ensureMusic3Caption({ source, prompt: source, duration: 240, lyrics, instrumental: true });
  assert.match(repaired, /### Vocal Details\nInstrumental, no vocals\./);
  assert.doesNotMatch(repaired, /clear lead vocal/i);
  assert.match(repaired, /Complete section order: intro -> verse -> pre-chorus/);
  assert.match(repaired, /about 4:00/);
});

test('long instrumentals receive evolving sections and an explicit outro', () => {
  const lyrics = instrumentalStructureLyrics(300);
  const tags = [...lyrics.matchAll(/^\[([^\]]+)\]$/gm)].map((match) => match[1]);
  assert.equal(tags.length, 28);
  assert.equal(tags[0], 'intro');
  assert.equal(tags.at(-1), 'outro');
  assert.equal(tags.slice(0, -1).includes('instrumental'), true);
});

test('a post-outro instrumental is moved before the terminal outro without losing words', () => {
  const source = '[verse]\nFirst line\n\n[outro]\nThe final words\n\n[instrumental]';
  const normalized = normalizeSongEnding(source);
  assert.equal(normalized, '[verse]\nFirst line\n\n[instrumental]\n\n[outro]\nThe final words');
  assert.equal(normalized.match(/\b(?:First|line|The|final|words)\b/g)?.length, 5);
});

test('length planning keeps a terminal outro even when it adds instrumental room', () => {
  const lyrics = [
    '[intro]',
    'Begin',
    '',
    '[verse]',
    'A short lyric',
    '',
    '[outro]',
    'Land here',
  ].join('\n');
  const plan = planSong({ lyrics, duration: 300, voice: 'slow ambient ballad' });
  const tags = [...plan.lyrics.matchAll(/^\[([^\]]+)\]$/gm)].map((match) => match[1]);
  assert.equal(tags.at(-1), 'outro');
  assert.equal(tags.at(-2), 'instrumental');
});
