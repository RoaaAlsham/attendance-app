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
- ⬜ Phase 5 — Lecturer flow (pages)
- ⬜ Phase 6 — Student flow (pages)
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
| POST | `/api/courses` | lecturer | stub (auth-checked, 501 body) |
| GET | `/api/courses` | session | stub (auth-checked, 501 body) |
| POST | `/api/sessions` | lecturer | stub |
| GET | `/api/sessions/:id` | session | stub (auth-checked, 501 body) |
| POST | `/api/sessions/:id/end` | lecturer | stub |
| GET | `/api/sessions/:id/attendance` | lecturer | stub |
| POST | `/api/attend` | student | stub |

Bindings (D1, and later KV/DO) are read directly via
`import { env } from "cloudflare:workers"` inside route handlers — no
wrapper/adapter layer, since vinext exposes bindings natively in both dev
and production.

"Auth-checked" stubs sit behind `src/middleware.ts`'s matcher, so an
unauthenticated/wrong-role request never reaches the `501` body — it's
rejected with `401`/`403` first. `/api/sessions` (POST) and `/api/attend`
aren't in the matcher yet (their auth requirements are implemented alongside
their real logic in Phases 4–6), so they currently return `501` regardless
of auth state.

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
401 post-logout. Added `/api/me` to the matcher to satisfy that; `/api/sessions`
(POST) and `/api/attend` stay unmatched until Phases 4–6 give them real
logic.

**Known non-blocking notice:** the dev server logs `The "middleware" file
convention is deprecated. Please use "proxy" instead` (Next.js 16 renamed
`middleware.ts` → `proxy.ts`, same export shape). Functionality is
unaffected; a future cleanup could rename the file and adjust the export
name if the project moves to embrace that convention.

### Verified manually against `npm run dev`

- Signup → login → `GET /api/me` round-trip (as both a lecturer and a
  student), including rejecting a duplicate signup email with `409` and a
  wrong password with `401`.
- `POST /api/courses` as a student → `403`; as a lecturer → passes auth,
  reaches the `501` stub.
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
- **`reason: "expired"` is real but rarely observed in practice**: it exists
  in `handleValidate` for a token whose `tokenExpiresAt` has passed but the
  alarm hasn't rotated it out yet. Because the same 10s alarm that expires a
  token is also what replaces it, in normal operation a stale token almost
  always reads as `"mismatched token"` (compared against the token that
  already replaced it) rather than `"expired"` — the "current token exists,
  is stale, but not yet superseded" window is a race that this design
  doesn't need to widen. Either reason correctly rejects the scan, which is
  what the acceptance criteria call for.
- Verification used a temporary debug endpoint on the DO
  (`.../debug-state`, returning the raw stored state) and two throwaway
  route files under `src/app/api/dev-test-*` to reach it from outside the
  Workers runtime — both were removed after testing; they aren't part of
  the shipped code.
- After the `src/` reorganization, re-ran the same checks (`/api/health`,
  404 handling, the WS handshake returning `101`) to confirm nothing broke.

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
