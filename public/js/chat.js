'use strict';
// chat.js — workstream A owner: minimal-but-real timeline + composer, streaming.
// Subagent A will replace/extend; keep API surface (MODULES.chat.render, bus messages).
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

  function appendMsg(role, text) {
    const d = document.createElement('div'); d.className = 'card';
    const who = document.createElement('b'); who.textContent = role === 'user' ? 'you' : 'hermes';
    const body = document.createElement('div'); body.textContent = text;
    d.append(who, body); msgBox.appendChild(d); msgBox.scrollTop = msgBox.scrollHeight;
    return body;
  }

  async function send() {
    const text = composer.value.trim(); if (!text || streaming) return;
    composer.value = ''; appendMsg('user', text);
    streaming = true;
    const bodyEl = appendMsg('hermes', '…');
    const payload = { input: chips.length ? chips.map(c => `[file: ${c}]`).join(' ') + ' ' + text : text, conversation: convo };
    try {
      const { run_id } = await API.post('/api/run/create', payload);
      sessionRunId = run_id; bus.emit('run:started', { run_id });
      API.sse(`/api/run/${run_id}/events`, ev => {
        switch (ev.event) {
          case 'message.delta': bodyEl.textContent += ev.delta; break;
          case 'run.completed':
            bodyEl.textContent = ev.output || bodyEl.textContent;
            if (ev.usage) appendUsage(ev.usage);
            bus.emit('run:completed', ev); streaming = false; break;
          case 'run.failed': case 'run.cancelled':
            bodyEl.textContent += '\n[run ' + ev.event.replace('run.', '') + ']'; streaming = false; break;
          case 'upstream.error': streaming = false; break;
        }
        msgBox.scrollTop = msgBox.scrollHeight;
      });
    } catch (e) { bodyEl.textContent = 'error: ' + e.message; streaming = false; }
  }

  function appendUsage(u) {
    const c = document.createElement('div'); c.className = 'chip';
    c.textContent = `${u.input_tokens || 0} in / ${u.output_tokens || 0} out`;
    msgBox.appendChild(c);
  }

  bus.on('attach:chips', list => { chips.length = 0; chips.push(...list); });
  bus.on('session:switch', ({ conversation }) => { convo = conversation; msgBox && (msgBox.innerHTML = ''); });
  return { render };
})();
