// Scans the music folder and turns it into a list of collections.
// Every folder that directly contains audio files becomes one collection.

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

export const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b);

const trackId = (relPath) => createHash('sha1').update(relPath).digest('hex').slice(0, 12);

function slugify(text, taken) {
  const base =
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'folder';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class Library {
  /**
   * @param {string} root            absolute path of the music folder
   * @param {string[]} ignorePrefixes folder/file names starting with any of these are skipped
   */
  constructor(root, ignorePrefixes = ['.', '_']) {
    this.root = path.resolve(root);
    this.ignorePrefixes = ignorePrefixes.filter(Boolean);
    this.collections = [];
    this.files = new Map(); // track id -> { abs, type, size, mtimeMs }
    this.scannedAt = null;
    this.error = null;
    this.durations = new Map(); // "rel|size|mtime" -> seconds (survives rescans)
    this.scanning = null;
  }

  ignored(name) {
    return this.ignorePrefixes.some((prefix) => name.startsWith(prefix));
  }

  /** Runs a scan; concurrent callers share the one in flight. */
  scan() {
    this.scanning ??= this.#scan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async #walk(dirAbs, dirRel, out) {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (dirRel === '') throw err;
      console.warn(`skipping unreadable folder ${dirRel}: ${err.code || err.message}`);
      return;
    }
    const tracks = [];
    const subdirs = [];
    for (const entry of entries) {
      if (this.ignored(entry.name)) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      let info;
      try {
        info = await stat(abs); // follows symlinks
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        subdirs.push({ abs, rel });
      } else if (info.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_TYPES[ext]) continue;
        tracks.push({
          abs,
          rel,
          ext,
          size: info.size,
          mtimeMs: info.mtimeMs,
          title: path.basename(entry.name, path.extname(entry.name)),
        });
      }
    }
    if (tracks.length) out.push({ rel: dirRel, tracks });
    subdirs.sort((a, b) => byName(a.rel, b.rel));
    for (const sub of subdirs) await this.#walk(sub.abs, sub.rel, out);
  }

  async #scan() {
    const started = Date.now();
    const folders = [];
    try {
      await this.#walk(this.root, '', folders);
    } catch (err) {
      this.error = `Cannot read the music folder: ${err.code || err.message}`;
      console.error(this.error);
      this.collections = [];
      this.files = new Map();
      this.scannedAt = new Date().toISOString();
      return;
    }

    const allTracks = folders.flatMap((folder) => folder.tracks);
    const durations = new Map();
    await mapLimit(allTracks, 4, async (track) => {
      const key = `${track.rel}|${track.size}|${track.mtimeMs}`;
      let seconds = this.durations.get(key);
      if (seconds === undefined) {
        try {
          const meta = await parseFile(track.abs, { skipCovers: true });
          seconds = Number.isFinite(meta.format.duration) ? meta.format.duration : null;
        } catch {
          seconds = null;
        }
      }
      durations.set(key, seconds);
      track.duration = seconds;
    });
    this.durations = durations;

    const slugs = new Set(['favourites']);
    const files = new Map();
    folders.sort((a, b) => byName(a.rel, b.rel));
    this.collections = folders.map((folder) => {
      const title = folder.rel === '' ? 'Unsorted' : folder.rel.split('/').join(' / ');
      folder.tracks.sort((a, b) => byName(a.title, b.title));
      return {
        slug: slugify(title, slugs),
        title,
        tracks: folder.tracks.map((track) => {
          const id = trackId(track.rel);
          files.set(id, {
            abs: track.abs,
            type: AUDIO_TYPES[track.ext],
            size: track.size,
            mtimeMs: track.mtimeMs,
          });
          return {
            id,
            title: track.title,
            duration: track.duration === null ? null : Math.round(track.duration),
            size: track.size,
          };
        }),
      };
    });
    this.files = files;
    this.error = null;
    this.scannedAt = new Date().toISOString();
    console.log(
      `scanned ${files.size} tracks in ${this.collections.length} folders (${Date.now() - started} ms)`,
    );
  }
}
