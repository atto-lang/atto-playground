import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAGES_ASSETS } from '../scripts/package-pages.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('conditional Fibonacci remains intact and match variant terminates with end', async () => {
  const [original, matched] = await Promise.all([read('examples/fib.atto'), read('examples/fib-match.atto')]);
  assert.match(original, /if n < 2 then\s+return n;\s+fi/);
  assert.doesNotMatch(original, /return match n over/);
  assert.match(matched, /return match n over\s+on 0 -> 0,\s+on 1 -> 1,\s+default ->\s+fib\(n - 1\) \+ fib\(n - 2\),\s+end/);
  assert.match(matched, /return fib\(12\);/);
  assert.equal(matched.split('\n').filter(line => line.trim() === 'end').length, 1, 'match has a single end terminator');
});

test('pattern matching is a distinct selectable built-in and a release asset', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('src/app.js')]);
  assert.match(html, /<option value="fib">Recursion<\/option><option value="fib-match">Fibonacci — pattern matching<\/option>/);
  assert.match(app, /'hello', 'fib', 'fib-match', 'suspends-await', 'task-future', 'primes'/);
  assert.ok(PAGES_ASSETS.includes('examples/fib.atto'));
  assert.ok(PAGES_ASSETS.includes('examples/fib-match.atto'));
});

test('contract accurately describes executable match and preview limitations', async () => {
  const contract = await read('docs/COMPILER_CONTRACT.md');
  assert.match(contract, /return match x over/);
  assert.match(contract, /general value-position/);
  assert.doesNotMatch(contract, /- `match`, imports/);
  assert.doesNotMatch(contract, /33 enumerated/);
});

test('suspends/await and task/future are honest previews with no browser fallback', async () => {
  const [html, app, picker, a, b] = await Promise.all([
    read('index.html'), read('src/app.js'), read('src/program-picker.js'),
    read('examples/suspends-await.atto'), read('examples/task-future.atto'),
  ]);
  assert.match(html, /value="suspends-await">suspends \/ await \(preview\)/);
  assert.match(html, /value="task-future">task \{ \} \/ Future \(preview\)/);
  assert.match(app, /'suspends-await', 'task-future'/);
  assert.match(picker, /Syntax preview — async\/task is not compiled yet/);
  assert.match(a, /suspends fnc delayedAnswer\(\): int/);
  assert.match(a, /await rt\.sleep\(25\)/);
  assert.match(b, /val first = task \{/);
  assert.match(b, /await first \+ await second/);
  for (const name of ['suspends-await', 'task-future']) {
    assert.ok(PAGES_ASSETS.includes('examples/' + name + '.atto'), name + ' must be release-allowlisted');
  }
});
