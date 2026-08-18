import assert from 'node:assert/strict';
import test from 'node:test';

import { validateGeneration } from '../public/js/api.js';

test('tag-only lyrics cannot masquerade as a vocal song', () => {
  const result = validateGeneration({
    prompt: 'dark ambient vocal song',
    lyrics: '[intro]\n\n[instrumental]\n\n[outro]',
    is_instrumental: false,
    duration: 180,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /actual sung words/i);
});

test('tag-only structure remains valid for an explicitly selected instrumental', () => {
  const result = validateGeneration({
    prompt: 'instrumental dark ambient piece',
    lyrics: '[intro]\n\n[instrumental]\n\n[outro]',
    is_instrumental: true,
    duration: 180,
  });
  assert.equal(result.valid, true);
  assert.equal(result.payload.is_instrumental, true);
  assert.equal('lyrics' in result.payload, false);
});
