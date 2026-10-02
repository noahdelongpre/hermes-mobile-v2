'use strict';
/* Tests for public/js/md.js — run with stock node, zero deps.
 * Focus: XSS passthrough proof, block/inline/table/fence behavior.
 */
const assert = require('assert');
const MD = require('../../public/js/md.js');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; fails.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
}
function noTag(html, needle) { assert(!html.includes(needle), 'leaked: ' + needle + ' in ' + html); }

// ---------------------------------------------------------------- XSS GATE
console.log('\n== XSS passthrough proof ==');
t('raw <script> never survives', () => {
  const h = MD.render('<script>alert(1)</script>');
  noTag(h, '<script>'); noTag(h, 'alert(1)</script');
});
t('img onerror never survives as tag', () => {
  const h = MD.render('<img src=x onerror=alert(1)>');
  noTag(h, '<img'); assert(h.includes('&lt;img'), h);
});
t('javascript: href neutralized to #', () => {
  const h = MD.render('[click me](javascript:alert(1))');
  noTag(h, 'javascript:'); assert(h.includes('href="#"'), h);
});
t('data: href neutralized', () => {
  const h = MD.render('[x](data:text/html,<script>1</script>)');
  noTag(h, 'data:text/html');
});
t('fenced code with script payload is literal text', () => {
  const h = MD.render("```html\n<script>alert(1)</script>\n```");
  noTag(h, '<script>'); // markup-tag shaped string must never appear
});
{
  const h = MD.render("```\n<script>alert(1)</script>\n```");
  t('plain fence carries &lt;script&gt; literal', () => assert(h.includes('&lt;script&gt;'), h));
}
t('inline code with script payload is literal', () => {
  const h = MD.render('use `<script>` tag');
  noTag(h, '<script>'); assert(h.includes('&lt;script&gt;'), h);
});
t('angry quotation table cell', () => {
  const h = MD.render('| a | b |\n| - | - |\n| <script> | x |');
  noTag(h, '<script>');
});
t('quote block injection', () => {
  const h = MD.render('> hello <img src=x onerror=alert(1)>');
  noTag(h, '<img'); assert(h.includes('&lt;img') || h.includes('&gt;'), h);
});
t('link text injection is escaped', () => {
  const h = MD.render('[**bold <script>**](https://x.y)');
  noTag(h, '<script>');
});
t('code tokenizer output is fully escaped', () => {
  const h = MD.render("```html\n<script>alert(1)</script>\n```");
  noTag(h, '<script>'); assert(h.includes('&lt;'), h);
});
t('highlight unknown lang falls back escaped', () => {
  const h = MD.highlight('<img onerror=alert(1)> source', 'cobol');
  noTag(h, '<img onerror'); assert(h.includes('&lt;'), h); // tag shown as escaped text
});
t('srcdoc/iframe neutralized', () => {
  const h = MD.render('<iframe src="javascript:alert(1)"></iframe>');
  noTag(h, '<iframe'); noTag(h, '<script>');
});
t('event handler in inline text neutralized', () => {
  const h = MD.render('text "onmouseover="alert(1)"');
  noTag(h, 'onmouseover=');
});

// -------------------------------------------------------------- inline
console.log('\n== inline / emphasis ==');
t('bold + italic combos', () => {
  const h = MD.render('**bold** *it* ***tri***');
  assert(h.includes('<b data-tpl="1">bold</b>'), h);
  assert(h.includes('<i data-tpl="1">it</i>'), h);
  assert(h.includes('<b data-tpl="1"><i data-tpl="1">tri</i></b>'), h);
});
t('strikethrough', () => {
  const h = MD.render('~~gone~~');
  assert(h.includes('<del data-tpl="1">gone</del>'), h);
});
t('inline code protects emphasis', () => {
  const h = MD.render('`**not bold**`');
  assert(!h.includes('<b'), h);
  assert(h.includes('**not bold**'), h);
});
t('links with rel noopener + target blank', () => {
  const h = MD.render('[hermes](https://hermes.dev)');
  assert(h.includes('rel="noopener noreferrer"'), h);
  assert(h.includes('target="_blank"'), h);
});
t('reference links', () => {
  const h = MD.render('see [h1] there\n\n[h1]: https://x.dev');
  assert(h.includes('href="https://x.dev"'), h);
});
t('escaped asterisk is literal', () => {
  const h = MD.render('a \\* b');
  assert(!h.includes('<i'), h);
  assert(h.includes('a * b'), h);
});

// ------------------------------------------------------------------ blocks
console.log('\n== blocks ==');
t('headings h1-h6', () => {
  const h = MD.render('# a\n## b\n###### f');
  for (const l of [1, 2, 6]) assert(h.includes('<h' + l + '>'), h);
});
t('ordered and unordered lists', () => {
  const h = MD.render('- x\n- y\n\n1. a\n2. b');
  assert(h.includes('<ul>') && h.includes('<li>x</li>'), h);
  assert(h.includes('<ol>') && h.includes('<li>a</li>'), h);
});
t('task list checked + unchecked', () => {
  const h = MD.render('- [x] done\n- [ ] todo');
  assert(h.includes('tasklist'), h);
  assert(h.includes('checked'), h);
  assert(h.includes('done') && h.includes('todo'), h);
});
t('blockquote with nested format', () => {
  const h = MD.render('> quote **bold**');
  assert(h.includes('<blockquote'), h);
  assert(h.includes('<b data-tpl="1">bold</b>'), h);
});
t('paragraph join keeps lines', () => MD.render('a\nb').includes('<p>a\nb</p>'));

// ------------------------------------------------------------------ tables
console.log('\n== tables ==');
t('simple 2-col table', () => {
  const h = MD.render('| h1 | h2 |\n| --- | --- |\n| a | b |');
  assert(h.includes('<table>'), h);
  assert(h.includes('<th>h1</th>'), h);
  assert(h.includes('<td>a</td>'), h);
});
t('table with escaping inside cells', () => {
  const h = MD.render('| x | y |\n| --- | --- |\n| `<b>` | bold |');
  noTag(h, '<b>');
});

// --------------------------------------------- code fences + highlighting
console.log('\n== code fences + highlighting ==');
t('fence with lang gets copy button', () => {
  const h = MD.render('```js\nconst x = 1;\n```');
  assert(h.includes('data-copy'), h);
  assert(h.includes('lang-js'), h);
});
t('js highlighting wraps keywords', () => {
  const h = MD.highlight('const x = 1; // hi', 'js');
  assert(h.includes('tk-kw">const'), h);
  assert(h.includes('tk-cmt">'), h);
  assert(h.includes('tk-num">1'), h);
});
t('py highlighting def/None', () => {
  const h = MD.highlight('def f():\n    return None', 'py');
  assert(h.includes('tk-kw">def'), h);
  assert(h.includes('tk-kw">None'), h);
});
t('json highlighting str+num', () => {
  const h = MD.render('```json\n{"a": 1}\n```');
  assert(h.includes('tk-str'), h);
  assert(h.includes('tk-num">1'), h);
});
t('bash highlighting export', () => {
  const h = MD.render('```bash\nexport FOO=1\n```');
  assert(h.includes('tk-kw">export'), h);
});
t('css highlighting selector+attr', () => {
  const h = MD.render('```css\n.m {\n color: red;\n}\n```');
  assert(h.includes('tk-sel') || h.includes('tk-attr'), h);
});
t('html highlighting tag+str', () => {
  const h = MD.render('```html\n<div class="x"></div>\n```');
  assert(h.includes('tk-tag'), h);
  assert(h.includes('tk-str'), h);
});
t('plain fence no highlighting markers', () => {
  const h = MD.render('```\nno lang\n```');
  assert(!h.includes('tk-kw'), h);
});
t('fence unterminated (streaming) still renders', () => {
  const h = MD.render('```js\nconst i = 0; // no closing');
  assert(h.includes('codeblock'), h);
});
t('fence indented 2 spaces', () => {
  const h = MD.render('  ```js\n  code();\n  ```');
  assert(h.includes('codeblock'), h);
});

// ------------------------------------------------------------------- misc
console.log('\n== misc ==');
t('render always returns a string', () => MD.render(null) + MD.render(undefined) + MD.render(''));
t('empty string', () => MD.render('') === '');
t('unicode text survives', () => {
  const h = MD.render('héllo wörld 你好 🎉');
  assert(h.includes('héllo wörld 你好 🎉'), h);
});
t('mid-run incremental render stable (streaming)', () => {
  let s = '**unfinis';
  const h = MD.render(s);
  const h2 = MD.render(s + 'hed**');
  assert(h.includes('unfinis') && h2.includes('<b data-tpl="1">unfinished</b>'), h + ' /2/ ' + h2);
});

console.log('\nmd.test.js: ' + pass + ' passed, ' + fail + ' failed');
if (fails.length) {
  console.log('FAILING CASES:\n- ' + fails.join('\n- '));
  process.exit(1);
}
