#!/usr/bin/env node
/** Dependency-free, loopback-only AttoLang playground development server. */
import http from 'node:http';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PAGES_ASSETS} from './package-pages.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(PAGES_ASSETS);
const mime = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.atto': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
});
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'";
const headers = Object.freeze({
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
});

function pathFromRequest(raw) {
  if (typeof raw !== 'string') return null;
  const pathname = raw.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') ||
      decoded.split('/').some(s => s === '..' || s === '.')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.slice(1);
  return allowed.has(rel) ? rel : null;
}

async function checkedRead(root, rel) {
  let p = root;
  const bits = rel.split('/');
  for (let i = 0; i < bits.length; i++) {
    p = join(p, bits[i]);
    const st = await lstat(p);
    if (st.isSymbolicLink() || (i < bits.length - 1 && !st.isDirectory()) ||
        (i === bits.length - 1 && (!st.isFile() || st.size > 1024 * 1024))) return null;
  }
  if (!p.startsWith(root + sep)) return null;
  return readFile(p);
}

export function createPlaygroundServer({root = defaultRoot} = {}) {
  const absoluteRoot = resolve(root);
  return http.createServer(async (req, res) => {
    const baseHeaders = {...headers, 'Allow': 'GET, HEAD'};
    const send = (status, body = '') => {
      res.writeHead(status, {...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8'});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed');
    const rel = pathFromRequest(req.url);
    if (!rel) return send(404, 'Not Found');
    try {
      const bytes = await checkedRead(absoluteRoot, rel);
      if (!bytes) return send(404, 'Not Found');
      res.writeHead(200, {...headers,
        'Content-Type': mime[extname(rel)] || 'application/octet-stream',
        'Content-Length': bytes.length});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { send(404, 'Not Found'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535');
    process.exitCode = 2;
  } else {
    createPlaygroundServer().listen(port, '127.0.0.1', () =>
      console.log('AttoLang playground at http://127.0.0.1:' + port + '/'));
  }
}
