'use strict';
/* chat.js — workstream A owner: full chat timeline + composer.
 * Markup pipeline: MD.render() escapes ALL raw HTML up front (XSS gate in
 * md.js, proven by tests/unit/md.test.js) — innerHTML on its output is safe.
 * Streaming, markdown, tool-call cards, thinking blocks, usage chips,
 * inline [attach:<id> name] render (workstream J) preserved.
 */
MODULES.chat = (() => {
  let sessionRunId = null, convo = null, msgBox, composer, streaming = false;
  const chips = [];

  function render(el) {
    // messaging-app shell: header / scrollable timeline / tool row above / input+send at bottom
    el.id = 'chatroot';
    el.innerHTML = `
      <div class="chat-head">
        <button id="sessions-open" class="btn" title="sessions" style="min-width:44px;font-size:18px">≡</button>
        <div class="chat-title" id="chat-title">New chat</div>
        <button id="session-rename" class="btn" title="rename" style="min-width:44px">✎</button>
      </div>
      <div class="scrollpane" id="tl"></div>
      <div class="toolrow" id="toolrow"></div>
      <div class="composer">
        <textarea id="composer" rows="1" placeholder="Message…"></textarea>
        <button id="send" class="primary" title="send">➤</button>
        <button id="stop" class="danger" title="stop run" style="display:none">■</button>
      </div>`;
    msgBox = el.querySelector('#tl'); composer = el.querySelector('#composer');
    el.querySelector('#send').onclick = send;
    const stopBtn = el.querySelector('#stop');
    stopBtn.onclick = () => sessionRunId && API.post(`/api/run/${sessionRunId}/stop`);
    composer.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    composer.addEventListener('input', () => { composer.style.height = 'auto'; composer.style.height = Math.min(composer.scrollHeight, 120) + 'px'; });
    el.querySelector('#sessions-open').onclick = () => bus.emit('sessions:open', {});
    bus.on('run:started', () => { stopBtn.style.display = ''; });
    bus.on('run:completed', () => { stopBtn.style.display = 'none'; });
    bus.on('run:failed', () => { stopBtn.style.display = 'none'; });
    // title sync: current session title from sessions module (list cache)
    bus.on('session:switch', ({ conversation }) => {
      const t = document.getElementById('chat-title');
      const named = conversation && localStorage.getItem('hm2.session.title.' + conversation);
      t.textContent = named || (conversation ? conversation.slice(0, 14) : 'New chat');
    });
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
    const payload = { input: text };
    // session spine (workstream B): if a real session is active, bind the run to
    // it (session_id → upstream persists history in that session). Fallback for
    // no-session state: legacy conversation label so runs stay grouped pre-B.
    if (convo) payload.session_id = convo; else payload.conversation = 'hm2-main';
    // TODO-verify: workstream I — model_options upstream shape unconfirmed by G/lead.
    // Per-conversation model choice (persisted by slash.js picker in localStorage
    // 'hm2.model.<convo>') → payload {model_options:{provider, name}}. THIS SEND
    // PATH IS THE ONLY PLACE model_options is assembled (run_routes.js forwards
    // the object verbatim to POST /v1/runs).
    try {
      const choice = JSON.parse(localStorage.getItem('hm2.model.' + convo) || 'null');
      // /v1/runs request-level fields: model + provider (Hermes-native endpoint always honors),
      // model_options = reasoning controls (reasoning_effort verified in api-server docs)
      if (choice && choice.provider && choice.model) { payload.model = choice.model; payload.provider = choice.provider; }
      const effort = localStorage.getItem('hm2.effort.' + convo);
      if (effort) payload.model_options = { reasoning_effort: effort };
    } catch {}
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
            notify('run completed', (ev.output || '').slice(0, 100));
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
          case 'approval.request': {
            if (thinkEl) { thinkEl.done(); thinkEl = null; }
            const card = approvalCard(ev); // ev.command redacted upstream; ev.request_id, ev.choices
            msgBox.appendChild(card); scroll();
            notify(ev.event, ev.command ? 'approval requested: ' + String(ev.command).slice(0, 80) : 'Hermes needs approval');
            break;
          }
          case 'approval.responded':
            toast('approval resolved: ' + (ev.choice || 'done'));
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

  // ---------------------------------------------------- approval cards (G)
  function approvalCard(ev) {
    const choices = Array.isArray(ev.choices) && ev.choices.length ? ev.choices : ['once', 'deny'];
    const wrap = document.createElement('div');
    wrap.className = 'card approvalcard';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    const b = document.createElement('b'); b.textContent = '⚠ Approval needed';
    head.appendChild(b);
    const cmd = document.createElement('div');
    cmd.className = 'mono'; cmd.style.cssText = 'white-space:pre-wrap;font-size:12px;max-height:120px;overflow:auto;color:var(--foreground)';
    cmd.textContent = ev.command || ev.title || '(tool use)';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
    for (const c of choices) {
      const btn = document.createElement('button');
      btn.className = 'btn' + (c === 'once' ? ' primary' : c === 'deny' ? ' danger' : '');
      btn.textContent = c === 'once' ? '✓ allow once' : c === 'session' ? 'allow session' : c === 'always' ? 'always' : '✕ deny';
      btn.style.minHeight = '44px';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await API.post(`/api/run/${sessionRunId}/approval`, { choice: c, request_id: ev.request_id || undefined });
          toast('approval sent: ' + c);
          wrap.classList.add('done'); row.remove();
          const st = document.createElement('div'); st.className = 'muted'; st.style.fontSize = '11px'; st.textContent = '→ ' + c;
          wrap.appendChild(st);
        } catch (e) { toast('approval failed: ' + e.message); btn.disabled = false; }
      };
      row.appendChild(btn);
    }
    wrap.append(head, cmd, row);
    return wrap;
  }

  // ------------------------------------------------- notifications (G, zero-dep)
  function notify(title, body) {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') { new Notification(title, { body: (body || '').slice(0, 120), tag: 'hm2-' + title }); return; }
      if (Notification.permission === 'default') Notification.requestPermission(); // ask on first event; no nag
    } catch {}
  }

  function appendUsage(u) { usageChips(u); } // back-compat alias

  bus.on('attach:chips', list => { chips.length = 0; chips.push(...list.map(c => c.name || c)); });
  bus.on('session:switch', ({ conversation }) => {
    convo = conversation || null; msgBox && (msgBox.innerHTML = '');
    sessionRunId = null; thinkEl = null; streaming = false;
  });
  // workstream B: render saved transcript when a session is resumed
  bus.on('session:history', ({ items }) => {
    if (!msgBox) return;
    msgBox.replaceChildren(); // clear timeline without innerHTML strings
    for (const it of (items || [])) {
      if (it._tool) { const t = toolCard(it.name, {}, 'done'); t.appendOut(it.output || ''); msgBox.appendChild(t.el); continue; }
      const bodyEl = appendMsg(it.role, it.text || '');
      bodyEl._raw = it.text || '';
    }
  });
  return { render, toolCard, thinkingBlock, usageChips, _mdHtml: mdHtml };
})();
