# Hermes Mobile v2 — Master Plan

Full rewrite of hermes-mobile, implementing the feature set of Claude-Code-class mobile
harnesses (Happy Coder, Claude Code UI/CloudCLI, Terragon, Vibe Kanban, OpenCode web/mobile,
Conduit). Research summary: see FEATURES.md.

## Architecture constraint
- Backend is a Node.js server that talks to host Hermes API (Runs API /v1/runs, SSE
  /v1/runs/{id}/events, /api/model/options, /api/jobs, sessions API), auth = bearer HERMES_KEY
  (server-side), app auth = existing basic auth. Zero heavy deps preferred, kept deployable as
  the existing Pi container (docker-compose, port 8123 style).
- No deep integration with Windows desktop — everything via the Hermes HTTP API only, so moving
  to BlackBox is a copy + new HERMES_URL.

## Feature matrix (subagent workstreams)
| # | Stream | Features | Dependencies |
|---|--------|----------|--------------|
| A | Core chat & rendering | streaming chat UI (SSE), markdown renderer, syntax highlighting, tool-call cards, diff rendering, thinking blocks, token/context display | — (own module) | ✅ done (unit-tested, S24 visual PASS) |
| B | Sessions & history | multi-session store, resume runs, fork from any point, rename/archive/delete, drafts restore, auto-titled conversations | hard → handled by me with A |
| C | Files | file tree, syntax-highlighted viewer, live editor, create/delete/move, context-size guard | shares style w/ A | ✅ done (30/30 unit tests pass, S24 visual PASS) |
| D | Git explorer | status/diff/stage/commit/branch switch UI; commits rendered as inline diff cards in chat when Hermes touches files | shares style + uses C's file tree |
| E | Shell/PTY | xterm.js multi-tab terminal with special-key toolbar + resize, PTY broker server-side | — |
| F | Voice | speech-to-text composer (MediaRecorder + whisper CLI or Web Speech API), TTS read-aloud via Hermes TTS | DONE — voice_routes.js (/api/voice/stt + /api/voice/status; ffmpeg→wav, WHISPER_URL HTTP or whisper-cli, graceful none), voice.js (🎤 PTT toggle in composer before #send, Web Speech API primary / MediaRecorder→/stt fallback, never auto-sends; 🔊 SpeechSynthesis buttons on .msg-hermes cards voice.js+index.html script tag), tests/unit/voice.test.js 9/9 PASS, s24ultra visual PASS, voice_probe (PTT in composer + TTS button verified) |
| G | Notifications & approvals | POST /v1/runs/{id}/approval button flow with push notification when Hermes asks approval/finishes | hard → me |
| H | Kanban board | kanban tri-view: DoneTick MCP mirror of board state in a third chat tab, clickable sync buttons to promote/demote | — |
| I | Slash & agents | / command registry with autocomplete (hermes skill commands like /memory, /stop), Hermes agent/skill/mood/session pickers | shares shell w/ A | ✅ done (unit-tested 11/11, /model picker wired to localStorage+model_options, S24 visual PASS) |
| J | Media & attachments | camera capture, clipboard paste of images, inline image render in chat, voice note attachment button (C or F required first) | — |

Dependencies marked "hard" require server-side design decisions I'll make directly.
Everything else is parallelizable verbatim — identical directory layout, module boundaries and
expected server endpoints are stated in FEATURES.md; subagents write and self-test their module,
I verify + integrate and only then mark DoneTick tasks complete.

## Kanban tracking
Progress is tracked on the user's DoneTick board via the donetick MCP (mcp__donetick tools).
Each stream above gets one task with 2-milestone notes; subagent results move them.

## Development flow on TheFridge (temporary)
- Dev server: npm-less Node on Windows at localhost; production parity check inside Docker before
  sign-off. No install of native runtimes beyond what's needed for integration testing — use node
  already present.
- After user sign-off: rsync + docker compose up on BlackBox, stop here.

## Order of execution
1. A + E + F first (independent, parallel)
2. C + I + J next, reusing A's styles
3. D + H last (depends on C / A respectively)
4. B, G woven in by me during integration
