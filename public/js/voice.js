'use strict';
/* voice.js — Workstream F: push-to-talk mic button in the composer (Web Speech API
 * primary, /api/voice/stt whisper fallback) + 🔊 read-aloud buttons on assistant
 * messages (browser SpeechSynthesis). Never auto-sends; fills the composer only.
 * This module renders nothing visible of its own — it layers onto Chat.
 */
MODULES.voice = (() => {
  let composerEl = null, recognizing = false, rec = null, recording = false, mediaRec = null, chunks = [];
  const voice = { wired: false };

  function findComposer() {
    return document.querySelector('.composer');
  }

  function insertAtCursor(text) {
    if (!composerEl || !text) return;
    const s = composerEl.selectionStart != null ? composerEl.selectionStart : composerEl.value.length;
    composerEl.value = composerEl.value.slice(0, s) + text + composerEl.value.slice(composerEl.selectionEnd != null ? composerEl.selectionEnd : s);
    composerEl.dispatchEvent(new Event('input', { bubbles: true }));
    composerEl.focus();
  }

  function setBtnState(btn, state) {
    btn.textContent = state === 'on' ? '🎙️' : '🎤';
    btn.classList.toggle('voice-on', state === 'on');
    btn.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
  }

  // ---- Web Speech API path (Chrome Android: on-device STT, zero-cost) ----
  function webSpeechAvailable() {
    return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === 'function';
  }

  function startWebSpeech(btn, wantContinuous) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true; rec.interimResults = false;
    rec.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript;
      if (text.trim()) insertAtCursor(text.trim() + ' ');
    };
    rec.onend = () => { recognizing = false; setBtnState(btn, 'off'); };
    rec.onerror = () => { recognizing = false; setBtnState(btn, 'off'); toast('voice error — mic unavailable'); };
    try { rec.start(); recognizing = true; setBtnState(btn, 'on'); toast('listening… tap 🎙️ to stop'); }
    catch { recognizing = false; toast('voice unavailable'); }
  }

  // ---- MediaRecorder → server whisper fallback ----
  async function startMediaRec(btn) {
    try {
      mediaRec = new MediaRecorder(await navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch { toast('voice unavailable'); return; }
    chunks = [];
    mediaRec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRec.onstop = null;
    mediaRec.start();
    recording = true; setBtnState(btn, 'on');
    toast('recording… tap 🎙️ to stop');
  }

  async function stopMediaRec(btn) {
    recording = false;
    const done = new Promise(resolve => { mediaRec.onstop = resolve; });
    mediaRec.stop();
    await done;
    mediaRec.stream.getTracks().forEach(t => t.stop());
    if (!chunks.length) { toast('no audio captured'); return; }
    btn.disabled = true; btn.textContent = '⏳';
    try {
      const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
      const r = await API.fetch('/api/voice/stt', { method: 'POST', body: blob,
        headers: { 'content-type': 'application/octet-stream' } });
      const j = await r.json();
      if (j.transcript && j.transcript.trim()) insertAtCursor(j.transcript.trim() + ' ');
      else toast(j.engine === 'none' ? 'no STT engine on server' : 'transcription empty');
    } catch {
      toast('voice error');
    } finally { btn.disabled = false; setBtnState(btn, 'off'); }
  }

  function buildMicButton() {
    const btn = document.createElement('button');
    btn.id = 'voice-ptt';
    btn.className = 'voice-ptt';
    btn.title = 'Voice input (tap to toggle)';
    btn.setAttribute('aria-label', 'Voice input');
    btn.textContent = '🎤';
    btn.addEventListener('click', async () => {
      if (webSpeechAvailable()) {
        if (recognizing) { try { rec.stop(); } catch {} return; }
        startWebSpeech(btn, true);
      } else if (navigator.mediaDevices && window.MediaRecorder) {
        if (recording) stopMediaRec(btn); else startMediaRec(btn);
      } else {
        toast('voice unavailable');
      }
    });
    return btn;
  }

  // ---- TTS read-aloud on assistant message cards ----
  function stripForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')   // code fences + inline
      .replace(/https?:\/\/\S+/g, '')                            // urls
      .replace(/[*_#>~|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }

  function addSpeakButton(card, bodyDiv) {
    if (!('speechSynthesis' in window)) return;
    const btn = document.createElement('button');
    btn.className = 'voice-tts';
    btn.textContent = '🔊';
    btn.title = 'Read aloud';
    btn.setAttribute('aria-label', 'Read aloud');
    btn.style.cssText = 'min-width:44px;min-height:44px;width:44px;height:44px;border:0;background:none;cursor:pointer;font-size:18px;flex:0 0 auto';
    btn.addEventListener('click', () => {
      const synth = window.speechSynthesis;
      if (synth.speaking) { synth.cancel(); btn.textContent = '🔊'; return; }
      const text = stripForSpeech(bodyDiv.textContent || '');
      if (!text) return;
      const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
      u.lang = navigator.language || 'en-US';
      u.onend = u.onerror = () => (btn.textContent = '🔊');
      btn.textContent = '⏹';
      synth.speak(u);
    });
    // place at card's top-right: use header row (who label) — append after 'b'
    const who = card.querySelector('b');
    if (who && who.parentElement === card) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      card.insertBefore(row, card.firstChild); row.appendChild(who); row.appendChild(btn);
    } else card.appendChild(btn);
  }

  function wireChat() { // attach mic + TTS observer once chat's DOM exists
    if (voice.wired) return;
    const c = findComposer();
    const msgBox = document.querySelector('#tl');
    if (!c || !msgBox || c.querySelector('.voice-ptt')) return;
    voice.wired = true;
    composerEl = c.querySelector('#composer') || c.querySelector('input');
    const tr = document.getElementById('toolrow');
    const btn = buildMicButton();
    if (tr && !tr.querySelector('.voice-ptt')) tr.appendChild(btn);
    else if (tr) { /* already wired */ }
    else { const send = c.querySelector('#send'); if (send) c.insertBefore(btn, send); else c.appendChild(btn); }
    // observe assistant cards for TTS buttons
    msgBox.dataset.voiceTts = '1';
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.classList && (n.classList.contains('msg-hermes') || n.querySelector('.msg-hermes'))) {
          const card = n.classList.contains('msg-hermes') ? n : n.querySelector('.msg-hermes');
          const body = card && card.querySelector('.msg-body');
          if (card && body && !card.querySelector('.voice-tts')) addSpeakButton(card, body);
        }
      }
    }).observe(msgBox, { childList: true });
  }
  function tryWire() { // chat tab re-renders on every switchTab (innerHTML='') — re-wire per render
    voice.wired = false; wireChat();
  }

  bus.on('module:loaded', t => { if (t === 'chat') setTimeout(tryWire, 50); });
  bus.on('tab:switch', t => { if (t === 'chat') setTimeout(tryWire, 50); });

  return {
    render(el) { el.innerHTML = ''; },
    _test: { stripForSpeech, insertAtCursor },
  };
})();
