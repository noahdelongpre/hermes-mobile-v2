'use strict';
// attach.js — workstream J. guard: MODULES comes from bootstrap.js (loaded after this file)
window.MODULES = window.MODULES || {};
// Loads (script tag in index.html), mounts +/-/camera buttons into chat's composer,
// uploads via /api/attach/upload, renders chips with thumbnails, handles paste + drag-drop.
// Contract: emits 'attach:chips' with [{id,name}]; chat.js renders [attach:<id> <name>]
// markers inline and prepends attachment markers to run payloads.
MODULES.attach = (() => {
  const attached = []; // {id, name, type, size, url}
  let fileInput, camInput, root = null;

  function uploadOne(blobOrFile, name, type) {
    const fd = new FormData();
    fd.append('file', blobOrFile, name || blobOrFile.name || 'upload.bin');
    return API.fetch('/api/attach/upload', { method: 'POST', body: fd })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || r.statusText); return j; }));
  }

  async function handleFiles(fileList) {
    for (const f of [...fileList]) {
      try {
        const meta = await uploadOne(f, f.name, f.type);
        addChip(meta);
      } catch (e) { toast('attach failed: ' + e.message); }
    }
  }

  function addChip(meta) {
    if (attached.find(a => a.id === meta.id)) return;
    attached.push(meta);
    renderChips();
    bus.emit('attach:chips', attached.map(({ id, name }) => ({ id, name })));
  }

  function removeChip(id) {
    const i = attached.findIndex(a => a.id === id);
    if (i === -1) return;
    attached.splice(i, 1);
    API.fetch(`/api/attach/${id}`, { method: 'DELETE' }).catch(() => {});
    renderChips();
    bus.emit('attach:chips', attached.map(({ id, name }) => ({ id, name })));
  }

  function clearChips() {
    attached.length = 0;
    renderChips();
    bus.emit('attach:chips', []);
  }

  function renderChips() {
    if (!root) return;
    let bar = root.querySelector('.attach-chips');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'attach-chips';
      bar.style.cssText = 'position:sticky;bottom:calc(var(--nav-h) + env(safe-area-inset-bottom,0px) + 64px);display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px;z-index:5';
      root.appendChild(bar);
    }
    bar.innerHTML = '';
    attached.forEach(a => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;max-width:220px';
      if ((a.type || '').startsWith('image/')) {
        const img = document.createElement('img');
        img.src = a.url; img.alt = a.name;
        img.style.cssText = 'width:32px;height:32px;object-fit:cover;border-radius:6px';
        chip.appendChild(img);
      } else {
        const ic = document.createElement('span'); ic.textContent = a.type === 'application/pdf' ? '📄' : '📎'; chip.appendChild(ic);
      }
      const nm = document.createElement('span');
      nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px';
      nm.textContent = a.name;
      const x = document.createElement('button');
      x.textContent = '✕'; x.className = 'chip';
      x.setAttribute('aria-label', 'remove attachment ' + a.name);
      x.style.cssText = 'min-width:32px;min-height:32px;padding:2px';
      x.onclick = () => removeChip(a.id);
      chip.append(nm, x);
      bar.appendChild(chip);
    });
  }

  function mkBtn(label, title, fn) {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.className = 'btn attach-btn';
    b.style.cssText = 'min-width:44px;min-height:44px;font-size:18px;padding:0 10px';
    b.onclick = fn;
    return b;
  }

  function ensureInputs() {
    if (fileInput) return;
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*,audio/*,application/pdf';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.style.display = 'none';
    fileInput.onchange = () => { handleFiles(fileInput.files); fileInput.value = ''; };
    camInput = document.createElement('input');
    camInput.type = 'file';
    camInput.accept = 'image/*';
    camInput.capture = 'environment';
    camInput.hidden = true;
    camInput.style.display = 'none';
    camInput.onchange = () => { handleFiles(camInput.files); camInput.value = ''; };
    document.body.append(fileInput, camInput);
  }

  // Sandbox for uploaded image previews inside a button menu (pasted/captured images)
  function mount() {
    const composer = document.querySelector('.composer');
    const toolrow = document.getElementById('toolrow');
    if (!composer || !toolrow || toolrow.querySelector('.attach-btn')) return;
    root = composer.parentElement;
    ensureInputs();
    const plus = mkBtn('＋', 'Attach files', () => fileInput.click());
    plus.textContent = '🖼️ +';
    const cam = mkBtn('📷', 'Take photo', () => camInput.click());
    toolrow.append(plus, cam);
    // drag-drop on whole tab content
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
  }

  // Clipboard image paste → upload (attach the actual File from the clipboard event)
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) { e.preventDefault(); handleFiles(items); }
  });

  // run:before-create: prepend [attach:<id> name] markers so Hermes (and the timeline
  // renderer in chat.js) can resolve attachments server-side. Sync listener contract.
  bus.on('run:before-create', payload => {
    if (attached.length) {
      const markers = attached.map(a => `[attach:${a.id} ${a.name}]`).join(' ');
      payload.input = markers + ' ' + (payload.input || '');
    }
  });

  bus.on('module:loaded', name => { if (name === 'chat') mount(); });
  bus.on('tab:switch', name => { if (name === 'chat') mount(); });

  // F voice interop stub: if voice.js records a note and emits 'voice:note'
  // with {blob, name?}, upload it as an attachment chip. (F may not emit yet.)
  bus.on('voice:note', async ({ blob, name } = {}) => {
    if (!blob) return;
    try {
      const meta = await uploadOne(blob, name || 'voice-note.webm', blob.type || 'audio/webm');
      addChip(meta);
      toast('voice note attached');
    } catch (e) { toast('voice note upload failed: ' + e.message); }
  });

  // chat clears on send; it emits nothing specific, so we reset when a run starts
  bus.on('run:started', clearChips);

  // fetch-side helper used by tests / other modules
  return { mount, addChip, removeChip, clearChips, uploadOne, handleFiles, list: () => [...attached] };
})();
