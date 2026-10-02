# Technical Decisions — Hermes Mobile v2
Log decisions here as they're made, newest at the bottom. Keep entries short.

## Empirically verified Hermes API shapes (2026-10-01, probe script server/probe_runs_api.js)
- POST /v1/runs body {"input": "..."} (messages[] is INVALID; optional "conversation", "model_options") → {run_id, status:"started", replayed}
- GET /v1/runs/{id} → {object:"hermes.run", status, output, usage:{"input_tokens","output_tokens","total_tokens"}, session_id, created_at, updated_at}
- GET /v1/runs/{id}/events → SSE, NO `event:` lines; type lives in the JSON payload field `event`:
  - `message.delta` {delta} · `reasoning.available` {text} · `run.completed` {output, usage, completed, partial, interrupted}
  - ends with comment line `: stream closed`
- GET /api/model/options → {providers:[{slug,name,is_current,authenticated,...}], model, provider}
- GET /v1/models exists; GET /health → {"status":"ok"} (no auth needed)
- GOTCHA (fixed in hermes_client.js): BASE must be slash-stripped before concatenating paths — "…:8642/" + "/health" produced "//health" = 404.
- GOTCHA: v1's .env sets HERMES_URL to a stale LAN IP (192.168.86.26); never import v1's .env wholesale — copy HERMES_KEY only.


## 2026-10-01
- Stack: plain HTML/vanilla JS/CSS + stock Node server, zero npm deps (deploy parity with v1 Pi container).
- External CDNs allowed: xterm.js, highlight.js, and nothing else.
- Trust model: no E2E QR-pairing relay features (Happy-style); basic auth + Tailscale is the trust boundary. Documented as non-goal in FEATURES.md.
Tracking: Hermes preview-pane Kanban (this repo's board.html). DoneTick is the
user's personal tracker — never create agent tasks there.
- Subagent split: A (chat/render), E (terminal), F (voice) first wave parallel; C (files), I (slash), J (attachments) second; D (git), H (kanban) third; B (sessions) + G (notifications/approvals) owned by lead because they need server design decisions and integration across modules.
