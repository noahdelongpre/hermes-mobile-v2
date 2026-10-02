# SERVER_API.md — App server route contract (authoritative for all subagents)

Node app server: `server/server.js`. It proxies STATIC (public/) + `/api/*` routes and
never lets the browser hit Hermes directly. All upstream Hermes users use
`require('./hermes_client')` — the ONLY file touching Hermes (bearer key, IP-literal rewrite,
timeouts). Never construct Hermes URLs elsewhere.

## Verified Hermes upstream shapes (probe: server/runs_api_probes.json)
- POST /v1/runs {input, conversation?, session_id?, model_options?} → {run_id, status:"started"}
- GET /v1/runs/{id} → {status, output, usage{input_tokens,output_tokens,total_tokens}, ...}
- GET /v1/runs/{id}/events → SSE; frames are `data: {"event":"<type>", ...}`; types:
  message.delta{delta} · reasoning.available{text} · run.completed{output,usage} ·
  approval.required(?shape TBD empirically — G owner discovers) · ": stream closed" comment ends
- POST /v1/runs/{id}/stop · POST /v1/runs/{id}/approval {decision} (shape TBD by G owner)
- POST /v1/runs/{id}/steer (run_steer=true in /v1/capabilities; shape TBD empirically)
- GET /api/model/options → {providers:[...], model, provider}
- Sessions: GET/POST /api/sessions; GET/PATCH/DELETE /api/sessions/{id};
  GET /api/sessions/{id}/messages?include_compacted&inline_images=false;
  POST /api/sessions/{id}/fork {title}; POST /api/sessions/{id}/chat/stream (SSE:
  assistant.delta, assistant.commentary, tool.started/completed/failed, run.completed/failed/cancelled)
- GET /v1/skills, /v1/toolsets (slash.js registry)
- Applications detect features: GET /v1/capabilities → features.run_steer, run_approval_response, approval_events, session_fork, audio_api=false (so TTS uses browser SpeechSynthesis + optional Hermes TTS REST if present later)

## App routes (all /api/*, all require basic auth like static pages)
Module prefix ownership — DO NOT add routes outside your prefix:
| prefix | module | status |
|---|---|---|
| /api/run/* | lead (B/G integration) | lead writes |
| /api/session/* | lead | lead writes |
| /api/fs/* | C files module | subagent C |
| /api/git/* | D git module | subagent D |
| /api/term/* | E terminal module | subagent E |
| /api/voice/* | F voice module | subagent F |
| /api/attach/* | J attachments | subagent J |
| /api/push/* | G notifications | lead |
| /api/kanban/* | H board | subagent H |
| /api/skills,/api/models | I slash/pickers | subagent I (thin cache proxy of /v1/skills + /api/model/options) |
| /api/settings | lead | config surface |

Request/response conventions:
- JSON everywhere; errors = {error: "..."} with proper status (400/401/404/500)
- /api/fs, /api/git, /api/term all accept ?ws=<workspaceId>; server keeps workspace registry
  {id → absolutepath} created via /api/settings or session.workdir. NEVER trust raw paths from
  browser: resolve against registered workspace root and reject traversal (testing gate).
- Long ops (run creation, whisper, git) must not block the event loop (use child_process,
  streams); SSE responses must emit `: keepalive` stamp every ≤15s.

## Server-side module register hook
Each module ships `server/modules/<name>_routes.js` exporting `register(app)` where `app` is a
tiny router object passed by server.js with methods:
`app.get(pattern, auth'd handler)`, `app.post`, `app.sse(pattern, handler)`.
Handlers: `(req, res, ctx)` where `ctx = {hermes (hermes_client), workspaces, config, log}`.
server.js scans `server/modules/*.js` — a module that fails to load logs loudly and is skipped,
never crashes the server (by design for parallel subagent dev).
