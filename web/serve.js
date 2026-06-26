// web/serve.js — ENGLESY no-dependency static dev server.
//
//   node web/serve.js            → http://localhost:8000  (open in Chrome)
//   PORT=3000 node web/serve.js  → http://localhost:3000
//
// Camera/mic need a secure context; localhost qualifies, so just open the
// printed http://localhost URL directly (no https needed for local dev).
//
// Routing (GET/HEAD only):
//   /                  → web/index.html
//   /config.json       → repo ../config.json     (so the app fetches it at /config.json)
//   /data/<p>          → repo ../data/<p>         (sentences, progress, tts-cache mp3s)
//   /<p>               → web/<p>                  (js modules, styles, manifest, sw, icons)
//
// No directory listing, path-traversal safe, minimal request logging.
// Built-ins only — requires Node (any modern version with http/fs/path/url).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_ROOT = __dirname;                       // web/
const REPO_ROOT = path.resolve(WEB_ROOT, '..');   // repo root
const DATA_ROOT = path.join(REPO_ROOT, 'data');   // repo data/
const PORT = parseInt(process.env.PORT, 10) || 8000;

// Content-Type by file extension.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolve a request path within a given root, refusing traversal escapes.
// Returns an absolute path that is guaranteed to stay inside `root`, or null.
function safeJoin(root, relPath) {
  // Strip leading slashes; normalize separators.
  const clean = relPath.replace(/^[/\\]+/, '');
  const full = path.normalize(path.join(root, clean));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body === undefined || body === null) res.end();
  else res.end(body);
}

function notFound(res) {
  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
}

function forbidden(res) {
  send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden');
}

// Stream a file from disk. `headOnly` writes headers without a body.
function serveFile(res, filePath, headOnly) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { notFound(res); return; }
    const headers = {
      'Content-Type': mimeFor(filePath),
      'Content-Length': stat.size,
      // Local dev: never serve a stale module/asset.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    };
    if (headOnly) { send(res, 200, headers); return; }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.destroy(); } catch (_) { /* ignore */ } });
    stream.pipe(res);
  });
}

// Map a URL pathname to an absolute file on disk per the routing table.
function resolveTarget(pathname) {
  // Decode percent-encoding; reject malformed.
  let p;
  try { p = decodeURIComponent(pathname); } catch (_) { return { error: 'forbidden' }; }
  p = p.split('?')[0].split('#')[0];
  if (p === '' || p === '/') p = '/index.html';

  // /config.json → repo ../config.json
  if (p === '/config.json') {
    return { file: path.join(REPO_ROOT, 'config.json') };
  }

  // /data/<rest> → repo ../data/<rest>
  if (p === '/data' || p.startsWith('/data/')) {
    const rest = p.slice('/data'.length); // '' or '/...'
    const file = safeJoin(DATA_ROOT, rest);
    if (!file) return { error: 'forbidden' };
    return { file };
  }

  // Everything else → web/<p>
  const file = safeJoin(WEB_ROOT, p);
  if (!file) return { error: 'forbidden' };
  return { file };
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const urlPath = (req.url || '/').split('?')[0];

  // Permissive CORS so the page can be embedded / fetched freely in dev.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (method === 'OPTIONS') { send(res, 204, {}); return; }
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD, OPTIONS' }, 'method not allowed');
    log(method, urlPath, 405);
    return;
  }

  const target = resolveTarget(urlPath);
  if (target.error === 'forbidden') { forbidden(res); log(method, urlPath, 403); return; }

  // Wrap the response end to log the final status code once.
  let logged = false;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (status, ...rest) {
    if (!logged) { logged = true; log(method, urlPath, status); }
    return origWriteHead(status, ...rest);
  };

  serveFile(res, target.file, method === 'HEAD');
});

function log(method, urlPath, status) {
  const ts = new Date().toISOString().slice(11, 19);
  // Keep it minimal — one line per request.
  console.log(`${ts}  ${String(status)}  ${method}  ${urlPath}`);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT=<n> and retry.`);
    process.exit(1);
  }
  console.error('serve.js error:', err && err.message ? err.message : err);
  process.exit(1);
});

// Start listening. Exposed so launcher.js can reuse the same server in-process.
function start(port, onReady) {
  const p = port || PORT;
  server.listen(p, () => {
    console.log('ENGLESY web server ready');
    console.log(`  → http://localhost:${p}   (open in Chrome)`);
    console.log(`  web   = ${WEB_ROOT}`);
    console.log(`  data  = ${DATA_ROOT}`);
    if (typeof onReady === 'function') onReady(p);
  });
  return server;
}

// Run standalone only when invoked directly (`node web/serve.js`).
if (require.main === module) start();

module.exports = { start, server, PORT, REPO_ROOT, WEB_ROOT, DATA_ROOT };
