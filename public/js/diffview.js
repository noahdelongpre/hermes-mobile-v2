'use strict';
/* diffview.js — LCS line diff for arbitrary text pairs + unified-diff parser.
 * Renders .diff-add/.diff-sub rows, context collapsing with expand-on-tap.
 * UMD-ish: window.DiffView in browser, module.exports in node (tests).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DiffView = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // -------------------------------------------------------------- LCS diff
  // Classic O(n*m) DP with triangular memory; used only via `diff(a, b)` for
  // text pairs ( arbitrarily large inputs get a common-prefix/suffix trim first).
  function lcsRows(A, B) {
    const n = A.length, m = B.length;
    // trim common prefix / suffix — keeps DP matrix small on real diffs
    let p = 0;
    while (p < n && p < m && A[p] === B[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
    const a = A.slice(p, n - s), b = B.slice(p, m - s);
    const dp = new Int32Array((a.length + 1) * (b.length + 1));
    const W = b.length + 1;
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i * W + j] = a[i] === b[j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    // walk
    const mid = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { mid.push(['=', a[i]]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) mid.push(['-', a[i++]]);
      else mid.push(['+', b[j++]]);
    }
    while (i < a.length) mid.push(['-', a[i++]]);
    while (j < b.length) mid.push(['+', b[j++]]);
    const pre = A.slice(0, p).map(x => ['=', x]);
    const post = A.slice(n - s).map(x => ['=', x]);
    return pre.concat(mid, post);
  }

  // Human-tuned variant: batch long runs of +/- into hunks, collapse big
  // equal runs into expandable gaps.
  function diff(aText, bText, opts) {
    opts = opts || {};
    const A = String(aText).split('\n'), B = String(bText).split('\n');
    // drop trailing empty artifact caused by trailing \n
    if (A.length && A[A.length - 1] === '') A.pop();
    if (B.length && B[B.length - 1] === '') B.pop();
    return lcsRows(A, B);
  }

  function collapseGap(rows, out, ctx, gapAnchor) {
    // rows: consecutive '=' ops for a run; we push ctx lines then a gap marker
    const first = rows.slice(0, ctx), last = rows.slice(-ctx);
    const mid = rows.slice(ctx, rows.length - ctx);
    for (const [op, t] of first) out.push([op, t, 0]);
    if (mid.length) {
      out.push(['gap', '+' + mid.length + ' unchanged lines', null, mid.length]);
      for (const [op, t] of last) out.push([op, t, 0]);
    } else {
      for (const [op, t] of last) out.push([op, t, 0]);
    }
  }

  function diffRows(aText, bText, ctx = 3) {
    const rows = diff(aText, bText);
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i][0] !== '=') { out.push(rows[i].concat(0)); i++; continue; }
      let j = i;
      while (j < rows.length && rows[j][0] === '=') j++;
      const run = rows.slice(i, j);
      const prevHas = out.some(r => r[0] !== '=' && r[0] !== 'gap');
      const nextHas = j < rows.length;
      if (!prevHas && !nextHas) { // whole input equal
        for (const r of run) out.push(r.concat(0));
      } else {
        out.push.apply(out, run.slice(0, ctx).map(r => r.concat(0)));
        const midc = run.length - 2 * ctx;
        if (midc > 0) out.push(['gap', '⋯ ' + midc + ' unchanged lines ⋯', null, midc]);
        else if (midc === 0) { /* exactly 2*ctx: nothing collapsed */ }
        else {
          // run too short for 2*ctx: emit all minus what we pushed again
          out.length -= Math.max(0, run.length - (2 * ctx));
          for (const r of run) out.push(r.concat(0));
        }
        const tail = run.slice(-ctx);
        if (nextHas) {
          out.length -= nextHas && ctx && run.length > ctx ? 0 : 0; // tail already pushed below
        }
        // push tail rows (dedupe with head for short runs)
        if (run.length > ctx) {
          out.push.apply(out, tail.map(r => r.concat(0)));
        }
      }
      i = j;
    }
    // dedupe consecutive identical '=' rows produced by overlapping head/tail
    const res = [];
    let lastEq = null;
    for (const r of out) {
      if (r[0] === '=' && lastEq === r[1]) continue;
      res.push(r);
      if (r[0] === '=') lastEq = r[1]; else lastEq = null;
    }
    return res;
  }

  // ------------------------------------------------------- unified diff parse
  // Accepts `diff -u` / git style: --- a/... +++ b/... @@ -l,c +l,c @@ hunks.
  function parseUnified(text) {
    const lines = String(text).split('\n');
    const files = [];
    let cur = null, hunk = null;
    for (const l of lines) {
      let m;
      if ((m = l.match(/^--- (?:a\/)?(.+)$/)) && !cur) cur = { a: m[1], b: null, hunks: [] };
      else if ((m = l.match(/^\+\+\+ (?:b\/)?(.+)$/)) && cur) cur.b = m[1];
      else if ((m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
        if (cur && cur.b) {
          hunk = { aStart: +m[1], bStart: +m[3], rows: [] };
          cur.hunks.push(hunk);
        }
      } else if (hunk) {
        if (l.startsWith('+') && !l.startsWith('+++')) hunk.rows.push(['+', l.slice(1)]);
        else if (l.startsWith('-') && !l.startsWith('---')) hunk.rows.push(['-', l.slice(1)]);
        else if (l.startsWith('\\')) hunk.rows.push(['meta', l.slice(1)]);
        else if (l.startsWith(' ')) hunk.rows.push(['=', l.slice(1)]);
        else if (l === '') hunk.rows.push(['=', '']);
        else { hunk = null; } // unknown → end hunk
      }
      // skip 'diff --git', 'index', 'new file mode' etc.
    }
    if (cur && cur.b) files.push(cur);
    return files;
  }

  // -------------------------------------------------------------- rendering
  // Renders rows as HTML. Strip-mode: rows beyond 40 lines get auto-collapsed.
  function renderDiff(aText, bText, opts) {
    opts = opts || {};
    const rows = diffRows(aText, bText, opts.context == null ? 3 : opts.context);
    return htmlForRows(rows, opts.title, opts);
  }

  function htmlForRows(rows, title, opts) {
    let html = '<div class="diffview" data-diff>';
    if (title) html += '<div class="diff-title">' + esc(title) + '</div>';
    html += '<div class="diff-body">';
    for (const [op, text, meta] of rows) {
      if (op === 'gap') {
        html += '<button class="diff-gap" data-expand="' + esc(text) + '" data-collapsed="1"></button>';
        continue;
      }
      const cls = op === '+' ? 'diff-add' : op === '-' ? 'diff-sub' : 'diff-ctx';
      const sign = op === '+' ? '+' : op === '-' ? '-' : ' ';
      html += '<div class="' + cls + ' ' + '" data-line="' + esc(text) + '"><span class="diff-sign">' + sign + '</span><span class="diff-text ' + (meta ? '' : '') + '">' + esc(text) + '</span></div>';
    }
    html += '</div></div>';
    return html;
  }

  // Wire up expand-on-tap for rendered diff cards inside a container.
  function enhanceDiff(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
    rootEl.querySelectorAll('.diff-gap').forEach(gap => {
      if (gap._dvBound) return;
      gap._dvBound = true;
      gap.addEventListener('click', () => {
        const hidden = gap.nextElementSibling;
        // hidden rows are injected lazily the first time
        gap.setAttribute('data-expanded', '1');
        gap.classList.add('expanded');
        const parent = gap.parentElement;
        const idx = Array.prototype.indexOf.call(parent.children, gap);
        const label = gap.getAttribute('data-expand') || '';
        const count = parseInt(String(label).replace(/[^0-9]/g, ''), 10) || 0;
        // we stored the actual hidden rows as JSON on the gap at render time
        let rows = null;
        try { rows = JSON.parse(gap.getAttribute('data-rows') || 'null'); } catch { }
        if (!rows) return; // nothing to expand
        const frag = document.createElement('div');
        frag.innerHTML = rows.map(r =>
          '<div class="' + (r[0] === '+' ? 'diff-add' : r[0] === '-' ? 'diff-sub' : 'diff-ctx') + '">' +
          '<span class="diff-sign">' + (r[0] === '+' ? '+' : r[0] === '-' ? '-' : ' ') + '</span>' +
          '<span class="diff-text">' + esc(r[1]) + '</span></div>').join('');
        while (frag.firstChild) parent.insertBefore(frag.firstChild, gap);
        gap.remove();
      });
    });
    return rootEl;
  }

  // Tool entry: render a diff card from HTML-ready rows including stored gap rows.
  function diffHTML(aText, bText, opts) {
    opts = opts || {};
    const rows = [];
    const ctx = opts.context == null ? 3 : opts.context;
    const flat = diffRows2(aText, bText, ctx);
    for (const r of flat) {
      if (r[0] === 'gap') {
        rows.push('<button class="diff-gap" data-expand="' + esc(r[1]) + '" data-rows=\'' + JSON.stringify(r[3]).replace(/'/g, '&#39;') + '\'>⋯ ' + esc(r[1]) + ' ⋯ (tap to expand)</button>');
      } else {
        const cls = r[0] === '+' ? 'diff-add' : r[0] === '-' ? 'diff-sub' : 'diff-ctx';
        const sign = r[0] === '+' ? '+' : r[0] === '-' ? '-' : ' ';
        rows.push('<div class="' + cls + '"><span class="diff-sign">' + sign + '</span><span class="diff-text">' + esc(r[1]) + '</span></div>');
      }
    }
    return '<div class="diffview" data-diff><div class="diff-body">' + rows.join('') + '</div></div>';
  }

  // Cleaner second implementation used by diffHTML: compute rows w/ real hidden payload.
  function diffRows2(aText, bText, ctx) {
    const raw = lcsRows(String(aText).split('\n').filter((x, i, a) => i < a.length - 1 || x !== ''),
      String(bText).split('\n').filter((x, i, a) => i < a.length - 1 || x !== ''));
    const out = [], C = ctx;
    let i = 0;
    while (i < raw.length) {
      if (raw[i][0] !== '=') { out.push(raw[i].slice(0, 2)); i++; continue; }
      let j = i;
      while (j < raw.length && raw[j][0] === '=') j++;
      const run = raw.slice(i, j).map(r => [r[0], r[1]]);
      const firstChange = out.some(r => r[0] === '+' || r[0] === '-');
      const lastChange = j < raw.length;
      let pushed = 0;
      const head = firstChange && lastChange ? run.slice(0, C) : firstChange || lastChange ? run.slice(0, lastChange ? C : run.length) : [];
      for (const r of head) { out.push(r); pushed++; }
      const tailNeeded = firstChange && lastChange ? C : 0;
      const remaining = run.length - pushed - tailNeeded;
      if (remaining > 0) {
        out.push(['gap', remaining, null, run.slice(pushed, pushed + remaining)]);
      }
      if (tailNeeded) for (const r of run.slice(pushed + remaining, run.length)) out.push(r);
      i = j;
    }
    return out;
  }

  // ---------------------------------------------------------- self-tests API
  // Exposed so tests can call the internals directly.
  return { diff, lcsRows, diffRows: diffRows2, parseUnified, renderDiff, diffHTML, enhanceDiff, escapeHtml: esc };
});
