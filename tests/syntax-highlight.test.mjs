import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenizeAtto} from '../src/syntax-highlight.js';
const find = (src, part) => tokenizeAtto(src).find(t=>t.text===part)?.kind;
test('formatter-derived keywords and compiler types are highlighted', () => {
  const source='pub fnc main(): int { return 42; }';
  assert.equal(find(source,'pub'),'keyword');
  assert.equal(find(source,'fnc'),'keyword');
  assert.equal(find(source,'main'),'function');
  assert.equal(find(source,'int'),'type');
  assert.equal(find('return true;','true'),'literal');
  assert.equal(find('critical-read','critical-read'),'keyword');
});
test('strings and nested comments never produce nested keywords', () => {
  const source='// fnc <script>\n/* out /* inside */ more */\n"return // literal"';
  const tokens=tokenizeAtto(source);
  assert.equal(tokens.map(t=>t.text).join(''),source);
  assert.equal(tokens.filter(t=>t.kind==='comment').length,2);
  assert.equal(tokens.filter(t=>t.kind==='string').length,1);
  assert.equal(tokens.filter(t=>t.kind==='keyword').length,0);
});
test('preserves source exactly with unicode, escapes, CRLF and invalid/incomplete code', () => {
  for(const s of ['fnc f() {return 42;}\r\n',"'escape\\'quote'", '🚀 <img onerror=boom>',
    '/* unfinished','"unfinished','let x=0xBEEF+0b101;','x--y'])
    assert.equal(tokenizeAtto(s).map(t=>t.text).join(''),s);
});

test('four suspension spellings are highlighted with exact source preservation',()=>{
  for(const spelling of ['suspends','susp','⧖','∂']){
    const source='pub '+spelling+' fnc fetch(): int { return 42; }';
    assert.equal(find(source,spelling),'keyword');
    assert.equal(tokenizeAtto(source).map(t=>t.text).join(''),source);
    for(const trivia of ['// '+spelling,'/* '+spelling+' */','"'+spelling+'"'])
      assert.equal(tokenizeAtto(trivia).some(t=>t.kind==='keyword'),false);
  }
  for(const id of ['suspension','susp2','suspπ','πsusp','suspends变量','▽'])
    assert.equal(tokenizeAtto(id).some(t=>t.kind==='keyword'),false,id);
});
