# INTEGRATION.md — How every feature fits together (seamlessness plan)

This is the connective-tissue plan above FEATURES.md's per-module specs. Everything here is
binding on all modules: when a card says "reuse shared components" in FEATURES.md, this file
says exactly which ones.

## 1. Single-app shell (not 10 mini-apps)
One SPA, one bottom-nav, five tabs: **Chat · Files · Git · Terminal · Board**. Voice, slash,
attachments, notifications are *layers inside Chat*, not separate screens. Terminal/Files/Git
are scoped to a **workspace context** chosen once (default = FS_ROOT from env).

## 2. The session is the spine
Everything hangs off the active session object created/owned by module B (sessions.js):
```
session = {
  id (run_id chain), title, created, status, model_choice,
  messages[], attachments[], active_workspace_path, // Files/Git/Terminal scope to this
  drafts, unseen_badge (fed by G), donetick_card_id (fed by H)
}
```
- **Chat (A)** renders `messages[]` and appends as SSE events land. Every other module *writes into the same timeline*: Files "save" → chat note card; Git "commit" → diff card in chat; Terminal commands re-run → output copied as user message context; Voice transcript → composer text.
- **Composer (one component, fed by many)** attachments (J), slash (I), STT (F), and @file mentions (C) all target the same input element owned by A.
- **Model/agent choice (I)** is a property of the session object, not global — matches how runs are created (model_options per run) and restores when resuming.
- **Fork/resume (B)** carries: full transcript + attachments path refs + workspace context. Fork-from-message = truncate copy + new run.

## 3. Server routes: one namespace, module-prefixed
All app routes live under `/api/…` on our Node server. Prefix per module so subagents never collide:
```
/api/session/*      (B: create, list, fork, rename, archive, delete)
/api/run/*          (chat + upstream Hermes proxy; only file allowed to touch Hermes /v1)
/api/fs/*           (C: list, read, write, search, mkdir, rm, mv)
/api/git/*          (D: status/diff/log/branch/stage/commit)
/api/term/*         (E: exec + optional PTY stream, per-session cwd)
/api/voice/*        (F: whisper STT endpoint, TTS passthrough)
/api/attach/*       (J: temp upload store, serve attachments)
/api/push/*         (G: VAPID subscribe)
/api/kanban/*       (H: donetick proxy)
/api/settings       (I+shell: FS_ROOT, feature toggles)
```
Hermes upstream touchpoints are hidden behind `/api/run/*` and `/api/session/*` only. Every
proxy call re-writes Hermes URLs to IP literals (Pi DNS death rule) — done in ONE helper
(server/hermes_client.js), never per-module.

## 4. Event flow: one SSE bus client-side
Chat subscribes once to Hermes run events via server (`/api/run/:id/events`, kept-alive by
server heartbeats). A lightweight `window.bus` (comm.js) broadcast model: `bus.emit('run:event',{type,payload})`
→ Chat renders, G updates badges, H updates card status if session was launched from a card.
Approvals (G) intercept the SAME event bus and surface the universal allow/deny card — no
module polls separately.

## 5. Shared UI kit (theme.css + ui.js)
- classes: `.card`, `.chip`, `.btn`, `.diff-add/sub`, `.toolcard`, `.sheet` (bottom sheet = the mobile modal idiom), tabs
- ui.js provides: `toast()`, `,confirmSheet()`, `fuzzyMatch()`, `md()` (mini markdown+highlight),
  `diffView()`, `toolCard()`. Using these instead of bespoke HTML keeps cohesion; subagents import, not re-implement.

## 6. Data flow for notifications (G) — design that avoids polling battles
Sequenced: G owns ONE long-lived per-run event connection on the server (not per-phone), shared
to all browser tabs via SSE fanout (`/api/push/stream`). Phone closed? Server富 Web Push via
VAPID. Three triggers: run completed, error, approval-needed (highest priority, overrides all).

## 7. Feature-to-feature contracts (the "seam test")
| Creator | Consumer | Contract to verify |
|---|---|---|
| C files @-mention | composer autocomplete | chip inserted; sending converts to context |
| J attach upload | A renderer | attachment ids resolved in run payload; thumbnails render |
| F STT text | composer | fills draft, never auto-sends |
| I slash `/model` | I picker | doesn't add a user message to timeline |
| D commit card | A diff renderer | reuse diffView; link opens file in C |
| H card "assign" | B new session + launch | run started; H live-updates from run bus |
| B session switch | all modules | terminal cwd + git repo + file tree re-scope instantly |
| G approval event | A inline card | push notif taps → opens the exact session (deep link `?s=<id>`) |
| E terminal exit | composer | offer "send output as context" strip |

## 8. Non-functional seams
- All requests server-side with basic-auth→; server→Hermes over LAN with HERMES_KEY (secret never in browser localStorage).
- Zero-npm constraint respected; only CDN: xterm.js, highlight.js, (optionally marked.js source file vendored locally).
- Mobile-first responsive; touch targets ≥44px; dark theme single source (CSS vars).
- No direct browser→Hermes traffic ever (Pi DNS-death rule encapsulated in hermes_client.js).
- All modules must work without notifications/push; notifications are additive (progressive enhancement).
