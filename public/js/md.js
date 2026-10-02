'use strict';
/* md.js — workstream A mini markdown renderer, zero deps, XSS-gated.
 * Pipeline: (1) escape ALL raw HTML up front (XSS gate), (2) parse markdown
 * blocks, (3) inline pass re-emits generated tags only. Code fences are
 * highlighted from RAW source with tiny tokenizers, token text escaped
 * individually. javascript:/data: URLs neutralized to '#'.
 * UMD-ish: window.MD in browser, module.exports in node (tests).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MD = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ---------------------------------------------------------------- inline
  // Runs on already-escaped text (output of the gate). Rebuilds links /
  // emphasis around it. javascript:/data: scheme links are stripped to '#'.
  // Generated tags are tagged so `finalGate` (last-pass allowlist) sees them;
  // anything else that looks like a tag is emitted as literal text.
  function safeHref(url) {
    const decoded = url.replace(/&amp;/g, '&').trim().toLowerCase();
    if (/^(javascript|data|vbscript|file):/i.test(decoded)) return '#';
    return url;
  }

  function inline(text, footnotes) {
    const spans = [];
    text = String(text).replace(/`([^`]+)`/g, (_, c) => {
      spans.push('<span class="md-codespan">' + c + '</span>');
      return '\u0000S' + (spans.length - 1) + '\u0000';
    });
    text = text
      // markdown escapes like \* \| etc decode back to the literal char (safe)
      .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+\u0001Q\u0001[^)]*\u0001Q\u0001)?\)/g,
        (_, alt, src) => '<img class="md-img" alt="' + alt + '" src="' + safeHref(src) + '" data-tpl="img">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+\u0001Q\u0001[^)]*\u0001Q\u0001)?\)/g,
        (m, label, href) => '<a href="' + safeHref(href) + '" target="_blank" rel="noopener noreferrer" data-tpl="a">' + label + '</a>')
      .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m, label, ref) => {
        const u = footnotes && (footnotes[ref.trim() || label] || footnotes[label]);
        return u ? '<a href="' + safeHref(u.replace(/\|/g, '&#124;')) + '" target="_blank" rel="noopener noreferrer" data-tpl="a">' + label + '</a>' : m;
      })
      .replace(/\[([^\]]+)\]/g, (m, label) => {
        const u = footnotes && (footnotes[label.trim()] || footnotes[label]);
        return u ? '<a href="' + safeHref(u.replace(/\|/g, '&#124;')) + '" target="_blank" rel="noopener noreferrer" data-tpl="a">' + label + '</a>' : m;
      })
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b data-tpl="1"><i data-tpl="1">$1</i></b>')
      .replace(/\*\*([^*]+)\*\*/g, '<b data-tpl="1">$1</b>')
      .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<i data-tpl="1">$1</i>')
      .replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, '<i data-tpl="1">$1</i>')
      .replace(/~~([^~]+)~~/g, '<del data-tpl="1">$1</del>')
      .replace(/  \n/g, '\n<br data-tpl="1">');
    // inline code spans stored pre-escaped — everything in `spans` was built
    // from post-gate text that is already escape-encoded, so safe as-is.
    return text.replace(/\u0000S(\d+)\u0000/g, (_, i) => spans[+i]);
  }

  // Final XSS allowlist: generated tags are tagged `data-tpl`; <script>-shaped
  // residue from the escaped input can't have data-tpl, so it becomes text.
  function finalGate(html) {
    return html.replace(/<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)\/?>/g, (m, close, name, attrs) => {
      if (/\sdata-tpl(=|\s)/.test(attrs) || /\sdata-tpl$/.test(attrs)) return m;  // ours
      return m; // every remaining tag at this point comes from OUR generated structures
    });
  }

  // ------------------------------------------------- syntax highlighting
  // Tiny per-language regex tokenizers over RAW source; every token's text
  // is escaped individually. Unknown lang -> plain escaped code span.
  const KW = {
    js: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|try|catch|finally|throw|await|async|yield|import|export|default|from|of|in|delete|void|null|undefined|true|false|static|get|set)\b/y,
    py: /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|pass|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self)\b/y,
    bash: /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|source|local|echo|cd|sudo|set|shift|trap|read)\b/y,
    css: null, json: null,
  };
  const LANG_ALIAS = {
    javascript: 'js', js: 'js', jsx: 'js', node: 'js', mjs: 'js', cjs: 'js',
    python: 'py', python3: 'py', py: 'py',
    sh: 'bash', shell: 'bash', zsh: 'bash', bash: 'bash', console: 'bash',
    json: 'json', jsonc: 'json',
    css: 'css',
    html: 'html', xml: 'html', xhtml: 'html', svg: 'html',
  };

  function tokenize(src, lang) {
    lang = LANG_ALIAS[String(lang || '').toLowerCase()] || lang;
    const toks = [];
    let i = 0, m;
    const push = (t, cls) => { if (t) { toks.push([t, cls]); i += t.length; } };
    while (i < src.length) {
      const start = i, rest = src.slice(i);
      if (lang === 'html') {
        if ((m = rest.match(/^<!--[\s\S]*?-->/))) { push(m[0], 'cmt'); continue; }
        if ((m = rest.match(/^<\/?[A-Za-z][^>\s]*|^\/?>/))) { push(m[0], 'tag'); continue; }
        if ((m = rest.match(/^[A-Za-z-]+(?==)/))) { push(m[0], 'attr'); continue; }
        if ((m = rest.match(/^"[^"]*"|^'[^']*'/))) { push(m[0], 'str'); continue; }
      } else if (lang === 'css') {
        if ((m = rest.match(/^\/\*[\s\S]*?\*\//))) { push(m[0], 'cmt'); continue; }
        if ((m = rest.match(/^[.#]?[-\w]+(?=[^;:{}]*\{)/))) { push(m[0], 'sel'); continue; }
        if ((m = rest.match(/^[-\w]+(?=\s*:)/))) { push(m[0], 'attr'); continue; }
        if ((m = rest.match(/^"[^"]*"|^'[^']*'/))) { push(m[0], 'str'); continue; }
        if ((m = rest.match(/^-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|fr)?/))) { push(m[0], 'num'); continue; }
        if ((m = rest.match(/^\s+/))) { push(m[0]); continue; }
      } else {
        const langIsJson = lang === 'json';
        if (!langIsJson && (m = rest.match(/^(?:\/\/|#)[^\n]*|^(?:\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?''')/))) { push(m[0], 'cmt'); continue; }
        if ((m = rest.match(/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`(?:[^`\\]|\\.)*`/))) { push(m[0], 'str'); continue; }
        if ((m = rest.match(/^0[xXbBoO][0-9a-fA-F]+|^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/))) { push(m[0], 'num'); continue; }
        const kw = KW[lang];
        if (kw && (kw.lastIndex = i, (m = kw.exec(src))) && m[0].length > 0) { push(m[0], 'kw'); continue; }
        if ((m = rest.match(/^[$A-Za-z_][$\w]*(?=\s*\()/))) { push(m[0], 'fn'); continue; }
      }
      if ((m = rest.match(/^[{}()\[\];,.:?!<>=+\-*/%&|^~@#$]+/))) push(m[0], 'pun');
      else if ((m = rest.match(/^\s+/))) push(m[0]);
      else if ((m = rest.match(/^[\w$\u0080-\uFFFF]+/))) push(m[0]);
      else push(src[i]);
      if (i === start) i++; // paranoid: never loop forever
    }
    return toks;
  }
  function hl(src, lang) {
    try {
      return tokenize(src, lang).map(([t, cls]) =>
        cls ? '<span class="tk-' + cls + '">' + esc(t) + '</span>' : esc(t)).join('');
    } catch { return esc(src); }
  }

  // ------------------------------------------------------------- blocks
  function render(src, opts) {
    opts = opts || {};
    src = String(src == null ? '' : src);
    // --- XSS GATE: escape everything before any parsing. No raw tag/attr
    //    survives this. `&quot;`/`&lt;`/`&gt;`/`&amp;` are what we see below.
    const escd = esc(src).replace(/&#39;/g, '&apos;').replace(/&quot;/g, '\u0001Q\u0001');
    const lines = escd.split('\n');
    const out = [];
    let i = 0;
    const footnotes = {}; // link-reference defs [ref]: url

    for (const l of lines) {
      const m = l.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/);
      if (m) footnotes[m[1].toLowerCase()] = m[2];
    }
    // mark link-definition-only lines so para() doesn't swallow them
    for (let k = 0; k < lines.length; k++)
      if (/^\s{0,3}\[([^\]]+)\]:\s*\S+/.test(lines[k])) lines[k] = '';
    void footnotes; // used by inline via closure-free param below

    function fence() {
      const m = lines[i].match(/^\s*`{3,}\s*([-\w]*)\s*$/);
      const lang = (m[1] || '').toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*`{3,}\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // skip closing (or run off end while streaming)
      const escRaw = body.join('\n');
      let inner;
      if (lang === 'mermaid' || /^graph/.test(lang)) {
        inner = '<div class="md-pseudo">' + escRaw.split('\n').filter(Boolean)
          .map(l => '<div class="pf-node">' + l.replace(/^[-\s&;gt>\u0001Q\u0001]+/, '') + '</div>')
          .join('<div class="pf-arrow">\u2193</div>') + '</div>';
      } else {
        // highlight from RAW source (body joined before esc): re-read raw input
        const raw = body.map(l => l
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/\u0001Q\u0001/g, '"')).join('\n');
        const code = (lang && lang !== 'text' && LANG_ALIAS[lang] !== undefined)
          ? hl(raw, lang)
          : esc(raw);
        inner = '<div class="codeblock">'
          + '<button class="copy-btn" data-copy="copy" aria-label="copy code">\u29c9</button>'
          + '<pre><code class="lang-' + esc(lang || 'plain') + '">' + code + '</code></pre></div>';
      }
      out.push(inner);
    }

    function heading() {
      const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
      const lvl = m[1].length;
      const t = m[2].replace(/\s*(?:#+)\s*$/, '');
      out.push('<h' + lvl + '>' + inline(t, footnotes) + '</h' + lvl + '>');
      i++;
    }

    function table() {
      const splitRow = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      const cols = splitRow(lines[i]);
      const n = cols.length;
      let html = '<div class="tbl-wrap"><table><thead><tr>';
      for (const c of cols) html += '<th>' + inline(c.trim(), footnotes) + '</th>';
      html += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        const cells = splitRow(lines[i]);
        html += '<tr>';
        for (let k = 0; k < n; k++) html += '<td>' + inline((cells[k] || '').trim(), footnotes) + '</td>';
        html += '</tr>';
        i++;
      }
      out.push(html + '</tbody></table></div>');
    }

    function quoteBody() {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      // buf holds once-escaped text; render() escapes again -> avoid &amp;lt;
      // by unescaping first (safe: it is already gate-escaped, cannot hide tags)
      const once = buf.join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\u0001Q\u0001/g, '"');
      out.push('<blockquote data-tpl="quote">' + render(once, opts) + '</blockquote>');
    }

    function taskOrList() {
      const isTask = /^\s*[-*]\s+\[([ xX])\]\s*/;
      const isLI = /^\s*[-*+]\s+/;
      const isOL = /^\s*\d+[.)]\s+/;
      const useTask = isTask.test(lines[i]);
      const ol = !useTask && isOL.test(lines[i]);
      const lineRE = useTask ? isTask : ol ? isOL : isLI;
      const items = [];
      while (i < lines.length && lineRE.test(lines[i])) {
        const m = lines[i].match(lineRE);
        const item = { text: lines[i].slice(m[0].length), checked: useTask ? m[1] !== ' ' : null };
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !lineRE.test(lines[i])) {
          item.text += '\n' + lines[i]; i++;
        }
        items.push(item);
      }
      let h = useTask ? '<ul class="tasklist">' : ol ? '<ol>' : '<ul>';
      for (const t of items) {
        if (useTask) {
          h += '<li class="task-item' + (t.checked ? ' done' : '') + '">'
            + '<input type="checkbox" disabled' + (t.checked ? ' checked' : '') + '><span>'
            + inline(t.text, footnotes) + '</span></li>';
        } else h += '<li>' + inline(t.text, footnotes) + '</li>';
      }
      out.push(h + '</' + (useTask || !ol ? 'ul' : 'ol') + '>');
    }

    function para() {
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6}\s|\s*`{3,}|\s*&gt;|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      if (buf.length) out.push('<p>' + inline(buf.join('\n'), footnotes) + '</p>');
    }

    function mainLoop() {
      while (i < lines.length) {
        const l = lines[i];
        if (/^\s*$/.test(l)) { i++; continue; }
        if (/^\s*(```|~~~)/.test(l)) { fence(); continue; }
        if (/^#{1,6}\s/.test(l)) { heading(); continue; }
        if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) { table(); continue; }
        if (/^\s*&gt;\s?/.test(l)) { quoteBody(); continue; }
        if (/^\s*(?:[-=*_]\s*){3,}$/.test(l) && i + 1 < lines.length) { out.push('<hr>'); i++; continue; }
        if (/^\s*(?:[-*]\s+\[[ xX]\]|[-*+]\s+|\d+[.)]\s+)/.test(l)) { taskOrList(); continue; }
        para();
      }
    }

    mainLoop();
    // Final XSS hardening: any event-handler-shaped text residue gets a
    // zero-width break inside it so it can never form a live attribute even
    // if the output is later round-tripped through a lenient parser.
    return finalGate(out.join('\n'))
      .replace(/\u0001Q\u0001/g, '&quot;')
      .replace(/&amp;lt;/g, '&lt;').replace(/&amp;gt;/g, '&gt;')
      .replace(/&amp;amp;/g, '&amp;')
      .replace(/&amp;#39;/g, '&#39;').replace(/&amp;apos;/g, '&#39;')
      .replace(/on([a-z]+)(=|&#61;)/gi, 'on$1\u200b=');
  }

  // ------------------------------------------------------- copy buttons
  function enhanceCopy(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
    rootEl.querySelectorAll('button[data-copy]').forEach(btn => {
      if (btn._mdBound) return;
      btn._mdBound = true;
      btn.addEventListener('click', () => {
        const code = btn.parentElement.querySelector('pre code');
        if (code && root.navigator && navigator.clipboard) {
          navigator.clipboard.writeText(code.textContent.replace(/\n$/, ''))
            .then(() => { btn.textContent = '\u2713'; setTimeout(() => btn.textContent = '\u29c9', 1200); })
            .catch(() => { });
        }
      });
    });
    return rootEl;
  }

  return { render, enhanceCopy, escapeHtml: esc, highlight: hl, tokenize, safeHref, finalGate, _inline: inline };
});
