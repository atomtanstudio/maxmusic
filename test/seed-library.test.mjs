import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { seedLibrary } from '../seed-library.mjs';

/** A library just enough like the real one for seeding to be exercised. */
function fakeLibrary(initial = []) {
  let rows = initial.slice();
  return {
    list: () => rows.slice(),
    replace: (records) => { rows = records.slice(); },
    get rows() { return rows; },
  };
}

const SAMPLES = path.join(process.cwd(), 'public', 'samples');
const manifestPath = path.join(SAMPLES, 'samples.json');
const hasSamples = fs.existsSync(manifestPath);

test('a fresh library is given the shipped songs', { skip: !hasSamples && 'no samples shipped yet' }, async () => {
  const tracks = await fsp.mkdtemp(path.join(os.tmpdir(), 'maxmusic-seed-'));
  try {
    const db = fakeLibrary([]);
    const seeded = seedLibrary(db, tracks);
    assert.ok(seeded > 0, 'nothing was seeded');
    assert.equal(db.rows.length, seeded);

    for (const record of db.rows) {
      // Seeded songs are ordinary songs: the audio lives with every other
      // song, so playing, exporting and video-making need no special case.
      assert.match(record.url, /^\/tracks\//, `${record.title} is not served as a track`);
      const file = path.join(tracks, path.basename(record.url));
      assert.ok(fs.existsSync(file), `${record.title} audio was not copied`);
      assert.ok(fs.statSync(file).size > 0, `${record.title} audio is empty`);
      assert.ok(record.title && record.artist, 'a sample is missing its name');
      assert.ok(record.duration > 0, `${record.title} has no duration`);
    }

    // The manifest's order is the order they should appear in, and every one
    // of them belongs below anything the person makes themselves.
    const stamps = db.rows.map((r) => r.createdAt);
    for (let i = 1; i < stamps.length; i += 1) {
      assert.ok(stamps[i] < stamps[i - 1], `sample ${i} is not older than the one before it`);
    }
    assert.ok(Math.max(...stamps) < Date.now(), 'a sample would sort above a new song');
  } finally {
    await fsp.rm(tracks, { recursive: true, force: true });
  }
});

test('a library with songs in it is left alone', { skip: !hasSamples && 'no samples shipped yet' }, async () => {
  const tracks = await fsp.mkdtemp(path.join(os.tmpdir(), 'maxmusic-seed-'));
  try {
    // Somebody who deleted the samples has decided something. Putting them
    // back every restart would be a program that does not listen.
    const mine = [{ id: 'mine', title: 'One of my own', url: '/tracks/mine.flac' }];
    const db = fakeLibrary(mine);
    assert.equal(seedLibrary(db, tracks), 0);
    assert.deepEqual(db.rows, mine);
    assert.equal(fs.readdirSync(tracks).length, 0, 'audio was copied into a library that was not empty');
  } finally {
    await fsp.rm(tracks, { recursive: true, force: true });
  }
});

test('seeding twice does not make a second copy of the audio', { skip: !hasSamples && 'no samples shipped yet' }, async () => {
  const tracks = await fsp.mkdtemp(path.join(os.tmpdir(), 'maxmusic-seed-'));
  try {
    const first = fakeLibrary([]);
    const seeded = seedLibrary(first, tracks);
    const afterOne = fs.readdirSync(tracks).length;
    // A second library on the same machine — a second profile, or a reset.
    const second = fakeLibrary([]);
    assert.equal(seedLibrary(second, tracks), seeded);
    assert.equal(fs.readdirSync(tracks).length, afterOne, 'the audio was duplicated');
  } finally {
    await fsp.rm(tracks, { recursive: true, force: true });
  }
});
