import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitiseSettings } from '../settings-store.mjs';

test('an address and a model name are kept', () => {
  const { settings, refused } = sanitiseSettings({
    lyricsUrl: 'http://127.0.0.1:11434/v1/',
    lyricsModel: 'qwen3:14b',
  });
  assert.deepEqual(refused, []);
  // The trailing slash goes, because every caller appends its own path.
  assert.equal(settings.lyricsUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(settings.lyricsModel, 'qwen3:14b');
});

test('an empty value means "use the environment" and is kept as empty', () => {
  const { settings } = sanitiseSettings({ lyricsUrl: '', lyricsModel: '  ' });
  assert.equal(settings.lyricsUrl, '');
  assert.equal(settings.lyricsModel, '');
});

test('anything shaped like a credential is refused, not stored', () => {
  // Every string below is a deliberate fake. They exist to prove the refusal
  // fires, and they are written so a secret scanner reading this repository
  // can tell at a glance that nothing here was ever real.
  // This route is reachable by anything on the network — the app has no
  // authentication and its own install guide suggests HOST=0.0.0.0. Nothing
  // that could cost somebody money is allowed to land in this file.
  for (const value of [
    'sk-proj-EXAMPLE0000NOTAREALKEY',
    'Bearer EXAMPLE0000NOTAREALTOKEN',
    'my-api-key-here',
    'the-password-is-hunter2',
    'a-secret-value',
    'my_token_abcdef',
  ]) {
    const { settings, refused } = sanitiseSettings({ lyricsModel: value });
    assert.deepEqual(refused, ['lyricsModel'], `accepted: ${value}`);
    assert.equal(settings.lyricsModel, undefined, `stored: ${value}`);
  }
});

test('a URL carrying credentials, or one this server should not call, is refused', () => {
  for (const url of [
    'http://user:pass@example.com/v1',
    'file:///etc/passwd',
    'not-a-url-at-all',
    'ftp://example.com/v1',
  ]) {
    const { settings, refused } = sanitiseSettings({ lyricsUrl: url });
    assert.ok(refused.includes('lyricsUrl'), `accepted: ${url}`);
    assert.equal(settings.lyricsUrl, undefined, `stored: ${url}`);
  }
});

test('fields nobody asked for are ignored rather than written through', () => {
  const { settings } = sanitiseSettings({
    lyricsUrl: 'http://127.0.0.1:11434/v1',
    lyricsKey: 'sk-EXAMPLE-SHOULD-NEVER-APPEAR',
    OPENAI_API_KEY: 'sk-EXAMPLE-NOR-THIS',
    somethingElse: true,
  });
  assert.deepEqual(Object.keys(settings), ['lyricsUrl']);
});

test('an absurdly long value is cut rather than stored whole', () => {
  const { settings } = sanitiseSettings({ lyricsModel: 'm'.repeat(5000) });
  assert.ok(settings.lyricsModel.length <= 400);
});
