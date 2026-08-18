/**
 * Settings a person can change from the app, kept beside their library.
 *
 * Deliberately narrow. This file holds the address of a lyric writer and the
 * name of a model — where to send a request and what to ask for. It holds no
 * credentials of any kind, and the route that writes it refuses anything that
 * looks like one.
 *
 * That is not squeamishness. This app has no authentication and its own
 * install guide suggests `HOST=0.0.0.0` so a second machine can reach it, so
 * every route here is reachable by anything on the network. Somebody who can
 * change which local model writes the lyrics can waste your afternoon; nothing
 * in this file can cost you money or follow you to another service. Keys stay
 * in the environment, where the browser has never been able to reach them.
 *
 * @module settings-store
 */

import fs from 'node:fs';
import path from 'node:path';

/** Only these may be stored, and only as strings. */
const FIELDS = ['lyricsUrl', 'lyricsModel', 'lyricsApi'];
const MAX_LENGTH = 400;

/** Anything shaped like a credential is refused rather than quietly kept. */
const SECRET = /(^sk-|^Bearer\s|api[_-]?key|password|secret|token)/i;

function settingsFile() {
  const data = process.env.MAXMUSIC_DATA
    || (process.env.MAXMUSIC_DB ? path.dirname(process.env.MAXMUSIC_DB) : '');
  return data ? path.join(path.resolve(data), 'settings.json') : '';
}

/** What has been saved, or an empty object when nothing has. */
export function readSettings() {
  const file = settingsFile();
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Keep only what belongs here, and say what was refused.
 *
 * @returns {{ settings: object, refused: string[] }}
 */
export function sanitiseSettings(incoming) {
  const settings = {};
  const refused = [];
  for (const key of FIELDS) {
    if (!(key in (incoming || {}))) continue;
    const value = String(incoming[key] ?? '').trim().slice(0, MAX_LENGTH);
    if (!value) { settings[key] = ''; continue; }   // empty means "use the environment"
    if (SECRET.test(value)) { refused.push(key); continue; }
    settings[key] = value;
  }
  if (settings.lyricsUrl) {
    // A URL, and one this server could actually call.
    try {
      const url = new URL(settings.lyricsUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      if (url.username || url.password) { refused.push('lyricsUrl'); delete settings.lyricsUrl; }
      else settings.lyricsUrl = settings.lyricsUrl.replace(/\/+$/, '');
    } catch {
      refused.push('lyricsUrl');
      delete settings.lyricsUrl;
    }
  }
  return { settings, refused };
}

/** Merge and persist. Returns what is stored afterwards. */
export function writeSettings(incoming) {
  const file = settingsFile();
  const { settings, refused } = sanitiseSettings(incoming);
  if (!file) return { stored: readSettings(), refused, saved: false };
  const next = { ...readSettings(), ...settings };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return { stored: next, refused, saved: true };
}
