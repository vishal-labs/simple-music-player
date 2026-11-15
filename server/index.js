// Small HTTP server: serves the UI, the library as JSON, and the audio files
// (with Range support, so seeking works).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from './library.js';

const MUSIC_DIR = process.env.MUSIC_DIR || '/music';
const PORT = Number(process.env.PORT) || 8080;
const SITE_TITLE = process.env.SITE_TITLE || 'bhakti';
const RESCAN_MINUTES = Number(process.env.RESCAN_MINUTES ?? 10);
const IGNORE_PREFIXES = (process.env.IGNORE_PREFIXES ?? '.,_').split(',').map((s) => s.trim());

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const library = new Library(MUSIC_DIR, IGNORE_PREFIXES);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** Parses a single-range "bytes=" header. Returns null when unsatisfiable. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

function pipeFile(req, res, abs, options) {
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(abs, options);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function serveAudio(req, res, id) {
  const file = library.files.get(id);
  if (!file) return sendText(res, 404, 'Track not found');
  let info;
  try {
    info = await stat(file.abs);
  } catch {
    return sendText(res, 404, 'Track not found');
  }
  const headers = {
    'Content-Type': file.type,
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': 'private, max-age=3600',
  };
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, info.size);
    if (!range) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    return pipeFile(req, res, file.abs, range);
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  pipeFile(req, res, file.abs);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const abs = path.join(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not found');
  const etag = `"${info.size}-${Math.round(info.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    ETag: etag,
    'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  pipeFile(req, res, abs);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  if (pathname === '/api/rescan' && req.method === 'POST') {
    await library.scan();
    return sendJson(res, 200, { ok: true, scannedAt: library.scannedAt });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed');
  }
  if (pathname === '/healthz') return sendText(res, 200, 'ok');
  if (pathname === '/api/library') {
    if (!library.scannedAt) await library.scan(); // first scan still running
    return sendJson(res, 200, {
      title: SITE_TITLE,
      scannedAt: library.scannedAt,
      error: library.error,
      collections: library.collections,
    });
  }
  if (pathname.startsWith('/audio/')) {
    return serveAudio(req, res, pathname.slice('/audio/'.length));
  }
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (res.headersSent) res.destroy();
    else sendText(res, 500, 'Internal error');
  });
});

server.listen(PORT, () => {
  console.log(`music player on http://localhost:${PORT}  (music folder: ${MUSIC_DIR})`);
  library.scan();
  if (RESCAN_MINUTES > 0) {
    setInterval(() => library.scan(), RESCAN_MINUTES * 60_000).unref();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
