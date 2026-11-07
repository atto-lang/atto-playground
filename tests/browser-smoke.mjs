/** Optional real-Chromium E2E check: requires local Chromium/Chrome. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(new URL('..', import.meta.url).pathname);
const mime = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) { res.writeHead(403);res.end();return; }
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('Not a regular file');
    res.writeHead(200, { 'Content-Type': mime[extname(abs)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(abs));
  } catch { res.writeHead(404);res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = process.env.CHROME_BIN || 'chromium';
function headless(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--virtual-time-budget=8000', '--dump-dom', url], { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => {stdout += d.toString();});
    p.stderr.on('data', d => {stderr += d.toString().slice(0,1000);});
    const deadline = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('error', error => {clearTimeout(deadline); reject(error);});
    p.on('close', n => {clearTimeout(deadline); n === 0 ? resolve(stdout) : reject(new Error(`Chromium exited ${n}: ${stderr.slice(-900)}`));});
  });
}
try {
  const page = await headless(`http://127.0.0.1:${port}/?smoke=1`);
  assert.match(page, /main\(\) → 42/, 'Browser failed actual compiler → guest execution');
  assert.match(page, /Completed/, 'Result was not marked completed');
  console.log('PASS: Chromium executed browser-compiled guest and returned 42');
  const invalid = await headless(`http://127.0.0.1:${port}/?smoke=error`);
  assert.match(invalid, /E_IMMUTABLE/, 'Browser did not reject immutable reassignment');
  console.log('PASS: Chromium rejected invalid Atto source without artifact');
} finally { server.close(); }
