'use strict';
/* chat.js — workstream A owner: full chat timeline + composer.
 * Markup pipeline: MD.render() escapes ALL raw HTML up front (XSS gate in
 * md.js, proven by tests/unit/md.test.js) — innerHTML on its output is safe.
 * Streaming, markdown, tool-call cards, thinking blocks, usage chips,
 * inline [attach:<id> name] render (workstream J) preserved.
 */
MODULES.chat = (() => {
  let sessionRunId = null, convo = 'hm2-main', msgBox, composer, streaming = false;
  const chips = [];

  function render(el) {
    el.innerHTML = `
      <div id="tl"></div>
      <div class="composer" style="position:sticky;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom,0px) + 8px);display:flex;gap:6px">
        <input id="composer" placeholder="Message…" autocomplete="off" style="flex:1">
        <button id="send" class="primary">➤</button>
        <button id="stop" class="danger">■</button>
      </div>`;
    msgBox = el.querySelector('#tl'); composer = el.querySelector('#composer');
    el.querySelector('#send').onclick = send;
    el.querySelector('#stop').onclick = () => sessionRunId && API.post(`/api/run/${sessionRunId}/stop`);
    composer.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  function mdHtml(text) { return MD.render(text); }
  function scroll() { msgBox.scrollTop = msgBox.scrollHeight; }

  // Inline attachment render: [attach:<id> name] markers → thumbnails/links.
  function attachmentInline(text) {
    const d = document.createElement('div');
    const re = /\[attach:([0-9a-f]{8}) ([^\]\n]+)\]/g;
    let last = 0, m, found = false;
    while ((m = re.exec(text))) {
      found = true;
      if (m.index > last) d.appendChild(document.createTextNode(text.slice(last, m.index)));
      const id = m[1], name = m[2];
      const url = `/api/attach/file/${id}`;
      const el = document.createElement('a'); el.href = url; el.target = '_blank';
      const isImg = /\.(png|jpe?g|webp|gif)$/i.test(name);
      if (isImg) {
        const img = document.createElement('img'); img.src = url; img.alt = name;
        img.style.cssText = 'max-width:100%;max-height:220px;border-radius:8px;display:block';
        el.appendChild(img);
      } else {
        el.className = 'chip'; el.textContent = '📎 ' + name;
      }
      d.appendChild(el);
      last = re.lastIndex;
    }
    if (last < text.length) d.appendChild(document.createTextNode(text.slice(last)));
    return found ? d : null;
  }

  function appendMsg(role, text) {
    const d = document.createElement('div'); d.className = 'card msg-' + role;
    const who = document.createElement('b'); who.textContent = role === 'user' ? 'you' : 'hermes';
    who.style.cssText = 'font-size:12px;color:var(--muted)';
    const bodyDiv = document.createElement('div'); bodyDiv.className = 'msg-body';
    if (role === 'user') {
      const inl = attachmentInline(text);
      if (inl) bodyDiv.appendChild(inl); else bodyDiv.textContent = text;
    } else {
      bodyDiv.innerHTML = mdHtml(text); // XSS-gated by md.js
    }
    d.append(who, bodyDiv); msgBox.appendChild(d);
    MD.enhanceCopy(bodyDiv);
    scroll();
    return bodyDiv;
  }

  // ----------------------------------------------------------- tool cards
  function toolCard(name, args, status) {
    const wrap = document.createElement('div');
    wrap.className = 'card toolcard' + (status === 'running' ? ' running' : '');
    const head = document.createElement('button');
    head.className = 'toolhead'; head.setAttribute('aria-expanded', 'false');
    const spinner = document.createElement('span');
    spinner.className = 'spinner'; spinner.style.display = status === 'running' ? '' : 'none';
    const label = document.createElement('b'); label.textContent = name;
    const badge = document.createElement('span'); badge.className = 'chip toolstatus';
    badge.textContent = status || 'pending';
    head.append(spinner, label, badge);
    const body = document.createElement('div'); body.className = 'toolbody';
    const argText = typeof args === 'string' ? args : JSON.stringify(args || {}, null, 2);
    const pre = document.createElement('pre'); pre.textContent = argText;
    body.appendChild(pre);
    body.style.display = 'none';
    head.onclick = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      head.setAttribute('aria-expanded', String(!open));
    };
    wrap.append(head, body);
    return { el: wrap, pre, badge, spinner,
      setStatus(s) {
        badge.textContent = s;
        spinner.style.display = s === 'running' ? '' : 'none';
        wrap.classList.toggle('running', s === 'running');
      },
      appendOut(text) {
        pre.textContent = text;
        const lines = text.split('\n');
        // auto-collapse long output (>40 lines)
        if (lines.length > 40 && !wrap._collapsedBtn && !wrap._expanded) {
          const more = document.createElement('button'); more.className = 'diff-gap toolmore';
          more.textContent = `⋯ ${lines.length - 40} more lines ⋯ (tap to expand)`;
          more.onclick = () => { wrap._expanded = true; pre.textContent = text; more.remove(); };
          wrap._collapsedBtn = more;
          body.appendChild(more);
        } else if (wrap._collapsedBtn && wrap._expanded) {
          wrap._collapsedBtn.querySelector('.toolmore') && null;
        }
      } };
  }

  // -------------------------------------------------------- thinking blocks
  function thinkingBlock(container) {
    const d = document.createElement('div'); d.className = 'card thinkcard';
    d.innerHTML = `<button class="thinkhead" aria-expanded="false">`
      + `<span class="spinner"></span><b>Thinking…</b><span class="chip thinkstate">streaming</span></button>`
      + `<div class="thinkbody" style="display:none"><div class="thinkprev mono" data-mono style="white-space:pre-wrap"></div></div>`;
    const head = d.querySelector('.thinkhead'), body = d.querySelector('.thinkbody');
    const prev = d.querySelector('.thinkprev'); let full = '';
    head.onclick = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      head.setAttribute('aria-expanded', String(!open));
    };
    (container || msgBox).appendChild(d); scroll();
    return {
      el: d,
      push(text) {
        full += text || '';
        prev.textContent = full;
        scroll();
      },
      done() {
        d.querySelector('.thinkstate').textContent = Math.ceil(full.length / 4) + ' tk';
        head.querySelectorAll('.spinner').forEach(s => s.style.display = 'none');
        if (full) prev.textContent = full; else d.remove();
      },
    };
  }

  // --------------------------------------------------------------- usage
  function usageChips(usage) {
    if (!usage || typeof usage !== 'object') return;
    const row = document.createElement('div'); row.className = 'chiprow usage-row';
    const mk = label => { const c = document.createElement('span'); c.className = 'chip usage-chip'; c.textContent = label; row.appendChild(c); };
    if (usage.input_tokens != null) mk('⬆ ' + usage.input_tokens);
    if (usage.output_tokens != null) mk('⬇ ' + usage.output_tokens);
    if (usage.total_tokens != null) mk('Σ ' + usage.total_tokens);
    if (usage.context_tokens != null) mk('ctx ' + usage.context_tokens);
    if (usage.cost_usd != null || usage.cost != null) mk('$' + (usage.cost_usd != null ? usage.cost_usd : usage.cost));
    msgBox.appendChild(row); scroll();
  }

  // ------------------------------------------------------------- streaming
  let thinkEl = null;
  async function send() {
    const text = composer.value.trim(); if (!text || streaming) return;
    composer.value = ''; appendMsg('user', text);
    streaming = true;
    const bodyEl = appendMsg('hermes', '…');
    bodyEl._raw = '';
    const payload = { input: text, conversation: convo };
    bus.emit('run:before-create', payload); // workstream J hook (attach.js)
    try {
      const { run_id } = await API.post('/api/run/create', payload);
      sessionRunId = run_id; bus.emit('run:started', { run_id });
      let tool = null;
      API.sse(`/api/run/${run_id}/events`, ev => {
        switch (ev.event) {
          case 'message.delta':
            bodyEl._raw += ev.delta;
            bodyEl.innerHTML = mdHtml(bodyEl._raw);
            break;
          case 'reasoning.available':
            if (!thinkEl) thinkEl = thinkingBlock(msgBox);
            thinkEl.push(ev.text || '');
            break;
          case 'run.completed': {
            if (thinkEl) { thinkEl.done(); thinkEl = null; }
            const out = ev.output != null ? ev.output : bodyEl._raw;
            bodyEl.innerHTML = mdHtml(out);
            MD.enhanceCopy(bodyEl);
            usageChips(ev.usage);
            bus.emit('run:completed', ev); streaming = false; break;
          }
          case 'run.failed': case 'run.cancelled':
            if (thinkEl) { thinkEl.done(); thinkEl = null; }
            bodyEl.innerHTML += `<div class="err">[run ${MD.escapeHtml(ev.event.replace('run.', ''))}]</div>`;
            streaming = false; break;
          case 'tool.started': case 'tool.call': {
            if (tool) tool.setStatus('done');
            tool = toolCard(ev.tool || ev.name || 'tool', ev.args || ev.input || {}, 'running');
            msgBox.appendChild(tool.el); tool._out = ''; scroll(); break;
          }
          case 'tool.output': case 'tool.delta':
            if (tool) { tool._out += ev.output || ev.delta || ''; tool.appendOut(tool._out); }
            break;
          case 'tool.completed': case 'tool.done':
            if (tool) { tool.setStatus('done'); scroll(); }
            break;
          case 'tool.failed':
            if (tool) tool.setStatus('failed');
            break;
          case 'upstream.error':
            if (thinkEl) { thinkEl.done(); thinkEl = null; }
            bodyEl.innerHTML += `<div class="err">${MD.escapeHtml(ev.error || '[upstream error]')}</div>`;
            streaming = false; break;
        }
        scroll();
      });
    } catch (e) {
      if (thinkEl) thinkEl.done(); thinkEl = null;
      bodyEl.textContent = 'error: ' + e.message; streaming = false;
    }
  }

  function appendUsage(u) { usageChips(u); } // back-compat alias

  bus.on('attach:chips', list => { chips.length = 0; chips.push(...list.map(c => c.name || c)); });
  bus.on('session:switch', ({ conversation }) => {
    convo = conversation; msgBox && (msgBox.innerHTML = '');
    sessionRunId = null; thinkEl = null; streaming = false;
  });
  return { render, toolCard, thinkingBlock, usageChips, _mdHtml: mdHtml };
})();
