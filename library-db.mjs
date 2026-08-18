/**
 * Small, durable library store for the native distribution.
 *
 * This module is loaded only when MAXMUSIC_DB is set. Keeping it opt-in means
 * the existing browser-local library and the legacy backend path do not gain a
 * new runtime requirement just because this file exists.
 *
 * @module library-db
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const MAX_RECORDS = 10_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const VIDEO_MODES = new Set(['film', 'scroll', 'visualizer']);

function videoAssetId({ trackId, mode, url, filename }) {
  return crypto.createHash('sha256')
    .update([trackId, mode, url, filename].map((value) => String(value || '')).join('\0'))
    .digest('hex');
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new Error('Library records must be an array.');
  if (records.length > MAX_RECORDS) {
    throw new Error(`The library is limited to ${MAX_RECORDS.toLocaleString()} songs.`);
  }

  return records.map((record, position) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Library record ${position + 1} is not an object.`);
    }
    const id = String(record.id || '').trim();
    if (!id) throw new Error(`Library record ${position + 1} has no id.`);
    const payload = JSON.stringify({ ...record, id });
    if (Buffer.byteLength(payload) > MAX_RECORD_BYTES) {
      throw new Error(`Library record ${id} is larger than 2 MB.`);
    }
    return { id, position, payload };
  });
}

/**
 * Open or create the SQLite library database.
 *
 * `node:sqlite` is provided by Node itself, so there is no npm native module
 * to compile on Windows, macOS, or Linux. The native launcher documents the
 * Node version required for this path.
 */
export async function openLibraryDb(filename) {
  if (!filename) throw new Error('A SQLite filename is required.');

  const { DatabaseSync } = await import('node:sqlite');
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new DatabaseSync(resolved);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS songs_position_idx ON songs(position);
    CREATE TABLE IF NOT EXISTS video_assets (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS video_assets_track_idx ON video_assets(track_id);
    CREATE TABLE IF NOT EXISTS video_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const read = db.prepare('SELECT payload FROM songs ORDER BY position ASC');
  const readVideos = db.prepare(
    'SELECT track_id, mode, url, filename, created_at FROM video_assets ORDER BY created_at DESC'
  );
  const insert = db.prepare(
    'INSERT INTO songs (id, position, created_at, payload) VALUES (?, ?, ?, ?)'
  );
  const upsertVideo = db.prepare(`
    INSERT INTO video_assets (id, track_id, mode, url, filename, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      track_id = excluded.track_id,
      mode = excluded.mode,
      url = excluded.url,
      filename = excluded.filename,
      created_at = excluded.created_at
  `);
  const readJobs = db.prepare('SELECT payload FROM video_jobs ORDER BY updated_at DESC');
  const upsertJob = db.prepare(`
    INSERT INTO video_jobs (id, status, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  function attachVideos(records) {
    const byTrack = new Map();
    for (const row of readVideos.all()) {
      if (!byTrack.has(row.track_id)) byTrack.set(row.track_id, []);
      byTrack.get(row.track_id).push({
        mode: row.mode,
        url: row.url,
        filename: row.filename,
        at: row.created_at,
      });
    }

    return records.map((record) => {
      const existing = Array.isArray(record.videos) ? record.videos : [];
      const seen = new Set(existing.map((video) => `${video.mode}:${video.url}`));
      const durable = (byTrack.get(String(record.id)) || []).filter((video) => {
        const key = `${video.mode}:${video.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return durable.length ? { ...record, videos: [...existing, ...durable] } : record;
    });
  }

  function saveVideoMetadata(record) {
    if (!Array.isArray(record.videos)) return;
    for (const video of record.videos) {
      const mode = String(video?.mode || '');
      const url = String(video?.url || '');
      const filename = String(video?.filename || path.basename(url));
      if (!VIDEO_MODES.has(mode) || !url || !filename) continue;
      upsertVideo.run(
        videoAssetId({ trackId: record.id, mode, url, filename }),
        String(record.id),
        mode,
        url,
        filename,
        Number(video.at) || Date.now(),
      );
    }
  }

  return {
    filename: resolved,

    list() {
      const records = read.all().flatMap((row) => {
        try {
          const record = JSON.parse(row.payload);
          return record && typeof record === 'object' ? [record] : [];
        } catch {
          return [];
        }
      });
      return attachVideos(records);
    },

    replace(records) {
      const normalized = normalizeRecords(records);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM songs');
        const now = Date.now();
        for (const record of normalized) {
          insert.run(record.id, record.position, now, record.payload);
          saveVideoMetadata(JSON.parse(record.payload));
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      }
      return normalized.length;
    },

    /**
     * Add or refresh one record without asking a browser to upload its entire
     * snapshot. Native generation uses this before replying to the browser, so
     * a refresh or closed tab cannot make a finished song disappear.
     */
    upsert(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('A library record object is required.');
      }
      const id = String(record.id || '').trim();
      if (!id) throw new Error('A library record id is required.');
      const records = this.list();
      const existingIndex = records.findIndex((item) => String(item.id) === id);
      const existing = existingIndex >= 0 ? records[existingIndex] : null;
      const merged = {
        ...(existing || {}),
        ...record,
        id,
        // A server-side generation record has no videos yet. Preserve any
        // videos attached later if the same track is ever refreshed.
        videos: Array.isArray(record.videos) && record.videos.length
          ? record.videos
          : (existing?.videos || []),
      };
      const next = existingIndex >= 0 ? records.filter((_, i) => i !== existingIndex) : records;
      next.unshift(merged);
      return this.replace(next);
    },

    saveVideoJob(job) {
      if (!job || !job.id) throw new Error('A video job id is required.');
      const payload = JSON.stringify(job);
      if (Buffer.byteLength(payload) > MAX_RECORD_BYTES) throw new Error(`Video job ${job.id} is too large.`);
      upsertJob.run(String(job.id), String(job.status || 'unknown'), payload, Date.now());
    },

    listVideoJobs() {
      return readJobs.all().flatMap((row) => {
        try {
          const job = JSON.parse(row.payload);
          return job && typeof job === 'object' ? [job] : [];
        } catch {
          return [];
        }
      });
    },

    recordVideo({ trackId, mode, url, filename, at = Date.now() }) {
      const id = String(trackId || '').trim();
      const kind = String(mode || '').trim();
      const publicUrl = String(url || '').trim();
      const name = String(filename || '').trim() || path.basename(publicUrl);
      if (!id || !VIDEO_MODES.has(kind) || !publicUrl || !name) return false;
      upsertVideo.run(
        videoAssetId({ trackId: id, mode: kind, url: publicUrl, filename: name }),
        id,
        kind,
        publicUrl,
        name,
        Number(at) || Date.now(),
      );
      return true;
    },

    close() {
      db.close();
    },
  };
}
