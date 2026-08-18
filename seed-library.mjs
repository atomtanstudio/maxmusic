/**
 * The first thing a new install has to play.
 *
 * An empty library is the one moment somebody has not yet heard what this
 * program makes, and "make a song and wait three minutes" is a poor answer to
 * "what is this". So a fresh library is seeded with the songs in
 * `public/samples`, made by this program through its own API and shipped with
 * it.
 *
 * They are seeded as ordinary songs, not as a special case: the audio is copied
 * into the tracks directory and the records point at `/tracks/…` like anything
 * else. That is the whole reason to do it this way — playing, downloading,
 * exporting and making a lyric video all work on a sample without a single
 * branch anywhere downstream.
 *
 * Seeding happens only when the library is empty. Somebody who deletes the
 * samples has decided something, and a program that keeps putting them back has
 * not listened.
 *
 * @module seed-library
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(HERE, 'public', 'samples');
const MANIFEST = path.join(SAMPLES_DIR, 'samples.json');

/**
 * Put the shipped songs in an empty library.
 *
 * @param {{ list: Function, replace: Function }} libraryDb
 * @param {string} tracksDir  where song audio lives for this install
 * @returns {number} how many songs were seeded; zero whenever nothing was done
 */
export function seedLibrary(libraryDb, tracksDir) {
  if (!libraryDb?.list || !libraryDb?.replace) return 0;
  if (!fs.existsSync(MANIFEST)) return 0;

  try {
    if (libraryDb.list().length) return 0;
  } catch {
    return 0; // an unreadable library is not one to write into
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    console.error(`[seed] the sample manifest could not be read: ${error.message}`);
    return 0;
  }
  const songs = Array.isArray(manifest?.songs) ? manifest.songs : [];
  if (!songs.length) return 0;

  fs.mkdirSync(tracksDir, { recursive: true });
  const now = Date.now();
  const records = [];

  songs.forEach((song, index) => {
    const audio = path.join(SAMPLES_DIR, song.audio || '');
    if (!song.audio || !fs.existsSync(audio)) {
      console.error(`[seed] skipping ${song.title}: ${song.audio} is not in public/samples`);
      return;
    }
    // A stable filename per sample, taken from the id it already carries:
    // seeding twice into two different libraries must not produce two copies
    // of the same audio.
    const filename = `${song.id}${path.extname(song.audio)}`;
    const destination = path.join(tracksDir, filename);
    if (!fs.existsSync(destination)) fs.copyFileSync(audio, destination);

    records.push({
      id: song.id,
      url: `/tracks/${filename}`,
      filename,
      size: fs.statSync(destination).size,
      title: song.title,
      artist: song.artist,
      prompt: song.prompt || '',
      lyrics: song.lyrics || '',
      isInstrumental: Boolean(song.instrumental),
      duration: Number(song.seconds) || 0,
      requestedDuration: Number(song.requested) || Number(song.seconds) || 0,
      format: 'mp3',
      cover: song.cover ? `/samples/${song.cover}` : null,
      videos: [],
      // Dated so the newest-first default shows them in the order the manifest
      // lists them, and so anything the person makes lands above all of them.
      createdAt: now - ((index + 1) * 60000),
      source: 'sample',
    });
  });

  if (!records.length) return 0;
  libraryDb.replace(records);
  console.log(`[seed] ${records.length} sample songs are in the library for a first look.`);
  return records.length;
}
