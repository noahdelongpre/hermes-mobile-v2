# Hermes Mobile v2 — Feature Spec & Shared Conventions
Source research: Happy Coder docs (happy.engineering), Claude Code UI/CloudCLI readme,
Terragon, Vibe Kanban, OpenCode web/mobile, Conduit. Every feature below is to be implemented.

## Shared conventions (all modules MUST follow)
- Stack: plain HTML + vanilla JS + CSS, zero npm deps, server = stock Node (requires only http/fs/crypto net).
- Module layout: each subagent builds JS as `public/js/<module>.js` (one file per feature group:
  chat.js, sessions.js, files.js, git.js, terminal.js, voice.js, notify.js, kanban.js, slash.js,
  attach.js) and backend as `server/<module>_server.js` when server-side pieces are needed.
- A slim shared kernel exists: `public/js/comm.js` (SSE + fetch helpers, basic-auth) and
  `public/css/theme.css` uses CSS vars for theming. Use them; don't reinvent.
- All Hermes communication goes through OUR Node server, never browser→Hermes directly. Server
  holds HERMES_KEY; browser holds basic-auth.
- Mobile-first: touch targets ≥44px, dark theme default, sidebar collapsible, bottom tab bar.

## Hermes API endpoints used (server-side)
- POST /v1/runs {messages, model_options...} → {run_id, ...}
- GET  /v1/runs/{run_id} → status
- GET  /v1/runs/{run_id}/events (SSE)
- POST /v1/runs/{run_id}/stop
- POST /v1/runs/{run_id}/approval
- GET  /api/model/options (provider/model rows + pricing)
- GET  /api/jobs, POST /api/jobs, PATCH /api/jobs/{id}, /pause /resume /run, DELETE
- GET  /health
Note: verify exact request/response shapes yourself with curl during development — server logs
actual calls. Base URL is on BlackBox later; today it's http://192.168.86.39:8642 via default IP.

## Stream-by-stream feature specs

### A. Core chat & rendering (chat.js, css)
1. Streaming text as chunks arrive
2. Markdown rendering: headings, bold/italic, code fences w/ syntax highlighting (highlight.js
   via CDN ok or roll a tiny tokenizer for js/py/json/bash), tables, task lists
3. Tool-call cards: collapsible cards showing tool name, args, live output, status spinner
4. Diff rendering: per-file diff cards (LCS diff with +/- lines, context collapsing, expand-on-tap)
5. Thinking blocks: collapsible "Thinking…" with streaming preview
6. Token/context/cost display: after run, show usage counters from run payload if present
7. Copy buttons on code blocks; easy long-press selection
8. Inline widgets: mermaid-ish block rendering is OPTIONAL, mark as stretch goal

### B. Sessions & history (sessions.js) — owned by lead
- localStorage-backed session registry + full server-side session list via Hermes sessions API
- New session / rename / archive / delete / fork from any assistant message (fork = send
  reference context into a new run), drafts restore on revisit, auto-title (first 40 chars)
- Continuation after Hermes stop: "resume" re-attaches SSE and status polling

### C. Files (files.js)
- File tree browser rooted at FS_ROOT (server /hostfs when on Pi; configurable via env)
- Syntax-highlighted preview for common code/text types with line numbers; image preview inline
- Edit in place (textarea + save; optimistic UI), create file/folder, delete, rename/move
- Search by filename within FS_ROOT (server-side recursive ls, cap depth 8, ignore .git/node_modules)
- Pendant: file @-mention autocomplete in composer inserts `[file: path]` chip

### D. Git explorer (git.js)
- Server-side shell `git` on FS_ROOT: status, diff (per file), stage/unstage (index add/reset),
  commit with message, list/switch branches, log
- Renders status + branch picker top bar and inline diff cards (reuse A's diff renderer)
- Prompt-to-Hermes helper: "commit my work" formats a standard message

### E. Shell/PTY (terminal.js)
- Server PTY broker: on Windows host spawn `cmd.exe` in ConPTY via node-pty — BUT we have zero
  npm deps, so: fallback = one-shot exec via child_process with persistent cwd/env per session,
  rendered in an xterm.js (CDN-allowed) terminal with a mobile special-key toolbar
  (Esc/Tab/↑↓/Ctrl-C). Encourage reaching feature parity without node-pty first; if node-pty is
  truly required, note it as phase-2 with a docker build arg.

### F. Voice (voice.js)
- Push-to-talk mic button: Web Speech API (Chrome Android = on-device STT, zero-cost) primary;
  fallback → record MediaRecorder webm → POST to server → server runs whisper CLI (the Pi has
  whisper per existing infra) or opus->wav + whisper.cpp if webm unsupported
- TTS read-aloud on assistant messages: speaker icon — call Hermes TTS via server (POST
  /v1/audio/speech style if exists; else browser SpeechSynthesis fallback)
- Conversation mode stretch: continuous listen → auto-send on pause

### G. Notifications & approvals (notify.js + server)
- Server polls Hermes Jobs API? No — server listens to run-events SSE persistently for active
  runs and detects: completion, error, approval-required. Then:
  - in-app toast + sound via WebAudio (pre-chime byte)
  - Web Push via VAPID subscription (server generates vapid keys once, stores in .env; manual
    docker compose up to apply — no crypto deps, use web-push via crypto-only? If web-push is
    too heavy with zero deps, fall back to ntfy (user already runs ntfy-adjacent self-hosting
    patterns) — decide at implementation and note choice)
- Approval flow: when approval-required event arrives, show card with Approve/ApproveAlways/Deny
  buttons → POST /v1/runs/{id}/approval {decision}
- Badge count in bottom nav; clearing a session marks seen

### H. Kanban board (kanban.js)
- Donetick is the backing store (mcp__donetick tools exist for desktop Hermes) — for the phone
  app the app's own server must be able to create/list/update tasks via the same Donetick
  instance. Server env: DONETICK_URL, DONETICK_KEY. Subagent: build board UI (columns Todo/
  In Progress/Done, drag between columns, click card → assign to agent = create a Hermes run
  with prompt "Work on task: <desc>", card status auto-updates when that session completes)
- Follow-up loop: when chat session finishes, prompt "log as DoneTick?" anytime (small button)

### I. Slash & agents (slash.js)
- "/" opens fuzzy-search overlay of commands. Seed registry:
  /new /stop /model /plot /sessions /files /git /kanban /voice /memory /cron (map to
  corresponding module actions; not sent to Hermes verbatim)
- Hermes agent picker: list from /api/model/options provider rows; live-switch model_options on
  next run; remember choice per session

### J. Media & attachments (attach.js)
- Composer "+" button: camera capture (capture="environment" input), image from photos, file
- Inline image preview chips before send; assistant images render inline
- Clipboard image paste and drag/drop
- Voice-note button: press-hold record, upload as attachment (works with F)

## Non-goals (explicit) for v2
- E2E QR pairing (Streisand Effect not needed at LAN scale) — basic auth + Tailscale is our trust
- Git worktrees / parallel cloud sandboxes (Terragon-style) — nice but not first wave
- iOS native widgets/Live Activities (Happy) — PWA is our platform
