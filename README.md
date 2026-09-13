# Attendance App

A QR-code-based lecture attendance system. A lecturer starts a session and
projects a QR code that rotates every ~10 seconds; students scan it with
their phone to check in. Built on Next.js (App Router) running on Cloudflare
Workers via [vinext](https://vinext.dev/), with D1 for storage and a Durable
Object driving the rotating token / live attendance feed.

See `attendance-app-implementation-plan-v2.md` (git-ignored, local only) for
the full phased implementation plan this project follows. v2 supersedes the
original plan, revising Phase 3's session design (see below).

## Project structure

Follows Next.js's standard `src/` convention (vinext auto-detects `src/app`
when there's no root-level `app/`), matching the plan's target layout:

```
attendance-app/
  worker/index.ts            # custom Workers entry: exports the DO, intercepts /ws
  wrangler.jsonc
  migrations/
  src/
    app/                     # pages + Route Handlers (Next.js App Router)
    lib/                     # session.ts, password.ts
    durable-objects/         # lecture-session.ts
    middleware.ts
```

`worker/` stays at the repo root, alongside `wrangler.jsonc` and
`vite.config.ts` — it's a Cloudflare Workers entry point, not a Next.js
convention-bound file, so there's no reason to nest it under `src/`.

## Stack

- **Next.js (App Router)** served through **vinext**, Cloudflare's Vite
  plugin that reimplements the Next.js API surface directly on workerd —
  no Node.js server, no separate build-then-adapt step.
- **D1** (SQLite at the edge) for relational data: users, courses, sessions,
  attendance records.
- **Durable Objects** — one `LectureSession` DO per lecture session, rotating
  the QR token and driving the live WebSocket feed to the projector/dashboard.
- **Wrangler** for local dev bindings, migrations, and deployment.
- **`qrcode`** (client-side) renders the rotating QR on the projector page.

## Project status

- ✅ **Phase 0 — Environment setup**: project scaffolded with vinext,
  Cloudflare Workers as the deploy target, D1 bound (`DB`), `wrangler dev`
  runs cleanly.
- ✅ **Phase 1 — Data model & D1 schema**: schema migrated locally.
- ✅ **Phase 2 — Next.js app scaffold & routing**: every API endpoint exists
  as a Route Handler.
- ✅ **Phase 3 — Authentication**: opaque, DB-backed session tokens with
  real revocation (this phase — see below).
- ✅ **Phase 4 — Durable Object + custom worker**: `LectureSession` DO
  rotates a QR token every ~10s over a WebSocket, with token validation and
  attendance-notify broadcasting (this phase — see below).
- ✅ **Phase 5 — Lecturer flow (pages)**: login, dashboard (course +
  session creation), and the live projector page (this phase — see below).
- ✅ **Phase 6 — Student flow (pages)**: the `/attend` page and
  `POST /api/attend` (this phase — see below).
- ⬜ Phase 7 — Anti-fraud checks
- ⬜ Phase 8 — Testing & deployment

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` runs the vinext dev server on top of Miniflare/workerd, so D1
and (later) Durable Object bindings are live from the very first request —
there's no separate "UI-only" dev mode to worry about.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the vinext dev server (local workerd runtime, bindings live). |
| `npm run build` | Build the Cloudflare Worker output. |
| `npm run start` | Run the built Worker locally via Wrangler. |
| `npm run deploy` | Deploy to Cloudflare Workers. |

## Data model

Defined in [migrations/0001_init.sql](migrations/0001_init.sql) and
[migrations/0002_auth_sessions.sql](migrations/0002_auth_sessions.sql),
applied with Wrangler's D1 migration tooling.

| Table | Purpose |
|---|---|
| `users` | Lecturers and students. `role` is constrained to `student` \| `lecturer`. |
| `courses` | Owned by a lecturer (`lecturer_id`). |
| `sessions` | One lecture session for a course; optionally carries room coordinates (`room_lat`/`room_lng`) and a check-in radius (`radius_m`) for the Phase 7 geofence check. |
| `attendance` | One row per student check-in. `UNIQUE(session_id, user_id)` enforces "one scan per student per session" at the database level. |
| `auth_sessions` | One row per active login (Phase 3). Primary key is a SHA-256 hash of the opaque session token, never the token itself — same reasoning as `password_hash`. Named separately from `sessions` (lecture sessions) to avoid confusion. |

### Working with migrations

```bash
# apply all pending migrations to the local D1 instance
npx wrangler d1 migrations apply attendance --local

# same, against the remote (production) database — do this in Phase 8
npx wrangler d1 migrations apply attendance --remote

# run an ad-hoc query against the local DB
npx wrangler d1 execute attendance --local --command "SELECT * FROM users"
```

Add new schema changes as a new `migrations/000N_description.sql` file —
never edit an already-applied migration file.

### Seed data

[scripts/seed.sql](scripts/seed.sql) inserts one lecturer and one student for
local testing:

```bash
npx wrangler d1 execute attendance --local --file=./scripts/seed.sql
```

Their `password_hash` values are placeholders (`'placeholder-hash'`), not
real PBKDF2 hashes — they won't pass `POST /api/auth/login`. Sign up through
the API instead to get a working test account, or re-seed with a real hash
produced by `hashPassword()` from [src/lib/password.ts](src/lib/password.ts).

| Role | Email | id |
|---|---|---|
| lecturer | lecturer@example.com | `11111111-1111-1111-1111-111111111111` |
| student | student@example.com | `22222222-2222-2222-2222-222222222222` |

### Verifying the schema

```bash
# list tables
npx wrangler d1 execute attendance --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'"
```

A duplicate `(session_id, user_id)` insert into `attendance` is rejected with
`UNIQUE constraint failed` — this has been verified manually and is the
invariant later phases (the `/api/attend` route) rely on to detect
"already scanned" instead of racing on application logic.

## API routes

Every endpoint from the plan exists as a Route Handler under `src/app/api/`.
There is deliberately no route for the WebSocket channel
(`/api/sessions/:id/ws`); it's handled by the custom worker entry
(`worker/index.ts`) added in Phase 4, which intercepts it before the request
reaches Next.js routing — see below.

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/api/health` | none | ✅ runs `SELECT 1` against `env.DB` as a binding smoke test |
| POST | `/api/auth/signup` | none | ✅ implemented |
| POST | `/api/auth/login` | none | ✅ implemented |
| POST | `/api/auth/logout` | session | ✅ implemented |
| GET | `/api/me` | session | ✅ implemented |
| POST | `/api/courses` | lecturer | ✅ implemented |
| GET | `/api/courses` | session | ✅ implemented (own courses only — see below) |
| POST | `/api/sessions` | lecturer | ✅ implemented |
| GET | `/api/sessions/:id` | session | ✅ implemented |
| POST | `/api/sessions/:id/end` | lecturer | ✅ implemented |
| GET | `/api/sessions/:id/attendance` | lecturer | ✅ implemented |
| POST | `/api/attend` | student | ✅ implemented |

Every Route Handler from the plan is now implemented — nothing left is a
`501` stub. Bindings (D1, and later KV/DO) are read directly via
`import { env } from "cloudflare:workers"` inside route handlers — no
wrapper/adapter layer, since vinext exposes bindings natively in both dev
and production.

Every route above sits behind `src/middleware.ts`'s matcher, so an
unauthenticated/wrong-role request never reaches the handler body — it's
rejected with `401`/`403` first.

## Authentication (Phase 3)

Sessions are **opaque, DB-backed tokens**, not JWTs — see
`attendance-app-implementation-plan-v2.md` for the full rationale. In short:
a JWT is self-verifying and can't be revoked early short of a blocklist; an
opaque token is a random string that's meaningless without a matching row in
`auth_sessions`, so logging out deletes that row and the token is dead
everywhere it exists, immediately — not just in the browser that logged out.

- **`src/lib/password.ts`** — `hashPassword`/`verifyPassword` using
  `crypto.subtle` PBKDF2 (100,000 iterations, SHA-256, random 16-byte salt
  per user). No npm `bcrypt`, since it needs Node natives unavailable in the
  Workers runtime.
- **`src/lib/session.ts`** — `createSession`, `verifySession`, `revokeSession`,
  `revokeAllSessionsForUser`. Tokens are 32 random bytes (base64url-encoded);
  only a SHA-256 hash of the token is ever stored, in the `auth_sessions`
  table added by [migrations/0002_auth_sessions.sql](migrations/0002_auth_sessions.sql).
  Sessions last 7 days and are checked (and lazily purged if expired) on
  every use — nothing is embedded in the token itself, so a role change
  takes effect on the user's very next request.
- **`src/middleware.ts`** — looks up the session cookie against D1 on every
  matched request, then forwards the verified identity to route handlers via
  `x-user-id`/`x-user-role` request headers (middleware can't hand a JS
  object to a Route Handler directly).
- Cookie: `session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`. Because
  of `Secure`, the cookie won't be *set* by a real browser talking to the dev
  server over plain `http://localhost` — this only affects manual browser
  testing, not curl (which ignores `Secure`) or a deployed (`https://`)
  instance. Switch to a real browser test once TLS is in place, or drop
  `Secure` locally if you need to click through the flow in dev before then.

### A note on project layout history

Phases 3–4 originally placed `lib/`, `middleware.ts`, and `durable-objects/`
at the repo root, because at the time `app/` also lived at the root (not
`src/app/`) and Next.js requires `middleware.ts` to sit beside wherever
`app/` actually is. The project was later reorganized to move `app/` under
`src/app/` too — matching both the plan's diagram and Next.js's standard
`src/` convention — which let `lib/`, `middleware.ts`, and `durable-objects/`
move under `src/` as originally intended. vinext auto-detects `src/app`
(falling back to a root-level `app/` only if `src/app` doesn't exist), so no
framework configuration changed; the `@/*` tsconfig path alias was
repointed from `./*` to `./src/*` so `@/lib/session`-style imports keep
resolving. Re-verified end-to-end after the move (see below).

The plan's example `middleware.ts` matcher (`/api/courses`, `/api/sessions`,
`/dashboard`) omits `/api/me`, even though the API contract marks it
session-protected and Phase 3's acceptance criteria requires it to return
401 post-logout. Added `/api/me` to the matcher to satisfy that.

The plan's example `isLecturerOnly()` also only covers `/dashboard` and
`POST /api/courses` — too narrow once Phase 5 gave `POST /api/sessions`,
`POST /api/sessions/:id/end`, and `GET /api/sessions/:id/attendance` real
logic, since the API contract marks all three lecturer-only too. Extended
`isLecturerOnly()` to cover them by path-suffix + method (`GET /api/sessions/:id`
stays open to any authenticated session, matching the contract). Phase 6
added a symmetric `isStudentOnly()` (just `POST /api/attend`) and added
`/api/attend` to the matcher, so every route in the API contract table is
now both authenticated *and* role-checked at the edge, not just the ones
that happened to need it first.

**Known non-blocking notice:** the dev server logs `The "middleware" file
convention is deprecated. Please use "proxy" instead` (Next.js 16 renamed
`middleware.ts` → `proxy.ts`, same export shape). Functionality is
unaffected; a future cleanup could rename the file and adjust the export
name if the project moves to embrace that convention.

### Verified manually against `npm run dev`

- Signup → login → `GET /api/me` round-trip (as both a lecturer and a
  student), including rejecting a duplicate signup email with `409` and a
  wrong password with `401`.
- `POST /api/courses` as a student → `403`; as a lecturer → passes auth (at
  the time, reached the `501` stub — now creates a real course, see Phase 5).
- `GET /api/me` with no cookie → `401`.
- **Revocation:** captured a student's raw session cookie value, logged out,
  then replayed a request using that *exact* captured token directly (not
  just "the browser cookie is gone") — got `401`. Confirmed the row was
  actually deleted from `auth_sessions` (JWTs can't do this: the token stays
  valid until it expires, no matter what the server does).
- Manually back-dated an `auth_sessions.expires_at` to the past — the next
  request with that cookie got `401`, and the row was purged from the table
  as a side effect of that lookup (lazy cleanup, as designed).

## Real-time layer (Phase 4)

One `LectureSession` Durable Object instance exists per lecture session
(addressed by `env.SESSION.idFromName(sessionId)`), holding the current QR
token in its own storage — not D1, since it's short-lived, high-churn, and
scoped to a single active session.

- **`src/durable-objects/lecture-session.ts`** — the `LectureSession` class,
  extending `DurableObject` from `cloudflare:workers`:
  - `alarm()` rotates the token (`crypto.randomUUID()`) every 10 seconds,
    persists `{ token, tokenExpiresAt }` via `this.ctx.storage`, reschedules
    itself, and broadcasts `{ type: "qr", token }` to every WebSocket tagged
    `projector`.
  - `fetch()` handles three cases on one Durable Object, distinguished by
    path suffix (see "A routing detail" below): `GET .../ws?role=projector|lecturer`
    upgrades the connection via the WebSocket Hibernation API
    (`this.ctx.acceptWebSocket(server, [role])`, tagged by role so broadcasts
    can target one audience); `POST .../validate` checks a submitted token
    against the current one, returning `{ valid, reason? }`; `POST .../notify`
    broadcasts `{ type: "attendance", studentName }` to `lecturer`-tagged
    sockets only.
- **`worker/index.ts`** — the custom Workers entry point now pointed at by
  `wrangler.jsonc`'s `main` (previously `vinext/server/fetch-handler`).
  It exports the `LectureSession` class (required for Wrangler to discover
  it as a Durable Object) and intercepts only WebSocket-upgrade requests
  matching `/api/sessions/:id/ws`, forwarding them to that session's DO
  stub; every other request is delegated unchanged to
  `vinext/server/app-router-entry`, so all of Next.js's own routing
  (pages, Route Handlers, 404s) is unaffected.
- **`wrangler.jsonc`** — added the `durable_objects` binding (`SESSION` →
  `LectureSession`) and the required `migrations` entry
  (`new_sqlite_classes: ["LectureSession"]`) that registers the DO class
  with Wrangler's storage layer.

### A routing detail not spelled out in the plan

`worker/index.ts` forwards the *original* incoming request unchanged to the
DO stub — so inside `LectureSession.fetch()`, a WebSocket upgrade arrives
with the full external pathname (`/api/sessions/<id>/ws`), not a bare `/ws`.
Meanwhile, application code calling the DO directly for non-WS operations
(e.g. the future `/api/attend` route calling `.../validate`) can use any
synthetic same-origin URL it likes, since that request never leaves the
Workers runtime. The DO's path matching therefore checks
`pathname.endsWith("/ws")` / `.endsWith("/validate")` / `.endsWith("/notify")`
rather than exact equality, so it handles both call shapes correctly. Using
exact-match initially caused every WebSocket upgrade to fall through to the
DO's 404 branch — and because workerd can't cleanly turn a non-101 response
into a real HTTP reply for a connection that already sent `Upgrade:
websocket` headers, that surfaced as a raw connection reset ("empty reply
from server"), not an HTTP 404. Worth knowing if this ever regresses.

### Verified manually against `npm run dev`

- **WebSocket upgrade**: a raw HTTP handshake against
  `ws://localhost:3000/api/sessions/<id>/ws?role=projector` returns
  `101 Switching Protocols`, and connecting for real receives a `{"type":"qr","token":...}`
  message immediately, then a new one roughly every 10 seconds (observed 4
  rotations across the same connection).
- **Non-WS routing is unaffected**: `/api/health`, `/api/me` (401 with no
  cookie), and an unmapped path (404) all still resolve correctly through
  Next.js routing with the custom worker entry in place.
- **`/validate`**: fetched the DO's live in-memory token and validated it in
  the same fast round-trip — a matching token returns `{"valid":true}`; a
  wrong one returns `{"valid":false,"reason":"mismatched token"}`.
- **Role isolation**: a `role=lecturer` socket receives `/notify`'s
  `{"type":"attendance",...}` broadcast; a `role=projector` socket on the
  same session does not — confirming `getWebSockets(tag)` broadcasts are
  correctly scoped by role.
- **`reason: "expired"` was originally real but rarely observed in
  practice** (as first implemented here in Phase 4): it existed in
  `handleValidate` only for a token whose `tokenExpiresAt` had passed but
  the alarm hadn't rotated it out yet. Because the same 10s alarm that
  expires a token is also what replaces it, in normal operation a stale
  token almost always read as `"mismatched token"` (compared against the
  token that already replaced it) rather than `"expired"`. Phase 6 fixes
  this properly — see below — since its acceptance criteria specifically
  requires a reliable "expired, scan again" message.
- Verification used a temporary debug endpoint on the DO
  (`.../debug-state`, returning the raw stored state) and two throwaway
  route files under `src/app/api/dev-test-*` to reach it from outside the
  Workers runtime — both were removed after testing; they aren't part of
  the shipped code.
- After the `src/` reorganization, re-ran the same checks (`/api/health`,
  404 handling, the WS handshake returning `101`) to confirm nothing broke.

## Lecturer flow (Phase 5)

- **`src/app/api/courses/route.ts`** — `POST` creates a course owned by the
  caller (`lecturer_id` = `x-user-id`); `GET` lists courses where
  `lecturer_id` matches the caller. There's no student/course relationship
  in the schema (attendance is per-session, not per-enrollment), so for a
  student this naturally returns an empty list rather than needing special
  casing.
- **`src/app/api/sessions/route.ts`** (`POST`) — starts a session for a
  course, but only after confirming the course's `lecturer_id` matches the
  caller (`404`, not `403`, if it doesn't — avoids confirming *whether* a
  course id exists to a lecturer who doesn't own it). Accepts optional
  `roomLat`/`roomLng` (from the dashboard's geolocation capture) and
  defaults `radiusM` to 50, ready for Phase 7's geofence check.
- **`src/app/api/sessions/[id]/route.ts`** (`GET`) — session details
  joined with the course name/code, open to any authenticated session (not
  lecturer-only), since a student will eventually need this too.
- **`src/app/api/sessions/[id]/end/route.ts`** (`POST`) — sets `ended_at`,
  after checking the caller owns the session (`403` if not) and that it
  isn't already ended (`409` if so, rather than silently no-opping).
- **`src/app/api/sessions/[id]/attendance/route.ts`** (`GET`) — the scanned
  roster for a session (joined with `users` for names), same ownership
  check as `/end`. Used to pre-populate the projector page's attendance
  list on load/refresh, independent of the live WebSocket feed.
- **`src/middleware.ts`** — `isLecturerOnly()` extended (see "A note on
  project layout history" above) so the three lecturer-only routes above
  are actually rejected with `403` for a non-lecturer, not just whatever
  each handler happened to do.
- **`src/app/login/page.tsx`** — a small client-side form
  (`POST /api/auth/login`, redirect to `/dashboard` on success). Not called
  out by name in any phase's step list, but the plan's own project
  structure diagram lists `app/login/page.tsx`, and without it there's no
  way to reach `/dashboard` through a browser at all — `src/middleware.ts`
  redirects an unauthenticated request there.
- **`src/app/dashboard/page.tsx`** — client component. Loads the caller's
  courses (`GET /api/courses`) into a `<select>`; a "Capture room location"
  button calls `navigator.geolocation.getCurrentPosition`; submitting starts
  a session (`POST /api/sessions`) and redirects to
  `/sessions/:id/projector`. Also includes a compact inline "new course"
  form (`POST /api/courses`) — the plan has no dedicated course-management
  page anywhere, so without this the course `<select>` would stay
  permanently empty for a new lecturer with no way to fill it from the UI.
- **`src/app/sessions/[id]/projector/page.tsx`** — client component,
  `useParams()` for the session id. On mount, fetches session details and
  the existing attendance roster (so a reload doesn't lose state), then
  opens two WebSockets: `role=projector` re-renders the QR
  (`qrcode`'s `QRCode.toDataURL()`, encoding
  `<origin>/attend?session=<id>&token=<token>`) on every `qr` message;
  `role=lecturer` appends each `attendance` message's `studentName` to the
  visible list. "End session" calls `POST /api/sessions/:id/end`; both
  sockets are closed on unmount.

### Verified in an actual browser, not just curl

Per-route ownership/role enforcement was verified with curl first (a
second lecturer gets `403` trying to end or view attendance for a session
they don't own; a student gets `403` from all three lecturer-only session
routes; ending an already-ended session gets `409`). The pages themselves
needed a real browser — this environment has no display, so
`npx playwright install chromium` + a small driver script stood in for
manual click-through testing:

- Logged in as a lecturer, landed on `/dashboard`, confirmed a
  curl-created course appeared in the `<select>`.
- Clicked "Capture room location" (with a mocked Playwright geolocation
  permission) — coordinates appeared next to the button.
- Clicked "Start session" — redirected to `/sessions/:id/projector`, and a
  real QR `<img>` rendered (confirming `qrcode` works in the browser
  bundle, not just in Node).
- Triggered the Durable Object's `/notify` from outside (a temporary test
  route, removed after) while the projector page's `role=lecturer` socket
  was live — "Live Test Student" appeared in the attendance list and the
  counter incremented, with **no page reload**, confirming the WebSocket
  wiring actually works end-to-end in a browser, not just via `Monitor`'s
  raw WebSocket client (Phase 4's verification method).
- Left the page open for 11 seconds and confirmed the QR `<img>`'s
  `src` actually changed — the rotation is visible to a real client, not
  just observable over a raw socket.
- Checked `console --errors`-equivalent (`page.on("console")` filtered to
  `error`) after every step: none.
- One real gotcha hit and worked around: clicking the login button
  immediately after `page.goto()` submitted a plain HTML form POST instead
  of running the React `onSubmit` handler, because the page hadn't
  hydrated yet — vinext/Vite compiles routes on first request, so the
  first navigation can take several seconds before JS actually attaches.
  Fixed by waiting for network-idle plus a short buffer before the first
  interaction; not an app bug, a test-driver timing issue.

Test lecturer/student accounts, the test course, and its sessions were all
deleted from the local D1 database after verification (in dependency order:
`attendance` → `sessions` → `courses` → `auth_sessions` → `users`, since
foreign keys are enforced).

## Student flow (Phase 6)

- **`src/app/api/attend/route.ts`** — the last real endpoint in the API
  contract. In order: reject if the session doesn't exist (`404`) or has
  ended (`410`); call the session's DO `.../validate` with the submitted
  token; if invalid, return `422` with the DO's `reason` passed through
  (`"expired"` or `"mismatched token"`); attempt the `attendance` insert;
  catch a `UNIQUE constraint failed` specifically and return `409
  already_scanned` (anything else rethrows to a normal 500 — the plan only
  asks for the unique-constraint case to get special handling); on success,
  call `.../notify` with the student's name and return `201`. Also stores
  the optional `lat`/`lng` from the request body and `cf-connecting-ip` on
  the row, ready for Phase 7 to actually use them — Phase 6 captures, it
  doesn't yet enforce.
- **`src/middleware.ts`** — added `/api/attend` to the matcher and a new
  `isStudentOnly()` (mirroring `isLecturerOnly()`) so a lecturer hitting
  `/api/attend` gets `403`, not a confusing pass-through into student-only
  logic.
- **`src/app/attend/page.tsx`** + **`src/app/attend/attend-client.tsx`** —
  split into a server component wrapping a `"use client"` child in
  `<Suspense>`, because `useSearchParams()` requires a Suspense boundary in
  the App Router (an easy miss — Next.js only warns about it, doesn't
  error, so it's the kind of thing that looks fine in dev and then isn't).
  The client component reads `session`/`token` from the query string,
  optionally grabs `navigator.geolocation` (best-effort — check-in proceeds
  without it if denied or unavailable), `POST`s to `/api/attend`, and maps
  every response into one of: success, already recorded, invalid/expired
  (with reason-specific text), session ended, not logged in, wrong role
  (only students can check in), or missing scan details (no `session`/
  `token` in the URL at all — e.g. someone opened `/attend` directly).

### A real bug this phase's acceptance criteria caught: `reason: "expired"` wasn't reliable

Phase 6's acceptance criteria requires "an expired QR (wait >10s) gives an
explicit 'expired, scan again' message" — and testing that honestly (not
just checking the code path exists, but actually waiting out a real token
and scanning it) surfaced that Phase 4's `handleValidate` essentially never
returned `"expired"` in practice, for the reason described in the Phase 4
section above: by the time a token is >10s old, the alarm has already
rotated it out, so it reads as `"mismatched token"` against its successor
instead. Fixed by having `LectureSession` remember one generation of
`previousToken` and treating a match against it as `"expired"` (not
`"mismatched"`) regardless of the current token's own expiry — see
[src/durable-objects/lecture-session.ts](src/durable-objects/lecture-session.ts).
This only tracks one rotation back, so a token more than ~20s stale falls
back to the generic `"mismatched token"` reason — acceptable, since the
plan's test scenario is "wait >10s," not "wait an arbitrary amount," and
either reason correctly rejects the scan either way.

### Verified

curl, against a fresh session each time to avoid cross-test interference
(and a fast in-Workers debug endpoint on the DO to read its live token
without racing the 10s rotation from outside — see below):

- Fresh scan → `201`, row appears in `attendance` with the submitted
  `lat`/`lng`.
- Immediate repeat scan with the *same still-valid* token → `409
  already_scanned` (not a duplicate row, not a crash).
- A token, captured, then used again after actually waiting past its 10s
  TTL → `422` with `reason: "expired"` (reliably, after the fix above —
  confirmed on a fresh session after restarting the dev server, since
  Durable Object class changes don't hot-reload into already-running
  instances the same way Route Handlers do — the same thing Phase 4 first
  ran into).
- A garbage token → `422` with `reason: "mismatched token"`.
- A lecturer calling `/api/attend` → `403`. No session cookie at all →
  `401`. Missing `sessionId`/`token` in the body → `400`. A session id
  that doesn't exist → `404`. A scan against an ended session → `410`.

Then the actual page, in a real browser (Playwright, same approach as
Phase 5): logged in as a student, navigated to
`/attend?session=<id>&token=<token>` with a freshly-fetched valid token,
and confirmed each state renders correctly — screenshotted "You're checked
in", "Already recorded" (on a second visit), and "Missing scan details"
(visiting `/attend` with no query params). One test-harness gotcha: the
first attempt at capturing "already recorded" actually raced the 10s
rotation *inside the login flow itself* (logging in takes a few real
seconds), so by the time the page navigated the token had already expired
twice over — not an app bug, just confirming the same fast-round-trip
discipline from Phase 4/5 testing (fetch the token as late as possible,
immediately before the request that uses it) applies here too.

**Also fixed in passing:** `src/app/login/page.tsx` unconditionally
redirected to `/dashboard` after login, which is lecturer-only —
a student landed on a blank `403`. Login now reads the `role` from the
login response and redirects lecturers to `/dashboard`, students to `/`
(there's no student-specific landing page anywhere in the plan; `/` is a
neutral choice since students reach the app's real content by scanning a
QR, not by browsing to a dashboard). Caught only because Phase 6's browser
test actually logged in as a student for the first time in this project.

The temporary DO debug endpoint and its companion test route used to read
the live token fast (same pattern as Phase 4) were removed after testing;
all test accounts, courses, sessions, and attendance rows were deleted
from the local D1 database afterward.

## Configuration notes

- The D1 binding in `wrangler.jsonc` is named `DB` (matching `env.DB` used
  throughout the plan/codebase) — this was renamed from the scaffold
  default during Phase 1 for consistency with later phases.
- `wrangler.jsonc`'s `main` points at `worker/index.ts` (Phase 4), not the
  scaffold's `vinext/server/fetch-handler` — this is what lets the custom
  worker export the `LectureSession` Durable Object and intercept the
  WebSocket route. `vite.config.ts`'s `cloudflare()` plugin reads `main`
  from `wrangler.jsonc` automatically, so it needed no changes.
- Run `npx wrangler types` after any change to `wrangler.jsonc` bindings to
  keep `worker-configuration.d.ts`'s `Env` type in sync (needed again after
  adding the `SESSION` Durable Object binding).
- `tsconfig.json`'s `@/*` path alias points at `./src/*`, matching the
  `src/` layout — `@/lib/session` resolves to `src/lib/session.ts`.
