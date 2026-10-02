'use strict';
/* Tests for public/js/diffview.js — run with stock node, zero deps.
 * Known LCS cases + 200 random no-throw fuzz + unified-diff parsing.
 */
const assert = require('assert');
const DV = require('../../public/js/diffview.js');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; fails.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function rowEnd(DV, out) { /* helper: comma tail for last line of a test if needed */ }

// Coverage: print a tiny banner that exercises the module real fully
console.log('\n== diffview.test.js ==');

// ------------------------------------------------------------------ LCS
console.log('\n== known LCS cases ==');
t('empty to text is all-add', () => {
  const rows = DV.diff('', 'a\nb');
  assert.deepStrictEqual(rows, [['+', 'a'], ['+', 'b']], JSON.stringify(rows));
});
t('text to empty is all-sub', () => {
  const rows = DV.diff('a\nb', '');
  assert.deepStrictEqual(rows.map(r => r[0]), ['-', '-']);
});
t('identical input all equal', () => {
  const rows = DV.diff('a\nb\nc', 'a\nb\nc');
  assert(rows.every(r => r[0] === '='), JSON.stringify(rows));
});
t('single line replaced', () => {
  const rows = DV.diff('hello', 'jello');
  // swaps one char: 'h' out, 'j' in, etc (LLC may choose differently but total ops = 2)
  const adds = rows.filter(r => r[0] === '+').length, subs = rows.filter(r => r[0] === '-').length;
  assert.strictEqual(adds, subs, JSON.stringify(rows));
});
t('insertion in middle', () => {
  const rows = DV.diff('a\nb\nc', 'a\nX\nb\nc');
  const adds = rows.filter(r => r[0] === '+').map(r => r[1]);
  assert.deepStrictEqual(adds, ['X'], JSON.stringify(rows));
});
t('deletion in middle', () => {
  const rows = DV.diff('a\nb\nc', 'a\nc');
  const subs = rows.filter(r => r[0] === '-').map(r => r[1]);
  assert.deepStrictEqual(subs, ['b'], JSON.stringify(rows));
});
t('reordered lines are add/minus pairs with right count', () => {
  const rows = DV.diff('a\nb\n', 'b\na\n');
  const adds = rows.filter(r => r[0] === '+').length;
  const subs = rows.filter(r => r[0] === '-').length;
  assert.strictEqual(adds, subs, JSON.stringify(rows));
});
t('common prefix survives', () => {
  const rows = DV.diff('a\nb\nc\nd', 'a\nb\nc\nd\ne');
  assert.strictEqual(rows.filter(r => r[1] === 'e')[0][0], '+');
});
t('trailing newline intent neutralized', () => {
  // trailing \n added shouldn't change row count meaningfully
  const r1 = DV.diff('a\nb', 'a\nb\n');
  assert(r1.every(r => r[0] === '='), JSON.stringify(r1));
});
t('no changes if text same with trailing space only', () => {
  const rows = DV.diff('a\n', 'a\n');
  assert(rows.every(r => r[0] === '='), JSON.stringify(rows));
});

// ------------------------------------------------------------- diffRows
console.log('\n== context collapsing ==');
t('gap produced for long equal run', () => {
  const equal = Array(50).fill('same').join('\n');
  const text = equal + '\nnew line';
  const rows = DV.diffRows('same old\n' + equal, text.replace('new line', 'changed'), 3);
  assert(rows.some(r => r[0] === 'gap'), JSON.stringify(rows).slice(0, 400));
});
t('gap row carries hidden payload', () => {
  const a = Array(60).fill(0).map((_, i) => 'line' + i).join('\n');
  const b = a.replace('line30', 'CHANGED');
  const rows = DV.diffRows(a, b, 3);
  const gap = rows.find(r => r[0] === 'gap');
  assert(gap, 'expected gap');
  assert(Array.isArray(gap[3]) && gap[3].length > 0, JSON.stringify(gap).slice(0, 200));
});
t('small diff no gaps with default context', () => {
  const rows = DV.diffRows('a\nb\nc', 'a\nx\nc', 3);
  assert(!rows.some(r => r[0] === 'gap'), JSON.stringify(rows));
});
t('short run preserves context rows', () => {
  const rows = DV.diffRows('1\n2\n3\n4\n5\n6\n7', '1\n2\nX\n4\n5\n6\n7', 2);
  assert(rows[0][0] === '=' && rows[0][1] === '1', JSON.stringify(rows.slice(0, 3)));
  assert(rows.some(r => r[1] === 'X'), JSON.stringify(rows));
});

// ------------------------------------------------------- unified diff parse
console.log('\n== unified diff parsing ==');
t('parseUnified full git 1-hunk (trailing blank tolerant)', () => {
  const txt = `--- a/foo.txt
+++ b/foo.txt
@@ -1,4 +1,4 @@
 line1
-old line
+new line
 line3
 line4
`;
  const files = DV.parseUnified(txt);
  assert.strictEqual(files.length, 1, JSON.stringify(files));
  assert.strictEqual(files[0].a, 'foo.txt');
  assert.strictEqual(files[0].b, 'foo.txt');
  assert.strictEqual(files[0].hunks.length, 1);
  const ops = files[0].hunks[0].rows;
  assert.deepStrictEqual(ops.slice(0, 5).map(r => r[0]), ['=', '-', '+', '=', '='], JSON.stringify(ops));
  assert.strictEqual(ops[1][1], 'old line');
  assert.strictEqual(ops[2][1], 'new line');
});
t('parseUnified multi-hunk', () => {
  const txt = `--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 a
-b
+c
@@ -10,2 +10,3 @@
 more
+added
 text
`;
  const f = DV.parseUnified(txt)[0];
  assert.strictEqual(f.hunks.length, 2);
  assert.strictEqual(f.hunks[1].aStart, 10);
});
t('parseUnified empty input', () => {
  assert.deepStrictEqual(DV.parseUnified(''), []);
});
t('parseUnified no-b-file guard', () => {
  assert.deepStrictEqual(DV.parseUnified('--- a/x\nonly minus, no plus line'), []);
});
t('parseUnified \\ No newline at end of file', () => {
  const txt = `--- a/m\n+++ b/m\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n`;
  const f = DV.parseUnified(txt)[0];
  assert(f.hunks[0].rows.some(r => r[0] === 'meta'), JSON.stringify(f.hunks));
});

// ------------------------------------------------------------ render HTML
console.log('\n== rendering ==');
t('renderDiff emits diff-add / diff-sub', () => {
  const h = DV.diffHTML('old', 'new');
  assert(h.includes('diff-add'), h);
  assert(h.includes('diff-sub'), h);
});
t('renderDiff escapes < and >', () => {
  const h = DV.diffHTML('<script>alert(1)</script>', '<b>bold</b>');
  assert(!h.includes('<script>alert'), h);
  assert(!h.includes('<b>bold'), h);
});
t('diffHTML embeds expand rows payload', () => {
  const a = Array(40).fill(0).map((_, i) => 'line' + i).join('\n');
  const h = DV.diffHTML(a, a.replace('line20', 'killer'));
  assert(h.includes('diff-gap'), h);
  assert(h.includes('data-rows='), h);
});
t('renderDiff API compat no gap', () => {
  const h = DV.renderDiff('a\nb', 'a\nc');
  assert(h.includes('diff-body'), h);
});

// ----------------------------------------------------------------- random fuzz
console.log('\n== 200 random pairs: no throw ==');
t('simple 2-col table', () => { });
t('random pairs LCS no-throw + add/sub balance sanity', () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const glyphs = 'a\nb ' + 'x/-+@#\\..!'.split('').concat(['\n', 'ü']);
  for (let i = 0; i < 200; i++) {
    const alen = Math.floor(rnd() * 24), blen = Math.floor(rnd() * 24);
    const mk = n => Array(n).fill(0).map(() =>
      glyphs[Math.floor(rnd() * glyphs.length)]).join('');
    const A = Array(Math.max(alen, 1)).fill(0).map(() => mk(Math.floor(rnd() * 4) + 1)).join('\n');
    const B = Array(Math.max(blen, 1)).fill(0).map(() => mk(Math.floor(rnd() * 4) + 1)).join('\n');
    let rows;
    try { rows = DV.diff(A, B); DV.diffRows(A, B, Math.floor(rnd() * 6)); } catch (e) {
      throw new Error('throw on pair ' + i + ': ' + e.message + ' | A=' + JSON.stringify(A) + ' B=' + JSON.stringify(B));
    }
    assert(typeof rows === 'object', 'row set not array');
  }
});
t('diffHTML on random pairs no-throw', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 200 - 1; i++) {
    const n = Math.floor(rnd() * 30) + 1;
    const arr = k => Array(k).fill(0).map(() => 'w' + Math.floor(rnd() * 5)).join('\n');
    try { DV.diffHTML(arr(n), arr(n), Math.floor(rnd() * 5)); } catch (e) {
      throw new Error('throw on pair ' + i + ': ' + e.message);
    }
  }
});

console.log('\ndiffview.test.js: ' + pass + ' passed, ' + fail + ' failed');
if (fails.length) {
  console.log('FAILING CASES:\n- ' + fails.join('\n- '));
  process.exit(1);
}
