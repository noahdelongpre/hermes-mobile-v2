'use strict';
/* voice_routes.js — Workstream F: whisper-backed STT endpoint + status probe.
 * POST /api/voice/stt  — raw audio body (webm/wav/mp3/ogg octet-stream).
 *   Saves to state/voice_tmp/, converts to wav via ffmpeg (if present, 30s cap),
 *   then transcribes: (a) WHISPER_URL HTTP whisper server (accepts {text},
 *   OpenAI format, or plain text), (b) `whisper` CLI (tiny, 30s cap), else
 *   200 {transcript:'', engine:'none'} — clients fall back to browser STT.
 * GET /api/voice/status — {stt:'whisper-http'|'whisper-cli'|'none', ffmpeg:bool}
 * Engines probed once at boot. Zero npm deps.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const TMO_MS = 30_000;
const AUDIO_EXT = /(\.webm|\.wav|\.mp3|\.ogg|\.m4a|\.mp4)$/i;

function probe(cmd, args, timeout) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout: timeout || 5000 }, (err, stdout) => {
        resolve(!err || (stdout && String(stdout).length > 0));
      });
    } catch { resolve(false); }
  });
}

module.exports = { register(app) {
  const { stateDir, log } = app.ctx;
  const tmpDir = path.join(stateDir, 'voice_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // ---- engine discovery (once at boot) ----
  const engines = { ffmpeg: false, whisperCli: false, probed: false };
  async function discoverEngines() {
    if (engines.probed) return engines;
    engines.probed = true;
    engines.ffmpeg = await probe('ffmpeg', ['-version']);
    // whisper CLI: fragile on Windows (whisper.bat shim); use shell probe
    engines.whisperCli = await new Promise(resolve => {
      try {
        const p = spawn('whisper', ['--help'], { shell: true, timeout: 8000 });
        let out = '';
        p.stdout.on('data', c => (out += c));
        p.stderr.on('data', c => (out += c));
        p.on('error', () => resolve(false));
        p.on('close', code => resolve(code === 0 || /usage:/i.test(out)));
      } catch { resolve(false); }
    });
    log('[voice] engines:', JSON.stringify(engines), 'WHISPER_URL=' + (process.env.WHISPER_URL || ''));
    return engines;
  }
  discoverEngines().catch(() => {});

  function sttMode() {
    if (process.env.WHISPER_URL) return 'whisper-http';
    if (engines.whisperCli) return 'whisper-cli';
    return 'none';
  }

  function convertToWav(srcPath) {
    return new Promise(resolve => {
      if (!engines.ffmpeg) return resolve(srcPath.endsWith('.wav') ? srcPath : null);
      const dst = srcPath.replace(AUDIO_EXT, '') + '.con.wav';
      const p = spawn('ffmpeg', ['-y', '-i', srcPath, '-ar', '16000', '-ac', '1', dst], { timeout: TMO_MS });
      let errOut = '';
      p.stderr.on('data', c => (errOut += c));
      p.on('error', () => resolve(null));
      p.on('close', code => resolve(code === 0 && fs.existsSync(dst) ? dst : (errOut && null)));
    });
  }

  function transcribeHttp(wavPath) {
    return new Promise(resolve => {
      const url = process.env.WHISPER_URL.replace(/\/$/, '') + (process.env.WHISPER_URL.endsWith('/inference') ? '' : '');
      const buf = fs.readFileSync(wavPath);
      const boundary = '----hmvoice' + crypto.randomBytes(8).toString('hex');
      const pre = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
      const post = Buffer.from(`\r\n--${boundary}--\r\n`);
      const u = new URL(url);
      const req = require('http').request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=' + boundary,
          'content-length': pre.length + buf.length + post.length },
      }, res => {
        let out = '';
        res.on('data', c => (out += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(out);
            resolve(typeof j.text === 'string' ? j.text : typeof j.transcript === 'string' ? j.transcript : '');
          } catch { resolve(/^\s*[{[]/.test(out) ? '' : out.trim()); }
        });
      });
      req.on('error', () => resolve(''));
      req.setTimeout(TMO_MS, () => { req.destroy(); resolve(''); });
      req.write(pre); req.write(buf); req.end(post);
    });
  }

  function transcribeCli(wavPath) {
    return new Promise(resolve => {
      const p = spawn('whisper', [wavPath, '--model', 'tiny', '--output_format', 'txt',
        '--output_dir', tmpDir, '--language', 'en'], { shell: true, timeout: 120_000 });
      let acc = '', errOut = '';
      p.stdout.on('data', c => (acc += c));
      p.stderr.on('data', c => (errOut += c));
      p.on('error', () => resolve(''));
      p.on('close', () => {
        try {
          resolve(fs.readFileSync(wavPath.replace(AUDIO_EXT, '') + '.txt', 'utf8').trim());
        } catch { resolve(acc.trim()); }
      });
    });
  }

  app.post('/api/voice/stt', async (req, res) => {
    const ctype = String(req.headers['content-type'] || '');
    if (!/octet-stream|audio|multipart/i.test(ctype)) return res.status(400).json({ error: 'send audio as application/octet-stream' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 64) return res.status(400).json({ error: 'empty audio body' });
    const ext = (/audio\/(\w+)/i.exec(ctype) || [])[1] || 'webm';
    const id = crypto.randomBytes(6).toString('hex');
    const src = path.join(tmpDir, id + '.' + ext);
    fs.writeFileSync(src, buf);
    try {
      const mode = sttMode();
      if (mode === 'none') {
        return res.json({ transcript: '', engine: 'none' });
      }
      let wav = src.endsWith('.wav') ? src : null;
      if (!wav) { wav = await convertToWav(src); if (!wav) return res.status(400).json({ error: 'audio conversion failed (ffmpeg)' }); }
      const transcript = mode === 'whisper-http' ? await transcribeHttp(wav) : await transcribeCli(wav);
      res.json({ transcript, engine: mode });
    } catch (e) {
      log('[voice] stt error:', e.message);
      res.status(500).json({ error: e.message });
    } finally {
      // best-effort cleanup, keep dir tidy
      try {
        for (const f of fs.readdirSync(tmpDir)) {
          const fp = path.join(tmpDir, f);
          if (Date.now() - fs.statSync(fp).mtimeMs > 300_000) { fs.unlinkSync(fp); }
        }
      } catch {}
    }
  });

  app.get('/api/voice/status', async (req, res) => {
    await discoverEngines();
    res.json({ stt: sttMode(), ffmpeg: engines.ffmpeg, whisper_url: !!process.env.WHISPER_URL });
  });
}};
