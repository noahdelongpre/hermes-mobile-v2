# TESTING.md — Production-readiness test plan

Definition of done = every gate below passes on the dev instance AND the final BlackBox
container. Suite is executable, not aspirational: scripts live in `tests/` and are run by the
lead before any card moves to Review.

## Test pyramid
1. **Static gates (every PR/subagent result)**
   - `node --check` on every .js file (subagent runs it, lead re-runs)
   - No `require()` of any non-builtin module (grep for require against known builtins list)
   - No browser→Hermes direct URL (grep for `8642` in public/)
   - HTML pages parse (python html.parser smoke test)
2. **Unit-ish suite (`tests/run_units.js`, stock Node)**
   - diff renderer: known LCS cases + fuzz 200 random pairs (no throw, valid output)
   - markdown mini-renderer: fenced code, tables, inline, XSS-escape passthrough (script tags stripped)
   - fuzzy matcher, session store serialize/deserialize, attachment cleanup rule
3. **Server API contract tests (`tests/run_api.js`)** — boots server on ephemeral port with
   HERMES mocked by a local stub upstream, hits every route in INTEGRATION.md §3 and asserts:
   auth required (401 without basic auth), 400 on malformed, correct proxying, upload limits
   (reject >20MB), path-traversal defense on /api/fs (reject `..`, absolute escapes),
   git/fs/term route isolation per workspace context.
4. **E2E against REAL Hermes (`tests/run_e2e.js`)**
   - create session → run a trivial prompt with streaming; assert run_id, streamed content,
     usage tokens present
   - file write via /api/fs then read-back matches
   - git: init a temp repo, stage/commit via routes, assert commit hash returned
   - terminal exec: `echo`, cwd persistence
   - kanban: donetick stub round-trip
   - approval flow: mock approval-needed event → decision POST → run resumes (stub validates)
5. **Device-correct rendering — Samsung S24 Ultra (Playwright)**
   - Automated: `tests/visual/s24ultra.js <url> [label]` — emulates the S24 Ultra profile
     (384x832 CSS @ DPR 3 = 1152x2496 physical, `--dpr 2.5` for a phone set to FHD+ mode),
     plus a landscape spot-check. Asserts: no horizontal overflow in either orientation,
     touch targets >=44 CSS px, no text <12px, no pure-white backgrounds (dark UI only),
     bottom-nav doesn't cover buttons, and PWA viewport/manifest/theme-color metas present.
   - Golden screenshots land in `tests/visual/shots/`; used for before/after pixel diffs on
     refactors.
   - Runs against every page in the app (each tab + empty/streaming/tool-card/approval states)
     before any card moves to Review, and again against the final BlackBox container.
   - Playwright is a DEV-ONLY dependency (tests/visual/ has its own package.json); the app
     itself stays zero-npm.
6. **Resilience / burn-in**
   - Hermes down: app shows offline banner, reconnects gracefully
   - SSE disconnect/reconnect cycle ×20: no duplicate messages (idempotent event keys)
   - 24h idle then resume: drafts restore, session resumable
7. **Security gates**
   - basic auth rejects timing attack pattern, no secrets in localStorage, path escapes blocked
   - attachments stored outside webroot or content-type-sniffed before serve
8. **Deploy parity gate (BlackBox)**
   - docker build with zero network fetches beyond apt/base image (verify Dockerfile), then full
     suite `run_e2e.js` version from Pi against live Hermes with HERMES_URL rewritten to LAN IP.

## Sign-off ritual
Lead runs 1–4 + 6 automated, records output to `tests/results.txt`. Then shows user the
browser-smoke on their phone. Only after explicit user sign-off → cutover to BlackBox.

## Regression hygiene
Any bug found post-signoff = add a case to the matching suite file before fix lands.
